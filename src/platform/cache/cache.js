/**
 * The cache.
 *
 * A namespaced `get`/`set`/`invalidatePrefix` wrapper over **two tiers**:
 *
 *   - an in-process `Map`, used by every namespace, and
 *   - MySQL rows, used by the namespaces listed in `CACHE_DURABLE_NAMESPACES`.
 *
 * ## Why two tiers, and why the second one is MySQL
 *
 * M02 originally used Redis for both. Redis is not in this deployment, so the
 * shared tier is the database the application already requires — a replica that
 * can answer a request can read a shared entry.
 *
 * The split is by namespace, not by value, because the two tiers answer different
 * questions:
 *
 *   - **Cache correctness** — a stale dashboard aggregate for 30 seconds is a
 *     performance fact. Nothing breaks. Memory is enough, and a `SELECT` per
 *     request is not worth paying for.
 *   - **Credential correctness** — an OTP code and a password reset token are
 *     not cache, they are single-use secrets with a TTL. Under N replicas a
 *     process-local one makes registration and password reset fail at random,
 *     roughly N-1 times out of N, with `OTP_INVALID` — an error message that
 *     blames the user for a deployment decision. Those namespaces are durable.
 *
 * Durable namespaces skip the in-memory tier entirely rather than layering it in
 * front. A value written on replica A and read on B must not be satisfiable from
 * B's stale copy: with a two-tier read you get cross-replica staleness in exactly
 * the place staleness is not allowed, and the only defence is a write-through
 * invalidation that has no way to reach another process. Skipping L1 costs one
 * indexed `SELECT` on a low-volume path (registration, forgot-password) and
 * removes the whole class of bug.
 *
 * ## Fail-open in both directions
 *
 * A cache miss is always safe and a cache that cannot be written is always safe,
 * so neither tier has an error path a caller has to handle. The durable tier
 * swallows its own failures — see `durable.js`. Nothing here can reject in a way
 * that turns a cache problem into a 500.
 */
const config = require("../../config");
const durable = require("./durable");

/**
 * Marks a value as written by `remember`. A property rather than a class so it
 * survives any future serialisation round-trip, and obscure enough that a
 * producer returning an object with a `value` key does not collide.
 */
const ENVELOPE = "__amakenCached";

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const memory = new Map();

/** Counters for the cache's own health. Exposed via {@link stats}. */
let hits = 0;
let misses = 0;

/**
 * Drops expired entries from the in-memory tier.
 *
 * **Lazy, on access, not on a timer.** A background interval holds the event
 * loop alive, which would block `process.exit` at the end of a drain — the
 * graceful-shutdown contract in `server.js` would silently stop working because of
 * a cache. Reading the map also means the map only grows as fast as it is used.
 *
 * The durable tier expires the same way, on read, in `durable.js`.
 *
 * @param {number} [now]
 */
function sweep(now = Date.now()) {
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}

/**
 * The fully-qualified key for a namespace and key.
 *
 * Two levels of scoping, both load-bearing. The app prefix keeps this
 * application's entries distinguishable from anything else in the same process
 * (a second app instance in a test, the durable tier shared with another
 * environment), and the namespace segment is what makes {@link invalidatePrefix}
 * and {@link invalidateNamespace} able to clear one logical group without touching
 * another. Without the namespace, invalidating a stale property listing would
 * also invalidate a live OTP.
 *
 * @param {string} namespace logical group, e.g. `"property"`
 * @param {string} key
 * @returns {string}
 */
function qualify(namespace, key) {
  const ns = String(namespace || "default").replace(/[^a-zA-Z0-9:_-]/g, "");
  return `${config.cache.prefix}cache:${ns}:${key}`;
}

/**
 * Reads a cached value.
 *
 * @param {string} namespace
 * @param {string} key
 * @returns {Promise<unknown|null>} the value, or `null` on a miss. `undefined` is
 *   never returned, so callers have exactly one miss value to check.
 */
async function get(namespace, key) {
  if (durable.isDurable(namespace)) {
    const value = await durable.read(qualify(namespace, key));
    if (value === null) {
      misses += 1;
    } else {
      hits += 1;
    }
    return value;
  }

  sweep();

  const qualified = qualify(namespace, key);
  const entry = memory.get(qualified);
  if (!entry || entry.expiresAt <= Date.now()) {
    memory.delete(qualified);
    misses += 1;
    return null;
  }

  hits += 1;
  return entry.value;
}

/**
 * Writes a cached value.
 *
 * Async because the durable tier is a database write, and every call site awaits
 * it. A non-durable namespace never touches MySQL.
 *
 * A value of `undefined` is stored as `null` — "do not cache" — so `get` returns
 * a miss and the caller recomputes. Storing `undefined` directly would make a
 * later `JSON.stringify` throw, which is the failure mode this avoids.
 *
 * @param {string} namespace
 * @param {string} key
 * @param {unknown} value
 * @param {number} [ttlSeconds] defaults to `config.cache.ttlSeconds`
 * @returns {Promise<boolean>} `true` when the next `get` from this process will
 *   read the value back. `false` means a durable namespace's row did not write —
 *   the caller can tell a degraded write from a clean one. Nothing is ever
 *   reported as stored when it was not: see the note in `durable.js` on why a
 *   failed durable write is **not** backfilled into memory.
 */
