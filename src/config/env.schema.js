/**
 * Environment schema.
 *
 * Every `process.env` key the application reads is declared here, once. If a
 * setting is not in this file, it does not exist — that is the whole point: an
 * undeclared variable is a typo or a secret nobody audited, and today it is
 * invisible until a request 500s in production.
 *
 * The schema is deliberately shape-preserving. Keys that were absent before M01
 * stay absent; keys that had a hard-coded default keep exactly that default.
 * `src/config/index.js` is what turns this into a validated, frozen object.
 */
const path = require("node:path");
const { z } = require("zod");

/** Repository root, two levels above `src/config/`. */
const ROOT = path.join(__dirname, "..", "..");

/**
 * `NODE_ENV` is deliberately a free string, not an enum.
 *
 * The application only ever *branches* on `production`, and it is deployed
 * behind environments (`staging`, `qa`, …) whose names are not ours to fix. An
 * enum would turn a legitimate value into a boot failure for no safety gain.
 */
const NODE_ENV_DEFAULT = "development";
const LOG_LEVELS = ["silent", "fatal", "error", "warn", "info", "debug", "trace"];

/** Trimmed, non-empty string, or absent. `""` in .env means "not set". */
const optionalString = z
  .union([z.string(), z.undefined()])
  .transform((v) => (typeof v === "string" ? v.trim() : v))
  .transform((v) => (v === "" ? undefined : v))
  .refine((v) => v === undefined || typeof v === "string", { message: "Expected a string" });

const port = (fallback) =>
  z
    .union([z.coerce.number(), z.undefined()])
    .transform((v) => (v === undefined || Number.isNaN(v) ? fallback : v))
    .pipe(z.number().int().min(1).max(65535));

const positiveInt = (fallback) =>
  z
    .union([z.coerce.number(), z.undefined()])
    .transform((v) => (v === undefined || Number.isNaN(v) ? fallback : v))
    .pipe(z.number().int().min(1));

/** `1`, `"1"`, `true`, `"true"`, `TRUE` all mean true. Anything else is false. */
const bool = (fallback) =>
  z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (v === undefined) return fallback;
      if (typeof v === "boolean") return v;
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      return fallback;
    });

const csv = (fallback) =>
  z
    .union([z.string(), z.undefined()])
    .transform((v) =>
      (v === undefined || v.trim() === ""
        ? fallback
        : v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
      )
    )
    .pipe(z.array(z.string()));

