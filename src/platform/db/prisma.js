/**
 * The Prisma client.
 *
 * One `PrismaClient` for the process ([ADR 0002](../../../docs/adr/0002-single-prisma-client-split-schema.md)):
 * one pool, one set of credentials, one thing to drain at shutdown. Splitting
 * the schema per module is a source-tree convention, not a runtime one.
 *
 * The client is cached on `globalThis` outside production. `node --watch`
 * re-evaluates every module on each change; without the cache each reload would
 * open a fresh pool and MySQL would exhaust `max_connections` after a handful of
 * edits. Tests do the same via `--watch`-free repeated `require`.
 *
 * Moved here from `src/lib/prisma.js` in M01. It is the first file in the
 * `platform/` layer and the reason that layer exists: this is the only code
 * permitted to talk to MySQL.
 */
const { PrismaClient } = require("@prisma/client");
const config = require("../../config");

const globalForPrisma = globalThis;

/**
 * Query logging is development-only. In production it is a per-query log line
 * for every request, and `query` events include the parameter values — which are
 * lead names, emails and phone numbers.
 */
const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.isDevelopment ? ["query", "error", "warn"] : ["error"],
  });

if (!config.isProduction) globalForPrisma.prisma = prisma;

/**
 * Liveness check for the database. Used by the boot sequence in `server.js` and
 * by `/health/ready` in M02.
 *
 * `SELECT 1` is the cheapest statement that still traverses the full
 * connect/query path, so it fails when the server is unreachable, the
 * credentials are wrong, or the connection is in `wait_timeout`.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function ping(timeoutMs = 5000) {
  let timer;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ping timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the connection pool. Must be called during shutdown — without it the
 * process exits with sockets still open and every deploy drops in-flight
 * requests.
 *
 * @returns {Promise<void>}
 */
async function disconnect() {
  await prisma.$disconnect();
  if (globalForPrisma.prisma === prisma) delete globalForPrisma.prisma;
}

/**
 * Run `fn` inside a transaction.
 *
 * The default is a bounded timeout because Prisma's interactive-transaction
 * default of 5s is exceeded by every bulk import, and an unbounded transaction
 * holds row locks until MySQL's `innodb_lock_wait_timeout` — 50s by default —
 * turning a slow query into a site-wide stall.
 *
 * @template T
 * @param {(tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>} fn
 * @param {{ maxWait?: number, timeout?: number, isolationLevel?: import("@prisma/client").Prisma.TransactionIsolationLevel }} [options]
 * @returns {Promise<T>}
 */
function withTransaction(fn, options = {}) {
  const { maxWait = 5000, timeout = 10_000, isolationLevel } = options;

  return prisma.$transaction(fn, {
    maxWait,
    timeout,
    ...(isolationLevel && { isolationLevel }),
  });
}

/**
 * Waits for MySQL, with retries.
 *
 * Lives here rather than in either entry point because **both** need it and
 * neither owns the connection: `server.js` and `worker.js` each have their own
 * lifecycle, and duplicating a retry loop between them is how the two end up with
 * different retry budgets — which looks like a database that is up for the API and
 * down for the worker.
 *
 * The app has no reason to serve a request it cannot answer: every endpoint except
 * `/health` and `/metrics` reads the database, and a cold replica answering 500s
 * for the first few seconds of every deploy is worse than not answering at all — a
 * load balancer will not wait for a port that is closed.
 *
 * Retries because in a container start the database is frequently a second
 * container, and "connection refused" in the first second is normal, not a failure.
 *
 * @param {{ connectRetries: number, connectRetryDelayMs: number }} cfg
 * @param {{ logger?: { error: Function, info: Function } }} [deps]
 * @returns {Promise<void>}
 * @throws the last error, after the retry budget is spent.
 */
async function connectDatabase(cfg, deps = {}) {
  const { connectRetries, connectRetryDelayMs } = cfg;
  // Imported lazily: `core/logger` is not a database concern, and requiring it at
  // module scope would make this module depend on the logger's config.
  const logger = deps.logger || require("../../core/logger").getLogger();

  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      await ping();
      logger.info({ attempt }, "database connected");
      return;
    } catch (err) {
      const last = attempt === connectRetries;
      logger.error(
        { attempt, connectRetries, err: { message: err.message, code: err.code } },
        last ? "database unreachable" : "database not ready, retrying"
      );
      if (last) throw err;
      await new Promise((resolve) => setTimeout(resolve, connectRetryDelayMs));
    }
  }
}

module.exports = { prisma, ping, disconnect, withTransaction, connectDatabase };
