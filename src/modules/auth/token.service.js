/**
 * Token issue, verify, rotation and revocation.
 *
 * Replaces `src/services/jwt.service.js` (deleted in M03). That file signed a token
 * and verified it, and both functions collapsed every failure into `null`, so a
 * caller could not tell a stale token from a forged one and had nothing to say
 * beyond "Invalid or expired token".
 *
 * ## Claims
 *
 * | Claim | Why |
 * |---|---|
 * | `userId`, `email`, `role` | the pre-M03 payload, unchanged — `req.user` and the admin guards read them |
 * | `type` | `access` or `refresh`. Prevents an access token being redeemed at `/auth/refresh`, which is what the endpoint's whole role-dispatch relies on |
 * | `jti` | **new.** Identifies one token, so it can be denied individually |
 * | `fam` | **new.** The rotation family, so a stolen *refresh* token can take the whole chain with it |
 * | `tokenVersion` | **new in practice.** The column existed as an unused function parameter; see `prisma/schema.prisma` |
 *
 * ## Two tiers of denial, deliberately
 *
 * **Per-token — `jti`, in-process.** A `Map` with a lazy TTL sweep, consulted on
 * every authenticated request. It is *not* in `platform/cache`, and that is a
 * decision rather than an oversight: the cache is async, and making `authenticate`
 * async means an Express-4 middleware whose rejection has to be caught by hand on
 * every route in the application. A synchronous `Map` keeps `authenticate`
 * unchanged and costs one lookup. With the deployment pinned to a single replica
 * (`docs/runbook.md`) process-local is exactly correct.
 *
 * **Per-family — `fam`, durable.** Reuse detection state lives in `platform/cache`
 * under the **durable** namespace, because getting it wrong is a security failure
 * rather than a stale read: two replicas that do not share the current `jti` will
 * both accept the same refresh token, which is precisely the reuse the mechanism
 * exists to catch. `/auth/refresh` is one low-volume write and one indexed
 * `SELECT`, so paying for the shared tier here costs nothing on any hot path.
 *
 * The exit path when this scales out is Redis for both tiers; `platform/cache` is
 * already the seam.
 *
 * ## The rotation race, stated
 *
 * Rotation state is read, then written, without a compare-and-set. Two *concurrent*
 * refreshes presenting the same token therefore both succeed, and one of the two
 * issued pairs is orphaned. That is not the reuse case: no token is ever accepted
 * twice after it has been rotated, and the property M03 promises — replay of a
 * rotated token revokes the family — holds. Serialising the two would need an atomic
 * conditional write in the shared store, which `platform/cache` does not expose.
 * Recorded rather than papered over.
 */
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const config = require("../../config");
const cache = require("../../platform/cache");
const { getLogger } = require("../../core/logger");

if (!config.jwt.secret || !config.jwt.refreshSecret) {
  // Unreachable in production: `src/config` refuses to boot without both. Kept
  // as defence in depth for a caller that passes its own config object.
  if (config.isProduction) {
    throw new Error("JWT_SECRET and JWT_REFRESH_SECRET must be set in production");
  }
  // eslint-disable-next-line no-console -- the pre-M01 message, still the operator's signal
  console.warn("⚠️  Using fallback JWT secrets — NOT safe for production");
}

// The fallback literals are the [M00 finding
// #1](../../docs/milestones/M00-safety-net.md) exploit: they are in this file, in
// this repository, and anything that knows them can forge an admin token.
const SECRET = config.jwt.secret || "dev-secret-fallback-only";
const REFRESH_SECRET = config.jwt.refreshSecret || "dev-refresh-fallback-only";

/** The two `type` values. A token signed with the access secret is not a refresh token. */
const TokenType = Object.freeze({ ACCESS: "access", REFRESH: "refresh" });

/**
 * Why a verification failed.
 *
 * The whole reason this is an enum and not `null`: `expired` and `malformed` are
 * different events for whoever is reading the 401 — one is a client that slept,
 * the other is a token that should never have existed — and collapsing them into
 * one code tells an operator nothing. `malformed` also covers a wrong-secret
 * signature, which is what presenting an access token at `/auth/refresh` produces.
 */
