/**
 * `core/logger` — structured logging and request correlation.
 *
 * Replaces `morgan` plus the `console.error("Error:", err.message)` in the
 * error handler. Three pieces, composed by `src/app.js`:
 *
 *   1. `createLogger()` — a pino instance with redaction.
 *   2. `requestId()`   — mints or adopts the correlation id.
 *   3. `httpLogger()`  — both of the above plus pino-http's one-line-per-request
 *                        completion log.
 *
 * A module-level `getLogger()` exists so code with no injection point (a
 * service logging directly) still gets structured output. `src/app.js` calls
 * `setLogger()` with the config-derived instance, so a test that builds the app
 * with `createApp({ logger })` captures every line the request path emits.
 */
const pinoHttp = require("pino-http");

const { createLogger, defaultLevel, DEFAULT_REDACT, LEVEL_BY_ENV } = require("./logger");
const { requestId, acceptInboundId } = require("./requestId");

/** @type {import("pino").Logger | null} */
let logger = null;

/**
 * The process-wide logger, created on first use from `NODE_ENV` / `LOG_LEVEL`.
 * @returns {import("pino").Logger}
 */
function getLogger() {
  if (!logger) logger = createLogger();
  return logger;
}

/**
 * @param {import("pino").Logger | null} instance
 */
function setLogger(instance) {
  logger = instance;
}

/**
 * The two middlewares, in order. `genReqId` returns the id `requestId()` already
 * attached, so the id in the log is the same one the client was handed.
 *
 * The two noisy paths are ignored: `/health` is polled every few seconds by an
 * orchestrator and `/metrics` by a scraper, and both would drown the log.
 *
 * @param {object} [options]
 * @param {import("pino").Logger} [options.logger]
 * @param {string} [options.requestIdHeader]
 * @param {string[]} [options.ignorePaths]
 * @returns {import("express").RequestHandler[]}
 */
function httpLogger(options = {}) {
  const {
    logger: instance = getLogger(),
    requestIdHeader = "x-request-id",
    ignorePaths = ["/health", "/metrics"],
  } = options;

  const ignore = new Set(ignorePaths);

  return [
    requestId({ header: requestIdHeader }),
    pinoHttp({
      logger: instance,
      genReqId: (req) => req.id,
      customProps: (req) => ({ requestId: req.id }),
      // `/uploads` is served by express.static and its req object has no useful
      // body; the URL already identifies the asset.
      autoLogging: {
        ignore: (req) => ignore.has(req.url.split("?")[0]),
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  ];
}

module.exports = {
  createLogger,
  requestId,
  acceptInboundId,
  httpLogger,
  getLogger,
  setLogger,
  defaultLevel,
  DEFAULT_REDACT,
  LEVEL_BY_ENV,
};
