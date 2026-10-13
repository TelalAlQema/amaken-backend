/**
 * The durable tier of the cache.
 *
 * MySQL rows in the `kv_entries` table, and the reason `platform/cache` has two
 * tiers rather than one.
 *
 * ## Why this exists when Redis does not
 *
 * The cache started as an in-process `Map`, which is fine for a cache and fatal
 * for an OTP. `services/auth.service.js` stores registration codes and password
 * reset tokens under the `otp` namespace; under two replicas, one that cannot
 * read the other's entry fails roughly half of all registrations and password
 * resets — with `OTP_INVALID`, which looks like a user error and is not one.
 * Redis solved that by being a shared store every replica could reach.
 *
 * Redis is not in this deployment, so the shared store is MySQL: the one
 * dependency the API already cannot answer a request without. A replica that
 * can reach the database can reach an OTP.
 *
 * ## Only some namespaces are durable
 *
 * `CACHE_DURABLE_NAMESPACES` (default: `otp`) decides which values land here.
 * Everything else stays in the in-memory tier, where a copy another replica
 * cannot see is a performance fact rather than a bug.
 *
 * The alternative — writing every namespace here — would put a `SELECT` on the
 * request path for a dashboard aggregate that is stale for at most
 * `CACHE_TTL_SECONDS` either way, and would make the cache's type contract
 * lossy, because values round-trip through JSON (see {@link encode}).
 *
 * ## Errors are contained, never propagated
 *
 * Every method here returns `null`/`false` on failure rather than throwing. A
 * durable tier that can reject turns a cache miss into a 500, which is the exact
 * inversion fail-open exists to prevent: a slower database is fine, an errored
 * request is not.
 *
 * Note what fail-open does **not** do here: it does not fall back to writing the
 * value in memory. A durable namespace has no in-memory copy by design — see
 * `cache.js` — so a failed write leaves the OTP unstored, and `verifyOtp` reports
 * `OTP_INVALID`. That is the correct outcome. The alternative, quietly serving from
 * a per-process copy, reintroduces the exact cross-replica bug this tier exists to
 * remove, and it fails *silently* on the replica that wrote it while failing loudly
 * on the ones that did not. A loud failure on every replica beats a correct answer
 * on one of them.
 */
const config = require("../../config");
const { prisma } = require("../db/prisma");
const { encodeJson, decodeJson } = require("../serialize");
const { getLogger } = require("../../core/logger");

/** Set when a write fails, so a broken durable tier is reported once per scrape. */
let degradedSince = 0;

/**
 * Namespaces whose values are written to MySQL as well as memory.
 *
 * A `Set` built once: `isDurable` runs on every cache operation, and it is on
 * the request path for OTP verification.
 */
const DURABLE_NAMESPACES = new Set(
  config.cache.durableNamespaces.map((ns) => String(ns).trim().toLowerCase()).filter(Boolean)
);

/**
 * Whether a namespace is backed by the durable tier.
 *
 * Lower-cased for the same reason the set is: `qualify` sanitises but does not
 * fold case, and `"OTP"` and `"otp"` must not be two namespaces.
 *
 * @param {string} namespace
 * @returns {boolean}
 */
function isDurable(namespace) {
  return DURABLE_NAMESPACES.has(String(namespace || "default").toLowerCase());
}

/**
 * JSON-encodes a value for storage.
 *
 * Delegates to `platform/serialize` — shared with the job queue, which stores
 * payloads as text too. A `bigint` is encoded rather than thrown on: Prisma
 * returns one for `COUNT(*)` and for `Int` columns wider than 32 bits, so a
 * dashboard cache holding a lead total would otherwise fail at `set` time.
 *
 * Dates become ISO strings, which is a real lossy step: a durable namespace must
 * store JSON-safe values. OTP payloads (`{ code, purpose }`) are, which is why
 * they are the durable ones.
 *
 * @type {(value: unknown) => string}
 */
const encode = encodeJson;

/**
 * Decodes a stored value.
 *
 * A row that does not parse is a miss, not a 500: the alternative is a single
 * corrupt row turning every OTP verification into an error until someone notices.
 *
 * @param {string | null} raw
 * @returns {unknown | null}
 */
function decode(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = decodeJson(raw);
    return parsed === null ? null : parsed;
  } catch (err) {
    getLogger().warn({ err: { message: err.message } }, "durable cache row did not parse — treating as a miss");
    return null;
  }
}

