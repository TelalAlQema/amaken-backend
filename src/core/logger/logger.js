/**
 * The pino instance.
 *
 * Replaces `morgan`, which wrote one unstructured line per request with no
 * correlation id and no stack ([M00 finding #8](../../../docs/milestones/M00-safety-net.md)).
 * Two things are non-negotiable here:
 *
 *  1. **Redaction.** Access tokens, cookies and passwords pass through this
 *     process. A log aggregator is a wider blast radius than the database, so
 *     they are removed at serialisation time rather than trusted not to be
 *     logged. The default path list covers the envelopes; extend it, do not
 *     trim it.
 *  2. **A request id on every line.** Without it a single failed request cannot
 *     be reconstructed from the log.
 *
 * This is the one module outside `src/config/` permitted to read
 * `process.env`, and only `NODE_ENV` and `LOG_LEVEL` — the level default is
 * chosen *here* because the logger must be constructible before `config` is
 * required (a module that logs during import would otherwise be unconstructible).
 * Everything else goes through `config.log`.
 */
const pino = require("pino");

const LEVEL_BY_ENV = Object.freeze({
  production: "info",
  test: "silent",
  development: "debug",
});

/**
 * Defaults when no explicit level is supplied.
 *
 * @param {string} [nodeEnv] defaults to `process.env.NODE_ENV`.
 * @param {string} [level] `LOG_LEVEL`, which wins over the environment default.
 * @returns {string}
 */
function defaultLevel(nodeEnv, level) {
  if (level) return level;
  return LEVEL_BY_ENV[nodeEnv || process.env.NODE_ENV] || "info";
}

/**
 * Paths pino removes from every object it serialises. Overridable, never
 * additive-only by accident: passing `redact` replaces the list, so a caller
 * that wants fewer redactions has to say so on purpose.
 */
const DEFAULT_REDACT = Object.freeze([
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
]);

/**
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {string} [options.name] service name, added as `name`.
 * @param {string[]} [options.redact]
 * @param {boolean} [options.pretty] human-readable output. Off by default: in a
 *   container the log is read by `docker logs` / a shipper, not a terminal.
 * @returns {import("pino").Logger}
 */
function createLogger(options = {}) {
  const { level, name, redact = DEFAULT_REDACT, pretty = false } = options;

  return pino({
    name: name || "amaken-api",
    level: defaultLevel(undefined, level),
    base: { service: name || "amaken-api" },
    redact: { paths: [...redact], censor: "[redacted]" },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // `pino-pretty` is not a dependency. A transport thread would be a second
    // thing to crash, and JSON is what every aggregator actually wants.
    ...(pretty ? { transport: { target: "pino-pretty" } } : {}),
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

module.exports = { createLogger, defaultLevel, DEFAULT_REDACT, LEVEL_BY_ENV };
