/**
 * Process lifecycle.
 *
 * The only file in `src/` that binds a port, and one of exactly two that install
 * process signal handlers (`worker.js` is the other, with the same policy and its
 * own dependency order). `src/app.js` builds the app and nothing else; this file
 * decides when to start it and how to stop it.
 *
 * The retry loop that waits for MySQL is **not** here — it lives in
 * `platform/db/prisma.js`, because `worker.js` needs the identical budget and two
 * copies of a retry loop drift.
 *
 *     dotenv → config → connect DB → createApp() → listen → signals
 *
 * `config` is required first, and `config/index.js` is the module that calls
 * `dotenv.config()`. That ordering is the fix for [M00 finding
 * #1](../docs/milestones/M00-safety-net.md): the pre-M01 `src/index.js` called
 * `dotenv` *after* requiring the whole route graph, so `jwt.service` signed
 * every token with a literal committed to the repository.
 *
 * ## What is *not* here
 *
 * No Redis. M02's cache, rate limiter and queue originally all sat behind it; this
 * deployment has no Redis and no container runtime to start one, so the shared
 * tiers are MySQL rows and the rate limiter is per-process. What that costs is
 * listed in `docs/runbook.md` § *Deployment constraint: single replica* — and the
 * queue's worker is a second entry point, `src/worker.js`, with the same crash
 * policy and its own dependency order.
 */
const path = require("node:path");
const config = require("./config");
const { createApp } = require("./app");
const { createLogger } = require("./core/logger");
const { prisma, disconnect, connectDatabase } = require("./platform/db/prisma");
const queue = require("./platform/queue");
const { setDependencyUp, setDbPool, clearDbPool } = require("./core/observability");
const rateLimit = require("./core/http/rateLimit");

const logger = createLogger({ level: config.log.level, redact: config.log.redact });

/** @type {import("node:http").Server | null} */
let server = null;
/** Guards against a second signal re-entering the drain. */
let draining = false;

/** How often the pool gauge is refreshed. Independent of the scrape interval. */
const POOL_GAUGE_INTERVAL_MS = 15_000;

/**
 * Bounded graceful shutdown.
 *
*     stop accepting → in-flight finishes → queue → Prisma → exit
 *
 * The order is not arbitrary. Each step depends on the previous one still being
 * alive:
 *
 *   - **HTTP last-to-open, first-to-close.** `server.close()` stops new
 *     connections and waits for in-flight requests. That wait is the whole point:
 *     a request that has already reached a handler still needs its database, and
 *     still needs the cache for the OTP it is verifying.
 *   - **Queue before Prisma.** A request in flight may still enqueue a background
 *     email, and that enqueue is a database insert. Closing Prisma first turns it
 *     into a failed enqueue — which fails open, so it is survivable, but it is a
 *     mail that never gets sent, on every single deploy.
 *   - **Prisma last.** Every in-flight request needs it, and it is the
 *     dependency least likely to refuse a close.
 *
 * Bounded because a handler waiting on an unreachable database would otherwise
 * hold the process open until the orchestrator's kill timer fires — which is a
 * hard kill, and a hard kill during a deploy is a dropped request.
 *
 * Exits 0 on a clean SIGTERM/SIGINT. A failed dependency close sets 1, because a
 * drain that half-completed is a drain an operator needs to know about.
 *
 * @param {NodeJS.Timeout | string | null} signal
 * @param {number} timeoutMs
 * @returns {Promise<number>} the exit code.
 */
async function drain(signal, timeoutMs) {
  if (draining) return 0;
  draining = true;

  logger.info({ signal }, "shutdown requested, draining");

  const forced = setTimeout(() => {
    logger.error({ timeoutMs }, "drain timed out, exiting non-zero");
    process.exit(1);
  }, timeoutMs);
  forced.unref();

  const exitCode = await new Promise((resolve) => {
    if (!server) return resolve(0);

    server.close((err) => {
      if (err) {
        logger.error({ err: { message: err.message } }, "server close failed");
        return resolve(1);
      }
      logger.info("http server closed");
      resolve(0);
    });
  });

  let code = exitCode;

  // Each close is independent: a queue failure must not skip the Prisma close,
  // or the pool is left open and the process hangs until SIGKILL.
  const closers = [
    ["queue", () => queue.closeQueues()],
    ["prisma", () => disconnect()],
  ];

  for (const [name, close] of closers) {
    try {
      await close();
      logger.info(`${name} disconnected`);
    } catch (err) {
      logger.error({ err: { message: err.message } }, `${name} disconnect failed`);
      code = 1;
    }
  }

  clearTimeout(forced);
  return code;
}