const envSchema = z
  .object({
    // ── process ────────────────────────────────────────────────────────────
    NODE_ENV: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : NODE_ENV_DEFAULT)),
    HOST: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "0.0.0.0")),
    PORT: port(5000),

    // ── database ───────────────────────────────────────────────────────────
    /**
     * Absent outside production. A missing URL is a warning in development and
     * a boot failure in production — that asymmetry is pre-existing behaviour
     * from `src/index.js` and is preserved exactly, so a developer with no DB
     * still gets a booting process and a visible warning.
     */
    DATABASE_URL: optionalString,
    DB_CONNECT_RETRIES: positiveInt(5),
    DB_CONNECT_RETRY_DELAY_MS: positiveInt(1000),

    // ── jwt ────────────────────────────────────────────────────────────────
    JWT_SECRET: optionalString,
    JWT_REFRESH_SECRET: optionalString,
    JWT_EXPIRES_IN: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "15m")),
    JWT_REFRESH_EXPIRES_IN: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "7d")),

    // ── http ───────────────────────────────────────────────────────────────
    /**
     * Comma-separated origin allow-list: `CORS_ORIGIN=https://a.com,https://b.com`.
     *
     * A list rather than a single value because "add the staging frontend" should be
     * a config change, not a deploy. Matching is exact — see `core/http/cors.js` for
     * why a suffix match is a security bug rather than a convenience.
     */
    CORS_ORIGIN: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "http://localhost:3000")),
    BODY_LIMIT: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "10mb")),
    TRUST_PROXY: bool(false),

    /**
     * M02 timeouts. Node's defaults are wrong behind an ALB: `headersTimeout`
     * is 60s against a 60s ALB idle timeout, and `requestTimeout` is 0 —
     * unlimited — which is a free Slowloris target. `KEEP_ALIVE_TIMEOUT` sits
     * *below* any load balancer's idle timeout so the LB, not the replica,
     * decides when to recycle the connection.
     */
    KEEP_ALIVE_TIMEOUT_MS: positiveInt(65_000),
    HEADERS_TIMEOUT_MS: positiveInt(66_000),
    REQUEST_TIMEOUT_MS: positiveInt(120_000),

    // ── rate limiting ──────────────────────────────────────────────────────
    // The counters are per-process: `express-rate-limit`'s `MemoryStore`, which is
    // what this deployment ships. Under N replicas the effective limit is N× the
    // value below and every deploy resets every counter — which is one of the
    // reasons the API is pinned to a single replica. See docs/runbook.md.
    // The values are the ones hard-coded in the pre-M01 `src/index.js`.
    RATE_LIMIT_WINDOW_MS: positiveInt(15 * 60 * 1000),
    RATE_LIMIT_MAX: positiveInt(100),
    AUTH_RATE_LIMIT_MAX: positiveInt(20),

    // ── logging ────────────────────────────────────────────────────────────
    LOG_LEVEL: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim().toLowerCase() : undefined))
      .pipe(z.enum(LOG_LEVELS).optional()),
    REQUEST_ID_HEADER: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim().toLowerCase() : "x-request-id")),
    LOG_REDACT: csv([
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.currentPassword",
      "req.body.newPassword",
      "req.body.otp",
      "req.body.token",
      "req.body.accessToken",
      "req.body.refreshToken",
      "res.headers.set-cookie",
    ]),

    // ── observability ──────────────────────────────────────────────────────
    METRICS_ENABLED: bool(true),
    METRICS_DEFAULT_PREFIX: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "amaken_api")),

    // ── cache ──────────────────────────────────────────────────────────────
    /**
     * Prefixed onto every key so two environments sharing one database cannot
     * collide, and so `invalidatePrefix("cache:property:")` cannot reach into
     * another app's keys. M06 reads this; M02 only defines it.
     */
    CACHE_PREFIX: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "amaken:")),
    CACHE_TTL_SECONDS: positiveInt(300),

    /**
     * Namespaces whose values are written to MySQL as well as held in memory.
     *
     * `otp` is the default and is not a performance setting: it holds
     * registration codes and password-reset tokens, which are single-use
     * credentials. A value one replica cannot see is a registration or a reset
     * that fails at random, so this namespace must live in the shared tier. See
     * `platform/cache/cache.js` for the argument and `docs/runbook.md` for the
     * operational consequence.
     *
     * `auth_token` (M03) is the same kind of credential: refresh-token rotation
     * records which `jti` each family has already spent. If a replica cannot read
     * the record, it cannot tell a first use from a replay, and refresh rotation
     * silently degrades to "no rotation" on that replica — the failure mode is a
     * token that is supposed to be dead still working, so it fails open and no
     * test notices. Same reasoning, same tier.
     *
     * A namespace added here must store JSON-safe values: the durable tier
     * round-trips through JSON.
     */
    CACHE_DURABLE_NAMESPACES: csv(["otp", "auth_token"]),

    // ── queue ──────────────────────────────────────────────────────────────
    QUEUE_ENABLED: bool(true),
    /**
     * Prefix on every job id, so two environments sharing one database cannot
     * collide on a de-duplicated enqueue — and so `flush()` from a test cannot
     * reach another environment's rows.
     */
    QUEUE_PREFIX: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "amaken")),
    /**
     * How long a worker waits between polls for new work. This is the
     * replacement for BullMQ's blocking `BRPOP`: a worker wakes at least this
     * often to notice SIGTERM and to reclaim an expired lease, so a smaller
     * value means a faster shutdown and a busier database.
     */
    QUEUE_POLL_INTERVAL_MS: positiveInt(1000),
    /**
     * How long a claimed job may stay `active` before another worker reclaims
     * it. Must exceed the slowest processor, or a long export is picked up twice.
     */
    QUEUE_LEASE_MS: positiveInt(60_000),
    /** Jobs one worker process runs at once. Bounds SMTP concurrency. */
    QUEUE_CONCURRENCY: positiveInt(5),
    /** Attempts before a job is marked `failed` and left for an operator. */
    QUEUE_ATTEMPTS: positiveInt(3),
    /**
     * Delay before the first retry. Exponential thereafter, so the third attempt
     * is roughly eight times further out than the first.
     */
    QUEUE_BACKOFF_MS: positiveInt(5000),
    /**
     * Rows a dead job may accumulate before the oldest are pruned. A poison
     * message that fails `QUEUE_ATTEMPTS` times is kept, because "the job that
     * never works" is what an operator needs to see; this only bounds the table.
     */
    QUEUE_MAX_DEAD_JOBS: positiveInt(500),

    // ── storage ────────────────────────────────────────────────────────────
    /**
     * Resolved to an absolute path at load time. `src/index.js` used to compute
     * this from its own `__dirname`; centralising it here means a worker or a
     * one-off script can be pointed at a different directory with an env var
     * instead of a code change.
     */
    UPLOAD_DIR: z
      .union([z.string(), z.undefined()])
      .transform((v) =>
        path.resolve(v && v.trim() !== "" ? v.trim() : path.join(ROOT, "public", "uploads"))
      ),

    // ── mail ───────────────────────────────────────────────────────────────
    SMTP_HOST: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "smtp.gmail.com")),
    SMTP_PORT: port(587),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    SMTP_FROM: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "no-reply@amakenrealestate.com")),
    SITE_NAME: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "Amaken Real Estate")),

    // ── admin ──────────────────────────────────────────────────────────────
    /**
     * Must match `admin.main` for the super-admin row.
     * `modules/admins`' `adminLogin` compares the two and exempts a matching
     * admin from the block check — which is the only way a blocked admin can sign
     * in again, since there is no admin unfreeze endpoint.
     */
    ADMIN_MAIN_PHONE: optionalString,

    // ── shutdown ───────────────────────────────────────────────────────────
    SHUTDOWN_TIMEOUT_MS: positiveInt(10_000),

    // ── response envelope ──────────────────────────────────────────────────
    // ── test harness ───────────────────────────────────────────────────────
    /**
     * Name the derived test database must have. `scripts/test-db.js` refuses
     * anything not ending in `_test`, and refuses a name equal to the database
     * `DATABASE_URL` already points at.
     */
    TEST_DB_NAME: z
      .union([z.string(), z.undefined()])
      .transform((v) => (v && v.trim() !== "" ? v.trim() : "amaken_db_test")),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const key of ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"]) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Missing required environment variable: ${key}`,
        });
      }
    }
  });

/**
 * Hard failures in production, warnings everywhere else.
 *
 * A development machine with no `.env` should still start — the original
 * `src/index.js` behaved that way and the contract tests depend on it — but it
 * must not start silently.
 */
const REQUIRED_IN_PRODUCTION = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];

module.exports = { envSchema, REQUIRED_IN_PRODUCTION, LOG_LEVELS, ROOT };