const VerifyFailure = Object.freeze({
  MALFORMED: "malformed",
  EXPIRED: "expired",
  WRONG_TYPE: "wrong_type",
  REVOKED: "revoked",
});

/**
 * Rotation state, in the durable tier.
 *
 * Not `otp`: this namespace is not a one-time code, it is the record of which
 * refresh token in a family is currently live, and losing it silently re-opens
 * replay of a rotated token.
 */
const ROTATION_NAMESPACE = "auth_token";

const ROTATION_ACTIVE = "active";
const ROTATION_REVOKED = "revoked";

/**
 * Per-token denial, process-local. See the module note on why this is not
 * `platform/cache`.
 *
 * @type {Map<string, number>} key → epoch ms the entry expires
 */
const denied = new Map();

/** Opaque, URL-safe, 128 bits of entropy. */
function randomId() {
  return crypto.randomUUID();
}

/**
 * @typedef {object} TokenClaims
 * @property {string} userId
 * @property {string} email
 * @property {string} role
 * @property {string} type
 * @property {string} [jti]
 * @property {string} [fam]
 * @property {number} [tokenVersion]
 * @property {number} [iat]
 * @property {number} [exp]
 */

/**
 * Normalises `tokenVersion`.
 *
 * A token issued before the column existed carries no claim at all, and the column
 * defaults to 0 — so "absent" has to mean 0 or every outstanding token would look
 * stale the moment M03 deploys.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTokenVersion(value) {
  return Number.isInteger(value) && value >= 0 ? /** @type {number} */ (value) : 0;
}

/**
 * Seconds a claim set has left, floored at one minute.
 *
 * The floor matters on the denial side: an entry written with a TTL of 0 is a
 * denial that expires before the next request can read it, which is worse than
 * useless — it looks like it worked.
 *
 * @param {TokenClaims} payload
 * @param {number} [now]
 * @returns {number}
 */
function secondsRemaining(payload, now = Date.now()) {
  if (!Number.isFinite(payload.exp)) return 60;
  return Math.max(60, Math.ceil((payload.exp * 1000 - now) / 1000));
}

// ─── the per-token deny list ────────────────────────────────────────────────

/**
 * Expired entries are dropped on access rather than on a timer. A timer would hold
 * the event loop open and break `server.js`'s drain, which is the same reasoning as
 * the lazy sweep in `platform/cache/cache.js`.
 *
 * @param {number} [now]
 */
function sweepDenied(now = Date.now()) {
  for (const [key, expiresAt] of denied) {
    if (expiresAt <= now) denied.delete(key);
  }
}

/**
 * Denies one `jti`, and the family it belongs to.
 *
 * @param {string} [jti]
 * @param {string} [family]
 * @param {number} ttlSeconds
 */
function deny(jti, family, ttlSeconds) {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  if (jti) denied.set(`jti:${jti}`, expiresAt);
  if (family) denied.set(`fam:${family}`, expiresAt);
}

/**
 * @param {TokenClaims} payload
 * @returns {boolean}
 */
function isDenied(payload) {
  sweepDenied();
  if (payload.jti && denied.has(`jti:${payload.jti}`)) return true;
  if (payload.fam && denied.has(`fam:${payload.fam}`)) return true;
  return false;
}

/** The test seam. Not a production caller. */
function clearDenials() {
  denied.clear();
}

// ─── rotation state ─────────────────────────────────────────────────────────

/** @param {string} family */
function rotationKey(family) {
  return `rot:${family}`;
}

/**
 * The family for a token minted before `fam` existed.
 *
 * Derived from the token itself, so a pre-M03 refresh token deterministically lands
 * in one family and its first redemption starts that family's rotation rather than
 * an untracked free-for-all. The hash is one-way: the family id never reveals the
 * token.
 *
 * @param {string} rawToken
 * @returns {string}
 */
function legacyFamily(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex").slice(0, 32);
}