/** Installs SIGTERM / SIGINT / the two process-level failure handlers. */
function installSignalHandlers() {
  process.on("SIGTERM", () => {
    drain("SIGTERM", config.http.shutdownTimeoutMs).then((code) => process.exit(code));
  });

  process.on("SIGINT", () => {
    drain("SIGINT", config.http.shutdownTimeoutMs).then((code) => process.exit(code));
  });

  // An unhandled rejection leaves the process in an unknown state: a partially
  // written transaction, a half-mutated cache, a job enqueued against a
  // connection that was closed mid-flight. Continuing to serve is not a
  // defensible response to that, so M02 drains and exits non-zero — the
  // orchestrator replaces a replica that is provably fine instead of one that
  // might, later, corrupt something.
  //
  // The distinction from `uncaughtException` is deliberate. A rejection is a
  // promise nobody awaited; the blast radius is usually one request, so the
  // bounded drain lets in-flight work finish before the process goes. An uncaught
  // exception means an invariant broke and the process's own state is no longer
  // trustworthy, so it exits immediately — see the handler below for why waiting
  // is actively harmful there.
  process.on("unhandledRejection", (reason) => {
    logger.fatal(
      { err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason } },
      "unhandled rejection"
    );
    drain("unhandledRejection", config.http.shutdownTimeoutMs).then((code) =>
      process.exit(code || 1)
    );
  });

  // An uncaught exception leaves the process *known* to be broken, and the
  // milestone's policy is deliberately asymmetric with `unhandledRejection`:
  // **log and exit immediately, no drain.**
  //
  // The asymmetry is the point. An unhandled rejection has a known cause and
  // usually a known blast radius — a single request's promise chain — so a bounded
  // drain lets the requests in flight finish and avoids turning one bad await into
  // a stream of 502s. An uncaught exception means control left a `try` it did not
  // expect to leave: an invariant broke, and the process is now running on state
  // nobody reasoned about. Draining in that state can complete a write that was
  // half-applied, and worse, it makes the exit *slow* — a drain waits up to
  // `SHUTDOWN_TIMEOUT_MS` for a process whose own state is untrustworthy, so a
  // crash-looping replica takes ten seconds to die on every iteration and
  // exhausts the orchestrator's restart budget before it takes one restart.
  //
  // Immediate `process.exit(1)`: the orchestrator replaces the replica, which is
  // the only thing that can make it correct again.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "uncaught exception");
    process.exit(1);
  });
}

/**
 * Applies the HTTP server timeouts.
 *
 * Node's defaults are wrong behind a load balancer, and wrong in a way that
 * produces two separate outages:
 *
 *   - `headersTimeout` defaults to **60s**, and a typical ALB idle timeout is
 *     also 60s. The race is lost or won by a millisecond, so a slowloris attack
 *     holds a socket open just long enough for the ALB to answer a client-side
 *     error while the replica keeps the connection. `headersTimeout` must sit
 *     *above* `keepAliveTimeout` — Node enforces that and throws if it does not,
 *     hence the clamp rather than two independent env vars.
 *   - `requestTimeout` defaults to **0**, which is unlimited: a client can hold a
 *     request open indefinitely and keep a handler (and a DB connection) tied up.
 *
 * `server.requestTimeout = 0` is deliberately never allowed: an unbounded request
 * timeout combined with a bounded drain means the drain's own timer fires while a
 * request is still running, which is the dropped-request case the drain exists to
 * prevent.
 *
 * @param {import("node:http").Server} httpServer
 * @param {object} cfg
 */
function applyTimeouts(httpServer, cfg) {
  // Node rejects `headersTimeout <= keepAliveTimeout`, so clamp rather than
  // trusting the two env vars to be ordered.
  const headers = Math.max(cfg.headersTimeoutMs, cfg.keepAliveTimeoutMs + 1000);

  httpServer.keepAliveTimeout = cfg.keepAliveTimeoutMs;
  httpServer.headersTimeout = headers;
  httpServer.requestTimeout = cfg.requestTimeoutMs;

  // 0 means "unlimited" in Node's own docs for this one too.
  httpServer.setTimeout(0);

  logger.info(
    {
      keepAliveTimeoutMs: httpServer.keepAliveTimeout,
      headersTimeoutMs: httpServer.headersTimeout,
      requestTimeoutMs: httpServer.requestTimeout,
    },
    "http timeouts applied"
  );
}

