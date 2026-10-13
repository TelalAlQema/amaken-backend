/**
 * The composition root.
 *
 * `createApp()` returns an Express app. It does **not** call `listen`, does not
 * install a process signal handler, and does not own a connection pool. That is
 * the whole point of the split: the previous `src/index.js` did all six jobs at
 * once, which meant the only way to get an app for a test was to copy its
 * 100-line middleware chain into `test/helpers/app.js` and keep the copy
 * honest with a parity test. Now there is one definition, and a test is
 *
 *     const app = createApp();
 *     await request(app).get("/api").expect(200);
 *
 * `server.js` is the only file permitted to bind a port.
 *
 * Middleware order is load-bearing and is reproduced exactly as the pre-M01
 * `src/index.js` had it, with two additions:
 *   - request id + access logging moved to the very front, so *every* line
 *     including the ones before a route matches carries the id;
 *   - `/metrics`, which is infrastructure, not part of the `/api` surface.
 *
 * `src/routes` is mounted **unchanged**. M01 does not move routes; M03 onward
 * does. The M00 contract baseline is what proves this file did not change a
 * single response.
 */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");

const defaultConfig = require("./config");
const { errorHandler } = require("./middleware/errorHandler");
const defaultRoutes = require("./routes");
const { registerModules, MODULES } = require("./bootstrap/registerModules");
const { createLogger, setLogger, httpLogger } = require("./core/logger");
const { envelope, notFound } = require("./core/http");
const { resolveCorsOrigin } = require("./core/http/cors");
const { apiLimiter, authLimiter } = require("./core/http/rateLimit");
const { createHealthRouter } = require("./core/health");
const { observeRequest, routeLabel, getMetrics, metricsHandler } = require("./core/observability");
const { createOpenApiDocument } = require("./core/http/openapi");

/**
 * Terminal middleware: records duration and status for every completed request.
 *
 * Registered at the front and driven by the response's `finish` event, so the
 * measurement includes body parsing, static file serving and the error handler —
 * the whole thing the client actually waited for. The route pattern is read at
 * that point too, by which time the router has matched.
 */
function recordMetrics(config) {
  return (req, res, next) => {
    if (!config.metrics.enabled) return next();

    const startedAt = process.hrtime.bigint();

    res.once("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      observeRequest(
        {
          method: req.method,
          route: routeLabel(req),
          status: res.statusCode,
          durationSeconds,
        },
        { prefix: config.metrics.prefix }
      );
    });

    next();
  };
}

/**
 * @param {object} [deps]
 * @param {object} [deps.config] a validated config object; defaults to the
 *   process-wide frozen one from `src/config`.
 * @param {import("pino").Logger} [deps.logger] defaults to a logger built from
 *   `config.log`. Passing one captures the whole request path's output, which is
 *   how a test asserts on log lines.
 * @param {import("express").Router} [deps.routes] a different `/api` router, for
 *   a module-level test that mounts one manifest.
 * @returns {import("express").Application}
 */
function createApp(deps = {}) {
  const config = deps.config || defaultConfig;
  const routes = deps.routes || defaultRoutes;
  // M03. Injectable for the same reason `deps.routes` is: a module test mounts one
  // manifest without pulling in the rest of the route table.
  const modules = deps.modules;
  const logger =
    deps.logger || createLogger({ level: config.log.level, redact: config.log.redact });
  const corsOrigin = resolveCorsOrigin(config.http.corsOrigin);

  // Register as the process logger so a service that logs without an injection
  // point writes to the same destination, at the same level, as everything else.
  setLogger(logger);

  const app = express();

  // Behind an ALB, `X-Forwarded-For` is how express-rate-limit identifies a
  // client. Off by default: trusting the header without a proxy in front lets a
  // client forge its own address and walk around the rate limit.
  if (config.http.trustProxy) app.set("trust proxy", true);

  // ── correlation + access log ──────────────────────────────────────────────
  app.use(httpLogger({ logger, requestIdHeader: config.log.requestIdHeader }));
  app.use(recordMetrics(config));

  // ── security ──────────────────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  );

  // ── compression ───────────────────────────────────────────────────────────
  // Property list payloads are the reason: a page of 20 properties with images,
  // amenities and agent details is ~40KB of JSON that gzips to ~4KB.
  //
  // Before body parsing, so it wraps the parsers' output. Two exclusions, both
  // load-bearing:
  //   - `filter` skips anything already compressed. Sharp emits webp, and
  //     re-gzipping a webp costs CPU and gains nothing.
  //   - `threshold: 1024` because compressing a 200-byte 401 body costs more than
  //     it saves.
  //
  // Streaming responses (`res.flush`) bypass compression by design — an SSE or
  // `pipe` response must not be buffered. None exist today; this is the note for
  // whoever adds one.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers["x-no-compression"]) return false;
        const type = res.getHeader("Content-Type");
        if (typeof type === "string" && /^(image|video|audio)\//.test(type)) return false;
        return compression.filter(req, res);
      },
    })
  );

  // ── rate limiting ─────────────────────────────────────────────────────────
  // In-process by default. The counter is therefore per-replica and is reset by a
  // deploy — see `core/http/rateLimit.js` for the full trade, and
  // docs/runbook.md § *Deployment constraint: single replica* for why that is the
  // acceptable ceiling to leave in place.
  app.use("/api/", apiLimiter);
  app.use("/api/auth/", authLimiter);

  // ── body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: config.http.bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.http.bodyLimit }));
  app.use(cookieParser());

  // ── response helpers, so no route writes res.json ─────────────────────────
  app.use(envelope());

  // ── static uploads ────────────────────────────────────────────────────────
  // Local disk, which is the hard single-replica ceiling: see the runbook.
  app.use("/uploads", express.static(config.paths.uploads));

  // ── operational endpoints, not part of the /api surface ───────────────────
  // None are enveloped. See docs/architecture/envelope.md.
  //
  // Registered *after* the rate limiter so probes are never rate-limited: a
  // 60-second probe interval that returned 429 would make an orchestrator
  // declare the replica unhealthy and restart it in a loop. Registered before
  // `/api` so `/health/ready` never touches the route graph.
  app.use(createHealthRouter());

  if (config.metrics.enabled) {
    // Register the series up front so a scrape taken before the first request
    // still reports `up`, rather than an empty body.
    getMetrics({ prefix: config.metrics.prefix, collectDefaults: true });
    app.get("/metrics", metricsHandler({ prefix: config.metrics.prefix }));
  }

  app.get("/api", (_req, res) => {
    res.json({
      message: "Amaken Real Estate API",
      version: "0.1.0",
      docs: "/api/docs",
    });
  });

  const openApiDocument = createOpenApiDocument(MODULES);
  app.get("/api/docs", (_req, res) => res.json(openApiDocument));

  // ── registered modules ─────────────────────────────────────────────────────
  // M03. Mounted on the app, not on `routes`: a module's `mounts[].path` is the
  // path as the client sees it (`/api/auth`, including the `/api` prefix), so a
  // module never learns which prefix the host chose for anything else.
  //
  // Module manifests declare the entire API surface. The empty routes router stays
  // mounted as the migration seam until the registry cleanup in M08.
  registerModules(app, modules);

  // ── the API ───────────────────────────────────────────────────────────────
  app.use("/api", routes);

  // ── terminal ──────────────────────────────────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  app.locals.config = config;
  app.locals.logger = logger;

  return app;
}

module.exports = { createApp };