/**
 * Decides whether a refresh token may be redeemed, and by what it is replaced.
 *
 * A token is a *reuse* when the family's live `refreshJti` is something else: either
 * a rotated token being replayed, or a legacy token already redeemed once. That is
 * the whole of the property — and it needs no knowledge of whether the presenter is
 * the thief or the victim, because in both readings the safe answer is the same.
 *
 * @param {{ payload: TokenClaims, rawToken: string }} input
 * @returns {Promise<
 *   | { ok: true, family: string, state: {status: string, refreshJti?: string, accessJti?: string} | null }
 *   | { ok: false, reason: "reuse" | "family_revoked" }
 * >}
 */
async function acceptRotation({ payload, rawToken }) {
  const family = payload.fam || legacyFamily(rawToken);
  const key = rotationKey(family);
  const state = await cache.get(ROTATION_NAMESPACE, key);

  if (state && state.status === ROTATION_REVOKED) {
    return { ok: false, reason: "family_revoked" };
  }

  if (state && state.status === ROTATION_ACTIVE && state.refreshJti !== payload.jti) {
    await cache.set(
      ROTATION_NAMESPACE,
      key,
      { status: ROTATION_REVOKED, revokedAt: Date.now() },
      secondsRemaining(payload)
    );

    // Kill the whole chain here, not just the state row: the replayed token, the
    // token currently live in the family, and the access token that shipped with
    // it. The durable marker above is what survives a restart; these are what take
    // effect on the next request instead of the next refresh.
    deny(payload.jti, family, secondsRemaining(payload));
    deny(state.refreshJti, undefined, secondsRemaining(payload));
    deny(state.accessJti, undefined, secondsRemaining(payload));

    getLogger().warn(
      { jti: payload.jti, family, liveJti: state.refreshJti },
      "refresh token reuse detected — whole family revoked"
    );

    return { ok: false, reason: "reuse" };
  }

  return { ok: true, family, state: state || null };
}

/**
 * Records the newly issued pair as the family's live one, and spends the old one.
 *
 * Denies the two `jti`s that are being retired and **not** the family: the new pair
 * belongs to the same family, so a family-wide denial here would log the caller out
 * of the session it has just been given.
 *
 * @param {{
 *   family: string,
 *   previous: TokenClaims,
 *   previousState: { accessJti?: string } | null,
 *   pair: { jti: { access: string, refresh: string } },
 *   ttlSeconds: number,
 * }} input
 * @returns {Promise<void>}
 */
async function completeRotation({ family, previous, previousState, pair, ttlSeconds }) {
  await cache.set(
    ROTATION_NAMESPACE,
    rotationKey(family),
    { status: ROTATION_ACTIVE, refreshJti: pair.jti.refresh, accessJti: pair.jti.access },
    ttlSeconds
  );

  deny(previous.jti, undefined, secondsRemaining(previous));
  deny(previousState && previousState.accessJti, undefined, secondsRemaining(previous));
}

// ─── signing ────────────────────────────────────────────────────────────────

/**
 * Signs one token.
 *
 * @param {{
 *   userId: string,
 *   email: string,
 *   role: string,
 *   family: string,
 *   tokenVersion: number,
 *   type: string,
 *   jti: string,
 *   expiresIn: string,
 *   secret: string,
 * }} claims
 * @returns {string}
 */