/**
 * Publishes the Prisma pool's occupancy on a timer.
 *
 * A timer rather than a scrape-time read because reading `$metrics()` on every
 * scrape adds a round-trip to a hot path, and because the gauge is useful
 * *between* scrapes when something is watching the metric in a dashboard. The
 * interval is `unref`'d so it cannot hold the process open at the end of a drain.
 *
 * @returns {NodeJS.Timeout}
 */
function startPoolGauge() {
  const publish = async () => {
    try {
      // `.json()`, not `$metrics()`. In Prisma 5.22 `$metrics` is an **object**
      // exposing `.json()` and `.prometheus()`, so calling it as a function throws
      // `is not a function` — which the catch below swallowed into a debug line,
      // leaving the pool gauges permanently at the 0 they are born with.
      setDbPool(await prisma.$metrics.json(), { prefix: config.metrics.prefix });
    } catch (err) {
      // A gauge that cannot be read is not worth a log line every 15 seconds
      // during an outage; the readiness probe already reports the database.
      logger.debug({ err: { message: err.message } }, "pool metrics unavailable");
      // …but the gauges must stop reporting. They are born at 0, and 0 open
      // connections is a confident-looking reading of something nobody measured.
      clearDbPool({ prefix: config.metrics.prefix });
    }
  };

  publish();
  const timer = setInterval(publish, POOL_GAUGE_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Boot. Exported so a test can drive the sequence without exiting the process.
 *
 * @returns {Promise<{ app: import("express").Application, server: import("node:http").Server }>}
 */
async function start() {
  // `config.db`, not `config`: `connectDatabase` lives in `platform/db/prisma`
  // because `worker.js` needs the identical retry budget, and it takes the `db`
  // sub-object rather than the whole config. Passing `config` here would silently
  // fall back to the schema's defaults, which is how the API and the worker end up
  // disagreeing about how long they wait for MySQL.
  await connectDatabase(config.db, { logger });
  setDependencyUp("mysql", true, { prefix: config.metrics.prefix });

  // The queue shares the API's own database, so opening it is not a connection
  // step — there is nothing to dial and nothing that can fail separately from the
  // `connectDatabase` above. It is still *opened*, so `/health/ready` and the boot
  // log report it as part of the API's surface rather than by inference.
  queue.open();

  const app = createApp({ config, logger });

  server = await new Promise((resolve, reject) => {
    const httpServer = app.listen(config.http.port, config.http.host, () => resolve(httpServer));
    httpServer.once("error", reject);
  });

  applyTimeouts(server, config.http);
  startPoolGauge();

  installSignalHandlers();

  logger.info(
    {
      port: config.http.port,
      host: config.http.host,
      env: config.env,
      node: process.version,
      metrics: config.metrics.enabled ? "/metrics" : "disabled",
      // Per-process, and therefore per-replica. Honest in the log because this is
      // the one part of M02 that did not become shared.
      rateLimitStore: rateLimit.storeName,
      queue: config.queue.enabled ? config.queue.prefix : "disabled",
      storage: config.paths.uploads,
      replicas: 1,
    },
    `API server listening on http://${config.http.host}:${config.http.port}`
  );

  // Loud, because it is the constraint most likely to be forgotten: everything
  // else in M02 scales out, this does not. See docs/runbook.md.
  logger.warn(
    { storage: config.paths.uploads },
    "uploads are on local disk — this replica must remain the only one until the S3 storage adapter lands"
  );

  return { app, server };
}

/**
 * True when this process was started to serve HTTP, as opposed to a test that
 * `require`d the module.
 *
 * `require.main === module` is **not** sufficient here, and the reason is the
 * shape of the entry point: `pnpm start` and `pnpm dev` run `node src/index.js`,
 * and that file is a one-line shim (`require("./server")`) precisely so no boot
 * logic lives in it. By the time this module evaluates, `module` is `server.js`
 * while `require.main` is `index.js`, so the identity test is **false** and
 * `start()` is never called.
 *
 * The failure mode that produces is worse than a crash: the process loads, prints
 * nothing, exits 0. Every deploy log reads as a clean shutdown, nothing serves
 * traffic, and the orchestrator's readiness probe is what eventually notices. So
 * the entry point is identified by *what it is*, not by a boolean the caller has
 * to remember to set.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  if (require.main === module) return true;
  return require.main?.filename === path.join(__dirname, "index.js");
}

if (isEntryPoint()) {
  start().catch((err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "failed to start");
    process.exit(1);
  });
}

module.exports = {
  start,
  drain,
  connectDatabase,
  installSignalHandlers,
  applyTimeouts,
  startPoolGauge,
  isEntryPoint,
  prisma,
  logger,
};
