/**
 * The one and only place permitted to read `process.env`.
 *
 * Load order is the security property, not a style preference. Before M01,
 * `src/index.js` called `dotenv.config()` at line 12 — *after* requiring the
 * route graph — so `jwt.service` read an empty `process.env` and signed every
 * token with a secret committed to the repository ([M00 finding
 * #1](../../docs/milestones/M00-safety-net.md)). The `NODE_ENV === "production"`
 * guard could not fire, because the process had no idea what environment it
 * was in.
 *
 * The fix is structural: `dotenv` runs at the top of this file, and every other
 * module reads the frozen object exported from the bottom of it. `config` is
 * therefore required *first* in every entry point — `server.js`, and
 * `test/helpers/app.js` after it has repointed `DATABASE_URL` at the test
 * database.
 *
 * It is deliberately memoised by Node's module cache: `require` twice, validate
 * once.
 */
const path = require("node:path");
const dotenv = require("dotenv");
const { ZodError } = require("zod");

const { envSchema, REQUIRED_IN_PRODUCTION, ROOT } = require("./env.schema");

// ── 1. dotenv, before anything reads the environment ─────────────────────────

dotenv.config({ path: path.join(ROOT, ".env") });

// ── 2. validate ──────────────────────────────────────────────────────────────

/** @type {import("zod").SafeParseReturnType<any, any>} */
let parsed;
try {
  parsed = envSchema.safeParse(process.env);
} catch (err) {
  // A malformed .env can make the schema itself throw. Surface it as a boot
  // failure with the real cause rather than an unhandled rejection.
  throw new Error(`Environment validation crashed: ${err && err.message}`, { cause: err });
}

if (!parsed.success) {
  if (parsed.error instanceof ZodError) {
    throw new Error(
      "Invalid environment configuration:\n" +
        parsed.error.errors.map((e) => `  ${e.path.join(".") || "(root)"}: ${e.message}`).join("\n")
    );
  }
  throw parsed.error;
}

const env = parsed.data;

// ── 3. warn loudly, but do not fail, outside production ──────────────────────
//
// Preserved verbatim from the pre-M01 `src/index.js`: a developer with no
// `.env` still gets a booting server, because failing here would make the
// contract tests unrunnable on a fresh clone.

if (env.NODE_ENV !== "production") {
  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!env[key]) {
      // eslint-disable-next-line no-console -- config/ is the permitted exception
      console.warn(`⚠️  Missing env var: ${key} — using defaults (development only)`);
    }
  }
}

// ── 4. derived, frozen configuration ─────────────────────────────────────────

/**
 * `JSON.parse(JSON.stringify(v))` is not a clone: it drops `undefined` silently
 * and mangles `Date`. This walks the object graph and freezes in place, which is
 * all "frozen config" has to mean here — the values are primitives and arrays.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * `LOG_LEVEL` is optional, so the default is derived from the environment
 * rather than hard-coded: silent in the test suite (stdout is assertion noise
 * there), debug in development, info in production.
 */
function defaultLogLevel() {
  if (env.NODE_ENV === "test") return "silent";
  if (env.NODE_ENV === "production") return "info";
  return "debug";
}

/**
 * Splits `CORS_ORIGIN` into a list of origins.
 *
 * A comma-separated string rather than a JSON array, because that is what a
 * `.env` file can express without escaping and what the runbook documents. Every
 * entry is trimmed, and a `*` anywhere is preserved as the literal wildcard so the
 * `cors` package's own handling applies — silently turning `*` into a normal entry
 * would mean reflecting a request's Origin header, which is a different and much
 * more permissive policy than the one that was written down.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseOriginList(raw) {
  return String(raw)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const config = deepFreeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  isDevelopment: !env.NODE_ENV || env.NODE_ENV === "development",

  paths: {
    root: ROOT,
    uploads: env.UPLOAD_DIR,
  },

  http: {
    host: env.HOST,
    port: env.PORT,
    /**
     * Comma-separated allow-list. Kept as the raw string because that is the shape a
     * `.env` file can express and what the runbook documents; `core/http/cors.js`
     * turns it into either a single string or a predicate, and it is also exposed
     * split so an operator-facing view (`/health` in dev, a startup log) does not
     * have to re-parse it.
     */
    corsOrigin: env.CORS_ORIGIN,
    corsOrigins: parseOriginList(env.CORS_ORIGIN),
    bodyLimit: env.BODY_LIMIT,
    trustProxy: env.TRUST_PROXY,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    keepAliveTimeoutMs: env.KEEP_ALIVE_TIMEOUT_MS,
    headersTimeoutMs: env.HEADERS_TIMEOUT_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
    },
  },

  db: {
    url: env.DATABASE_URL,
    connectRetries: env.DB_CONNECT_RETRIES,
    connectRetryDelayMs: env.DB_CONNECT_RETRY_DELAY_MS,
  },

  jwt: {
    secret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },

  log: {
    level: env.LOG_LEVEL || defaultLogLevel(),
    requestIdHeader: env.REQUEST_ID_HEADER,
    redact: Object.freeze([...env.LOG_REDACT]),
  },

  metrics: {
    enabled: env.METRICS_ENABLED,
    prefix: env.METRICS_DEFAULT_PREFIX,
  },

  /**
   * `queue.pollIntervalMs` is what replaces BullMQ's blocking `BRPOP`: a worker
   * wakes at least that often to notice SIGTERM and to reclaim an expired lease.
   * `queue.leaseMs` is how long a claimed job may stay `active` before another
   * worker may take it, and must exceed the slowest processor.
   */
  cache: {
    prefix: env.CACHE_PREFIX,
    ttlSeconds: env.CACHE_TTL_SECONDS,
    /**
     * Namespaces written to MySQL as well as held in memory. `otp` is the
     * non-negotiable member: it holds registration codes and reset tokens, and a
     * value one replica cannot read is a failed registration.
     */
    durableNamespaces: env.CACHE_DURABLE_NAMESPACES,
  },

  /**
   * The queue is MySQL-backed — the same database, not a second datastore. See
   * `platform/queue/` for why, and `docs/runbook.md` for what it costs.
   */
  queue: {
    enabled: env.QUEUE_ENABLED,
    prefix: env.QUEUE_PREFIX,
    pollIntervalMs: env.QUEUE_POLL_INTERVAL_MS,
    leaseMs: env.QUEUE_LEASE_MS,
    concurrency: env.QUEUE_CONCURRENCY,
    attempts: env.QUEUE_ATTEMPTS,
    backoffMs: env.QUEUE_BACKOFF_MS,
    maxDeadJobs: env.QUEUE_MAX_DEAD_JOBS,
  },

  mail: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
    siteName: env.SITE_NAME,
  },

  admin: {
    mainPhone: env.ADMIN_MAIN_PHONE,
  },

  test: {
    dbName: env.TEST_DB_NAME,
  },
});

// Frozen: consumers read it, they never patch it. A test that needs different
// values calls `createApp({ config })`, it does not mutate this object.
module.exports = config;