async function set(namespace, key, value, ttlSeconds = config.cache.ttlSeconds) {
  const stored = value === undefined ? null : value;

  if (durable.isDurable(namespace)) {
    // No in-memory copy. Deliberate — see the module note on skipping L1 for
    // durable namespaces.
    return durable.write(qualify(namespace, key), stored, ttlSeconds);
  }

  memory.set(qualify(namespace, key), {
    value: stored,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  return true;
}

/**
 * Deletes every key under a prefix.
 *
 * The argument is the **suffix** of a qualified key — `"cache:property:"` for
 * `qualify("property", …)`. That is the part after `config.cache.prefix`, which
 * this function prepends itself, so a caller cannot construct a pattern that
 * reaches outside this application.
 *
 * Both tiers are swept. Leaving a durable row behind while clearing its
 * in-memory copy is the "invalidated but still served" bug, and it is worse than
 * the reverse: the value looks gone in one process and alive in every other.
 *
 * Prefer {@link invalidateNamespace} at a call site.
 *
 * @param {string} prefix
 * @returns {Promise<number>} how many in-memory keys were removed. The durable
 *   sweep happens on every call, including for namespaces with no durable rows.
 */
async function invalidatePrefix(prefix) {
  const target = `${config.cache.prefix}${prefix}`;
  let removed = 0;

  for (const key of memory.keys()) {
    if (key.startsWith(target)) {
      memory.delete(key);
      removed += 1;
    }
  }

  await durable.removePrefix(prefix);

  return removed;
}

/**
 * Deletes every key in one namespace.
 *
 * The call-site form of {@link invalidatePrefix}, and what most invalidation
 * actually needs. Derives the prefix from {@link qualify} so the two can never
 * disagree about the key layout.
 *
 * @param {string} namespace
 * @returns {Promise<number>}
 */
function invalidateNamespace(namespace) {
  const ns = String(namespace || "default").replace(/[^a-zA-Z0-9:_-]/g, "");
  return invalidatePrefix(`cache:${ns}:`);
}

/**
 * Deletes one key.
 *
 * @param {string} namespace
 * @param {string} key
 * @returns {Promise<boolean>} whether the entry is gone afterwards. For a durable
 *   namespace that is "the row was removed", not "a row existed" — the caller
 *   cannot tell whether anything was there and does not need to.
 */
async function del(namespace, key) {
  const qualified = qualify(namespace, key);
  const removedFromMemory = memory.delete(qualified);

  if (durable.isDurable(namespace)) {
    return durable.remove(qualified);
  }

  return removedFromMemory;
}

/**
 * Read-through helper — the shape the M06 dashboard cache will use.
 *
 * Wraps the stored value in an envelope so a **cached `null` is a hit**. Without
 * it, `get`'s "null means miss" contract makes an empty result
 * indistinguishable from no result and the producer runs on every request —
 * which is the specific thing caching an empty list was supposed to prevent. A
 * producer returning `undefined` is the one value that is *not* cached; it is
 * almost always a bug, and silently caching "undefined" would hide it for the
 * whole TTL.
 *
 * The envelope is only applied to the in-memory tier. Durable namespaces do not
 * need it — they round-trip a JSON `null` faithfully — and writing the marker
 * would leak an implementation detail into a shared table.
 *
 * @template T
 * @param {string} namespace
 * @param {string} key
 * @param {() => Promise<T>} producer runs only on a miss. Must be cheap enough
 *   that a cold cache is not a thundering herd — there is no request coalescing
 *   here, so N concurrent misses run N queries.
 * @param {number} [ttlSeconds]
 * @returns {Promise<T>}
 */
async function remember(namespace, key, producer, ttlSeconds = config.cache.ttlSeconds) {
  const cached = await get(namespace, key);

  if (cached !== null && cached !== undefined) {
    if (typeof cached === "object" && cached !== null && ENVELOPE in cached) {
      return /** @type {T} */ (cached[ENVELOPE]);
    }
    // A value written by a bare `set`, not by `remember`. Honour it rather than
    // re-running the producer; the two entry points must interoperate.
    return /** @type {T} */ (cached);
  }

  const fresh = await producer();

  if (fresh !== undefined) {
    if (durable.isDurable(namespace)) {
      await set(namespace, key, fresh, ttlSeconds);
    } else {
      await set(namespace, key, { [ENVELOPE]: fresh }, ttlSeconds);
    }
  }

  return fresh;
}

/**
 * Empties the in-memory tier and resets the counters.
 *
 * The test seam, and it is **not** a flush: `clear()` deliberately touches
 * nothing durable, so a test that calls it can still exercise the durable path
 * against real rows. Use {@link clearDurable} for that.
 *
 * @returns {void}
 */
function clear() {
  memory.clear();
  hits = 0;
  misses = 0;
}

/**
 * Empties the durable tier for this application. The test seam — no production
 * caller.
 *
 * @returns {Promise<number>} rows removed.
 */
async function clearDurable() {
  durable.resetFailureLatch();
  return durable.clear();
}

/**
 * Snapshot counters.
 *
 * @returns {{ hits: number, misses: number, entries: number, durableNamespaces: string[] }}
 */
function stats() {
  return {
    hits,
    misses,
    entries: memory.size,
    durableNamespaces: [...durable.DURABLE_NAMESPACES],
  };
}

/**
 * Whether a namespace lives in the durable tier.
 *
 * Re-exported from `durable.js` rather than re-derived here, so there is exactly one
 * definition of the set. Two copies of that list is how a namespace ends up durable
 * in the writer and in-memory in the reader.
 *
 * @param {string} namespace
 * @returns {boolean}
 */
const isDurable = durable.isDurable;

module.exports = {
  get,
  set,
  del,
  invalidatePrefix,
  invalidateNamespace,
  remember,
  qualify,
  isDurable,
  stats,
  clear,
  clearDurable,
};