/**
 * The queue worker entry point.
 *
 *     pnpm worker      # node src/worker.js
 *     pnpm worker:dev  # node --watch src/worker.js
 *
 * The second process in the deployment. It binds no port and serves no requests; it
 * claims jobs from `platform/queue` and runs them. `src/server.js` is the API, and
 * neither is permitted to start the other: the worker must be able to be restarted,
 * scaled or stopped without touching the API, and the API must survive the worker
 * being down (which it does — jobs simply queue).
 *
 *     config → connect DB → poll → signals
 *
 * `config` is required first for the same reason `server.js` does it: it is the
 * module that calls `dotenv.config()`, and everything else reads the frozen object
 * it exports.
 */
const config = require("./config");
const { createLogger } = require("./core/logger");
const { disconnect, connectDatabase } = require("./platform/db/prisma");
const { startWorker, stopWorker, stats } = require("./platform/queue/worker");

const logger = createLogger({ level: config.log.level, redact: config.log.redact });

let draining = false;

/**
 * Bounded graceful shutdown.
 *
 *     stop claiming → in-flight jobs finish → Prisma → exit
 *
 * The order is the same argument `server.js` makes, applied to a process with no
 * sockets. A job that has already been claimed needs the database to record its
 * outcome, so Prisma closes **after** the jobs rather than after the loop — closing
 * it first would make every in-flight job's `complete()` fail, and each failure
 * would be retried after the lease expires, for no reason other than shutting down.
 *
 * Bounded because the alternative is an orchestrator's hard kill, which strands
 * every in-flight job until its lease expires. Exits 0 on a clean signal; a failed
 * close sets 1, because a half-completed drain is one an operator needs to know
 * about.
 *
 * @param {NodeJS.Timeout | string | null} signal
 * @param {number} timeoutMs
 * @returns {Promise<number>} the exit code
 */
async function drain(signal, timeoutMs) {
  if (draining) return 0;
  draining = true;

  logger.info({ signal, ...stats() }, "shutdown requested, draining");

  const forced = setTimeout(() => {
    logger.error({ timeoutMs }, "worker drain timed out — in-flight jobs will be retried after their lease expires");
    process.exit(1);
  }, timeoutMs);
  forced.unref();

  let code = 0;

  try {
    // Waits for the running jobs. A job that will not finish inside `timeoutMs`
    // is left `active` with a `locked_at` in the past, and the next worker to poll
    // picks it up — recoverable, which is why this is bounded rather than open.
    await stopWorker();
  } catch (err) {
    logger.error({ err: { message: err.message } }, "stopping the worker loop failed");
    code = 1;
  }

  try {
    await disconnect();
    logger.info("prisma disconnected");
  } catch (err) {
    logger.error({ err: { message: err.message } }, "prisma disconnect failed");
    code = 1;
  }

  clearTimeout(forced);
  return code;
}

/**
 * Installs the signal handlers.
 *
 * The crash policy is **asymmetric on purpose**, and identical to the API's:
 *
 *   - `unhandledRejection` → drain, then exit non-zero. A rejection is a promise
 *     nobody awaited; its blast radius is usually one job, so letting the in-flight
 *     jobs finish first avoids turning one bad `await` into a queue-wide stall.
 *   - `uncaughtException` → log and exit immediately, no drain. An invariant broke
 *     and this process's state is no longer trustworthy; draining in that state can
 *     complete a write that was half-applied, and it makes the exit slow enough to
 *     exhaust an orchestrator's restart budget before it takes one restart.
 */
function installSignalHandlers() {
  const onSignal = (signal) => {
    drain(signal, config.http.shutdownTimeoutMs).then((code) => process.exit(code));
  };

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal(
      {
        err:
          reason instanceof Error
            ? { message: reason.message, stack: reason.stack }
            : { reason: String(reason) },
      },
      "unhandled rejection"
    );
    drain("unhandledRejection", config.http.shutdownTimeoutMs).then((code) =>
      process.exit(code || 1)
    );
  });

  process.on("uncaughtException", (err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "uncaught exception");
    process.exit(1);
  });
}

/**
 * Boot. Exported so a test can drive the sequence without exiting the process.
 *
 * @returns {Promise<{ stop: () => Promise<void>, workerId: string }>}
 */
async function start() {
  // The same retry budget as the API, from the same module, so the two cannot end
  // up disagreeing about how long they wait for MySQL — which looks like a database
  // that is up for the API and down for the worker.
  await connectDatabase(config.db, { logger });

  if (!config.queue.enabled) {
    // Not an error: a deployment may run an API-only replica pair and drain jobs
    // elsewhere. But silent is not acceptable — a worker that processes nothing
    // while reporting healthy is the worst of both.
    logger.warn("QUEUE_ENABLED=false — this worker will claim jobs and none will be written");
  }

  const handle = await startWorker();

  installSignalHandlers();

  logger.info(
    {
      node: process.version,
      env: config.env,
      backend: "mysql",
      prefix: config.queue.prefix,
      concurrency: config.queue.concurrency,
      pollIntervalMs: config.queue.pollIntervalMs,
    },
    `queue worker running as ${handle.workerId}`
  );

  return handle;
}

if (require.main === module) {
  start().catch((err) => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "worker failed to start");
    process.exit(1);
  });
}

module.exports = { start, drain, installSignalHandlers };