function sign({ userId, email, role, family, tokenVersion, type, jti, expiresIn, secret }) {
  const payload = { userId, email, role, type, jti, fam: family, tokenVersion };
  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Seconds a signed token is good for, read back off the token itself.
 *
 * Read off the token rather than parsed from `JWT_REFRESH_EXPIRES_IN` so the
 * rotation record's TTL cannot drift from the credential it describes: whatever the
 * library decided `"7d"` meant is what is stored.
 *
 * @param {string} token
 * @returns {number}
 */
function lifetimeSeconds(token) {
  const decoded = jwt.decode(token);
  if (!decoded || !Number.isFinite(decoded.exp) || !Number.isFinite(decoded.iat)) return 60;
  return Math.max(60, decoded.exp - decoded.iat);
}

/**
 * Issues an access/refresh pair in a fresh family.
 *
 * The internal `jti`s, the family and the refresh lifetime are returned alongside
 * the tokens but never on the wire — see `auth.mapper.js`, which is the only thing
 * allowed to decide what a client sees.
 *
 * @param {string|number} userId
 * @param {string} email
 * @param {string} role
 * @param {number} [tokenVersion]
 * @param {string} [family] the family to stay in when this is a **rotation**.
 *   Omitted for a fresh session. A rotated pair must inherit its family, or the
 *   family link is severed at the first rotation and family-wide revocation stops
 *   working from the second refresh onward — which is the only case it exists for.
 * @returns {{
 *   accessToken: string,
 *   refreshToken: string,
 *   family: string,
 *   jti: { access: string, refresh: string },
 *   refreshTtlSeconds: number,
 * }}
 */
function issuePair(userId, email, role, tokenVersion, family) {
  const fam = family || randomId();
  const jti = { access: randomId(), refresh: randomId() };
  const version = normalizeTokenVersion(tokenVersion);
  // `userId` is passed through unconverted, exactly as the pre-M03 service did: it
  // reaches `req.user.id` and then a `uid: Int` filter, and changing its JSON type
  // is a contract change with no security benefit.
  const base = { userId, email, role, family: fam, tokenVersion: version };

  const refreshToken = sign({
    ...base,
    type: TokenType.REFRESH,
    jti: jti.refresh,
    expiresIn: config.jwt.refreshExpiresIn,
    secret: REFRESH_SECRET,
  });

  return {
    accessToken: sign({
      ...base,
      type: TokenType.ACCESS,
      jti: jti.access,
      expiresIn: config.jwt.expiresIn,
      secret: SECRET,
    }),
    refreshToken,
    family: fam,
    jti,
    refreshTtlSeconds: lifetimeSeconds(refreshToken),
  };
}

// ─── verification ───────────────────────────────────────────────────────────

/**
 * @param {string} token
 * @param {string} secret
 * @param {string} expectedType
 * @returns {{ ok: true, payload: TokenClaims } | { ok: false, reason: string }}
 */
function verifyWith(token, secret, expectedType) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: VerifyFailure.MALFORMED };
  }

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch (err) {
    return {
      ok: false,
      reason: err && err.name === "TokenExpiredError" ? VerifyFailure.EXPIRED : VerifyFailure.MALFORMED,
    };
  }

  if (payload.type !== expectedType) return { ok: false, reason: VerifyFailure.WRONG_TYPE };
  if (isDenied(payload)) return { ok: false, reason: VerifyFailure.REVOKED };

  return { ok: true, payload: /** @type {TokenClaims} */ (payload) };
}

/**
 * @param {string} token
 * @returns {{ ok: true, payload: TokenClaims } | { ok: false, reason: string }}
 */
function verifyAccess(token) {
  return verifyWith(token, SECRET, TokenType.ACCESS);
}

/**
 * @param {string} token
 * @returns {{ ok: true, payload: TokenClaims } | { ok: false, reason: string }}
 */
function verifyRefresh(token) {
  return verifyWith(token, REFRESH_SECRET, TokenType.REFRESH);
}

/**
 * Revokes one presented token and its family.
 *
 * Used by `POST /auth/logout`. A token that cannot be verified is not an error —
 * logging out with an expired token is the ordinary case, and the client's intent
 * (discard what it holds) is satisfied either way.
 *
 * @param {string} [token]
 * @returns {boolean} whether a live token was actually revoked.
 */
function revoke(token) {
  if (typeof token !== "string" || token.length === 0) return false;

  for (const verify of [verifyAccess, verifyRefresh]) {
    const result = verify(token);
    if (result.ok) {
      deny(result.payload.jti, result.payload.fam, secondsRemaining(result.payload));
      return true;
    }
  }

  return false;
}

module.exports = {
  TokenType,
  VerifyFailure,
  issuePair,
  verifyAccess,
  verifyRefresh,
  acceptRotation,
  completeRotation,
  revoke,
  normalizeTokenVersion,
  // seams for `test/modules/auth.test.js`
  deniedKeyCount: () => denied.size,
  clearDenials,
  ROTATION_NAMESPACE,
};