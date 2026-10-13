/**
 * The rate limiter.
 *
 * Two limiters in front of `/api`, both on `express-rate-limit`'s own
 * `MemoryStore`.
 *
 * ## The store is per-process, and that is a deployment constraint
 *
 * M02 originally put a Redis-backed store here so the counter would be global and
 * survive a deploy. Redis is not available in this deployment, so the store is
 * `MemoryStore` and the limiter's blast radius is a single process:
 *
 *   - under N replicas the effective limit is **N × the configured value**, and
 *   - every deploy resets every counter, so a deploy is a free burst of the full
 *     allowance.
 *
 * Neither is acceptable for a multi-replica deployment, which is why the API is
 * pinned to one replica in `docs/runbook.md`. That constraint is not only about
 * uploads — it is also this.
 *
 * Two limiters are kept rather than one because they answer different
 * questions. `RATE_LIMIT_MAX` bounds general traffic, so one noisy client cannot
 * exhaust the database. `AUTH_RATE_LIMIT_MAX` bounds credential stuffing, which is
 * the attack this limiter exists for; at the general limit that attack gets 100
 * attempts per window, which is not a limit.
 *
 * ## Key derivation
 *
 * `keyGenerator` defaults to `req.ip`, which is only correct when `trust proxy`
 * is configured — otherwise every request behind an ALB shares the ALB's address
 * and one abusive client locks out everyone. `app.js` only sets `trust proxy` when
 * `TRUST_PROXY=true`, and express-rate-limit v7 handles the `X-Forwarded-For` case
 * correctly when it is on, so the default is kept rather than reimplemented.
 */
const rateLimit = require("express-rate-limit");

const config = require("../../config");
const { getLogger } = require("../logger");

/**
 * The shared limiter factory.
 *
 * `store` is deliberately left `undefined`. `express-rate-limit` then constructs
 * its own `MemoryStore` **per limiter**, which is required rather than merely
 * convenient: v7 throws `ERR_ERL_STORE_REUSE` if one store instance is handed to
 * two limiters, because each namespaces its keys by its own prefix. Sharing one
 * instance would merge the general `/api` budget with the `/api/auth` one and make
 * the stricter auth limit meaningless.
 *
 * @param {object} options
 * @param {number} options.max
 * @param {string} options.message
 * @param {string} options.bucket metric label, not a key prefix
 * @returns {import("express").RequestHandler}
 */
function createLimiter({ max, message, bucket }) {
  return rateLimit({
    windowMs: config.http.rateLimit.windowMs,
    max,
    message,
    // `standardHeaders: "draft-7"` emits `RateLimit-Limit` / `-Remaining` /
    // `-Reset`, which any client can read instead of guessing. `legacyHeaders` off,
    // because the `X-RateLimit-*` headers are deprecated and a client that reads
    // both cannot tell which is authoritative.
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Only count responses that were actually served — a 429 must not itself
    // consume the next request's budget, which is how a limiter turns into a
    // lockout amplifier.
    skip: (req, res) => res.statusCode === 429,
    requestPropertyName: "rateLimitInfo",
    handler: (req, res, next, options) => {
      // `amaken_api_rate_limit_hits_total` is the series that tells an operator rate
      // limiting is live and working; without it a limiter that silently stopped
      // registering would look identical to a quiet night.
      const { countRateLimitHit } = require("../observability");
      countRateLimitHit({ limiter: bucket });

      getLogger().warn({ requestId: req.id, ip: req.ip, limiter: bucket }, message);

      res.status(options.statusCode).json({
        success: false,
        error: { message, code: "RATE_LIMITED" },
      });
    },
  });
}

/**
 * The general `/api` limiter.
 *
 * @type {import("express").RequestHandler}
 */
const apiLimiter = createLimiter({
  max: config.http.rateLimit.max,
  message: "Too many requests from this IP, please try again later.",
  bucket: "api",
});

/**
 * The stricter `/api/auth` limiter. Registered after the general one, so a
 * credential-stuffing run is bounded at the auth limit rather than the api limit.
 *
 * @type {import("express").RequestHandler}
 */
const authLimiter = createLimiter({
  max: config.http.rateLimit.authMax,
  message: "Too many auth attempts, please try again later.",
  bucket: "auth",
});

module.exports = { apiLimiter, authLimiter, createLimiter, storeName: "memory" };