/**
 * Records that the durable tier is unreachable. Logged once per recovery window
 * rather than per operation: this sits in front of registration and password
 * reset, and a log line per failed write is how a real outage gets missed behind
 * the noise it makes.
 */
function noteFailure(operation) {
  const now = Date.now();
  if (degradedSince === 0) {
    degradedSince = now;
    getLogger().warn({ operation }, "durable cache tier unavailable — serving from memory only");
    return;
  }
  if (now - degradedSince > 60_000) {
    getLogger().info({ operation, downForMs: now - degradedSince }, "durable cache tier recovered");
    degradedSince = 0;
  }
}

/** Clears the latched failure state. The test seam. */
function resetFailureLatch() {
  degradedSince = 0;
}

/**
 * Reads one row.
 *
 * @param {string} key a **qualified** key from `cache.qualify`
 * @returns {Promise<unknown|null>} `null` on a miss, an expired row, or an error.
 */
async function read(key) {
  try {
    const row = await prisma.kvEntry.findUnique({ where: { key } });

    if (!row) return null;

    // Lazy expiry, matching the in-memory tier. A row past its deadline is a
    // miss and is deleted on the way out, so an idle process does not
    // accumulate tombstones forever.
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
      await prisma.kvEntry.deleteMany({ where: { key } });
      return null;
    }

    return decode(row.value);
  } catch (err) {
    noteFailure("read");
    getLogger().debug({ err: { message: err.message } }, "durable cache read failed");
    return null;
  }
}

/**
 * Writes one row, replacing any existing entry for the same key.
 *
 * `upsert` rather than create-then-catch: an OTP resend writes the same key with
 * a new code, and that is an overwrite, not a conflict.
 *
 * @param {string} key a qualified key from `cache.qualify`
 * @param {unknown} value
 * @param {number} ttlSeconds a value `<= 0` writes an already-expired row
 * @returns {Promise<boolean>} whether the row was written
 */
async function write(key, value, ttlSeconds) {
  try {
    await prisma.kvEntry.upsert({
      where: { key },
      create: { key, value: encode(value), expires_at: new Date(Date.now() + ttlSeconds * 1000) },
      update: { value: encode(value), expires_at: new Date(Date.now() + ttlSeconds * 1000) },
    });
    return true;
  } catch (err) {
    noteFailure("write");
    getLogger().debug({ err: { message: err.message } }, "durable cache write failed");
    return false;
  }
}

/**
 * Deletes one row.
 *
 * @param {string} key a qualified key
 * @returns {Promise<boolean>} whether a row was actually removed
 */
async function remove(key) {
  try {
    const { count } = await prisma.kvEntry.deleteMany({ where: { key } });
    return count > 0;
  } catch (err) {
    noteFailure("delete");
    return false;
  }
}

/**
 * Deletes every row under a prefix.
 *
 * `startsWith` rather than a SQL `LIKE`, because a key containing `%` or `_`
 * would make the pattern match rows it should not — and those characters are
 * legal in a key derived from an email address.
 *
 * @param {string} prefix an **unqualified** prefix; the app prefix is added here
 * @returns {Promise<number>} how many rows were removed
 */
async function removePrefix(prefix) {
  try {
    const { count } = await prisma.kvEntry.deleteMany({
      where: { key: { startsWith: `${config.cache.prefix}${prefix}` } },
    });
    return count;
  } catch (err) {
    noteFailure("deletePrefix");
    return 0;
  }
}

/**
 * Readiness of the durable tier.
 *
 * Resolves the table rather than the database: `/health/ready` already probes
 * MySQL, and a second `SELECT 1` would report the same fact twice while saying
 * nothing about the table the cache actually needs. A missing `kv_entries` is
 * the realistic failure here — a database created before this table existed.
 *
 * @returns {Promise<{ ok: boolean, entries: number }>}
 */
async function health() {
  const entries = await prisma.kvEntry.count();
  return { ok: true, entries };
}

/**
 * Empties the durable tier. The test seam — no production caller.
 *
 * @returns {Promise<number>} rows removed
 */
async function clear() {
  try {
    const { count } = await prisma.kvEntry.deleteMany({
      where: { key: { startsWith: config.cache.prefix } },
    });
    return count;
  } catch (err) {
    noteFailure("clear");
    return 0;
  }
}

module.exports = {
  isDurable,
  encode,
  decode,
  read,
  write,
  remove,
  removePrefix,
  health,
  clear,
  resetFailureLatch,
  DURABLE_NAMESPACES,
};