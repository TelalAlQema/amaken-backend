/**
 * The one password implementation in the process.
 *
 * ## Why this lives in `core/` and not in `modules/auth`
 *
 * Three callers need it — the auth login, the user's own password change, and the
 * admin login and password change — and `auth` cannot own it, because the two
 * identity modules that M04 introduces both need it and neither may depend on the
 * other's service. Putting it in `core/` means all three import the same file with
 * no dependency edge between the modules at all. `core/` is the layer every module
 * may reach, and a password hasher is a pure computation over a library: no
 * database, no HTTP, no configuration.
 *
 * ## What this file deleted
 *
 * There were **four** verify paths in the codebase, and they disagreed:
 *
 * | Caller | Accepted | Compared with | Upgraded on success |
 * |---|---|---|---|
 * | `modules/auth/auth.service.js` | bcrypt/argon2, SHA-256 hex | `timingSafeEqual` | yes |
 * | `services/user.service.js:16` | bcrypt/argon2, SHA-256 hex | `===` | **no** |
 * | `services/admin.service.js:67` | bcrypt/argon2, **SHA-1** hex | `===` | yes |
 * | `services/admin.service.js:271` | bcrypt/argon2, **SHA-1** hex | `===` | **no** |
 *
 * So the same stored hash was checked under two different algorithms depending on
 * which endpoint the caller used, two of the four compared with `===` — which
 * leaks the digest's prefix through timing — and half of them never upgraded, so a
 * user could keep authenticating against a bare SHA-1/SHA-256 digest indefinitely.
 * M04 collapses all four onto this one.
 *
 * ## Why the legacy digests are gone rather than kept as a branch
 *
 * The two bare-digest fallbacks existed so that accounts carried over from the PHP
 * application this API replaced could still sign in, and each one upgraded in place
 * on a successful match. That migration never ran, because nothing forced it: an
 * account that never signs in is never upgraded, and the fallback branch stayed
 * live code the whole time.
 *
 * Keeping them here would preserve that. The remaining fallback is therefore
 * **bcrypt at a cost below {@link BCRYPT_COST}**, which has the same self-erasing
 * property — a cost-4 hash from an old deployment is re-hashed to 12 on the next
 * successful login — without a second algorithm to keep correct. An account still
 * carrying a bare digest from the PHP migration has to use the reset flow; that is a
 * deliberate, documented consequence of removing an unsalted fast hash from a
 * system that has been running for years, and it is the reason this note exists.
 *
 * @see ./index.js for the barrel and the public names.
 */
const bcrypt = require("bcryptjs");

/**
 * The only cost this process writes.
 *
 * 12 is bcrypt's usual ceiling for an interactive login: roughly 250ms on current
 * server hardware, which is slow enough to make an offline cracking attempt
 * expensive and fast enough that nobody notices it at the login button.
 */
const BCRYPT_COST = 12;

/** Prefixes that mean "this is a real password hash", as opposed to a bare digest. */
const HASH_PREFIXES = Object.freeze(["$2", "$argon"]);

/**
 * A cost-12 hash of a value nobody knows.
 *
 * Compared against when the *account* cannot be found, so that "no such email" and
 * "wrong password" take the same time. Without it, the response latency is the
 * oracle: an attacker enumerating registered addresses does not need to guess a
 * password, only to measure which addresses exist. A fixed dummy also means every
 * unknown address pays a full bcrypt cost rather than returning instantly.
 *
 * Built once at load. `hashSync` here is the only blocking bcrypt call in the
 * process and costs one hash per boot, not per request.
 */
const DUMMY_HASH = bcrypt.hashSync("amaken-nonexistent-account", BCRYPT_COST);

/**
 * Hashes a password for storage.
 *
 * @param {string} plain
 * @returns {Promise<string>} a cost-12 bcrypt hash
 */
function hash(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Whether `stored` is a bcrypt or argon2 hash, as opposed to something this
 * process cannot verify.
 *
 * @param {unknown} stored
 * @returns {boolean}
 */
function isHash(stored) {
  return typeof stored === "string" && HASH_PREFIXES.some((prefix) => stored.startsWith(prefix));
}

/**
 * Verifies a password, and says whether the stored value should be replaced.
 *
 * The `upgrade` field is the whole migration mechanism, and it is deliberately the
 * *only* one: a correct password stored at a cost below {@link BCRYPT_COST} comes
 * back with a fresh cost-12 hash, and the caller persists it. There is no second
 * algorithm to upgrade from.
 *
 * A stored value this function cannot verify — an empty column, `null`, or a bare
 * digest left over from the PHP migration — is a plain `ok: false` with no
 * `upgrade`. It is never a throw, because "this account cannot sign in" is a
 * business outcome and the caller's job is to report it, not to crash on it.
 *
 * @param {string} plain the candidate password
 * @param {unknown} stored the value from the database
 * @returns {Promise<{ ok: boolean, upgrade: string | null }>} `upgrade` is a
 *   cost-12 hash to persist, or `null` when the stored value is already current.
 */
async function verify(plain, stored) {
  if (!isHash(stored)) return { ok: false, upgrade: null };

  const ok = await bcrypt.compare(plain, /** @type {string} */ (stored));
  if (!ok) return { ok: false, upgrade: null };

  // `getRounds` throws on anything that is not a bcrypt string, which is why it is
  // only reached once the prefix has already proved the format. An argon2 hash is
  // deliberately left alone: this process cannot rehash it, and silently replacing
  // it with bcrypt would be a downgrade decided by a login attempt.
  if (stored.startsWith("$2") && bcrypt.getRounds(stored) < BCRYPT_COST) {
    return { ok: true, upgrade: await hash(plain) };
  }

  return { ok: true, upgrade: null };
}

/**
 * Burns roughly the same time as a real {@link verify}, for the case where there is
 * nothing to verify against.
 *
 * The enumeration defence. `auth.service.loginUser` calls this before rejecting an
 * unknown address so the two failures are indistinguishable by timing; any future
 * caller that short-circuits on "no such account" should call this instead of
 * returning early.
 *
 * @returns {Promise<false>} always `false`, so it can be awaited and discarded
 */
async function burn() {
  await bcrypt.compare("amaken-nonexistent-account", DUMMY_HASH);
  return false;
}

module.exports = { hash, verify, burn, isHash, BCRYPT_COST, HASH_PREFIXES };