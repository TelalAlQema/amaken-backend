/**
 * Health probes.
 *
 * Three endpoints, three different questions, and conflating them is the classic
 * way to turn a database blip into a site-wide outage:
 *
 * | Endpoint   | Question                          | Checks        | 503 when |
 * |------------|-----------------------------------|---------------|----------|
 * | `/health/live`  | is this process worth keeping? | nothing       | never    |
 * | `/health/ready` | can this process serve a request? | MySQL, queue, storage | any fails |
 * | `/health`       | legacy alias of `/health/live`   | nothing       | never    |
 *
 * Point **liveness at `/health/live`** and **readiness at `/health/ready`**.
 * Pointing liveness at readiness is the trap: a 60-second MySQL blip returns 503
 * from `/health/ready`, the orchestrator concludes the process is wedged, and it
 * restarts every replica simultaneously — turning a recoverable database problem
 * into an outage that the restarts themselves cause.
 *
 * `/health` stays as an alias because something already points at it (the M00
 * contract baseline, and any existing container healthcheck), and removing it
 * would be a silent outage of the thing monitoring the thing. Its body is
 * unchanged from M01.
 *
 * None of the three are enveloped — see `docs/architecture/envelope.md`. A probe
 * client parsing `{ success: true, data: … }` is a client that has to be
 * updated to read a health check, which is backwards.
 */
const config = require("../../config");
const { ping: pingDatabase } = require("../../platform/db/prisma");
const queue = require("../../platform/queue");
const { getStorage } = require("../../platform/storage");

/** Per-check timeout. Short: a probe that hangs is a probe that times out twice. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Runs `fn` with a hard deadline.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
function withTimeout(fn, timeoutMs = PROBE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
      // Deliberately **not** unref'd, unlike the deadlines in the cache and the
      // queue. There, the timer is a safety net on a request that is already being
      // held open by a socket. Here, the timer is the only thing standing between a
      // hung dependency and a probe that never answers — unref'ing it lets the loop
      // drain first, and the caller gets no response at all rather than a 503.
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * One dependency probe.
 *
 * The probe's contract is "resolves truthy when healthy", and `ok` is derived from
 * the **resolved value**, not from the absence of a throw. Those are different
 * things and the difference is the whole bug this function is written around:
 * `prisma.ping` resolves `false` on a dead socket and the storage adapter's
 * `health()` resolves `{ ok: false }`. A probe that only catches rejections
 * reports both as healthy — so a database that is refusing connections passes
 * `/health/ready`, and the orchestrator keeps sending traffic to a replica that
 * cannot answer.
 *
 * @param {string} name
 * @param {() => Promise<unknown>} fn resolves truthy when healthy, or `{ ok: true }`
 * @param {number} [timeoutMs]
 * @returns {Promise<{ name: string, ok: boolean, ms: number, error?: string }>}
 */
async function probe(name, fn, timeoutMs) {
  const startedAt = Date.now();

  try {
    const result = await withTimeout(fn, timeoutMs);

    // Two shapes are accepted, and nothing else:
    //
    //   - any truthy value  — the common case, e.g. `pingDatabase()` → `true`
    //   - `{ ok: true }`    — the storage adapter's structured answer
    //
    // Everything else is unhealthy, which includes the falsy values that a naive
    // "did it throw?" check waves through: `0` (a `SELECT 1` that matched nothing),
    // `""`, `NaN`, and `{ ok: false }`.
    //
    // A probe returning a bare count therefore has to wrap it — `{ ok: count > 0 }`.
    // That is not ceremony: it makes "healthy" something the probe states rather
    // than something `probe` infers from a value whose meaning it cannot know.
    const healthy = Boolean(
      typeof result === "object" && result !== null && "ok" in result ? result.ok : result
    );

    if (!healthy) {
      return {
        name,
        ok: false,
        ms: Date.now() - startedAt,
        // The resolved value is included because a probe returning something
        // unexpected is a bug in the probe, and the reason it read as unhealthy is
        // the whole diagnostic.
        error: `probe resolved ${JSON.stringify(result) ?? String(result)}`,
      };
    }

    return { name, ok: true, ms: Date.now() - startedAt };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - startedAt, error: err.message };
  }
}

/**
 * Full readiness check.
 *
 * Runs the probes **concurrently**. Sequentially, a dead dependency behind a 2s
 * timeout would delay the MySQL answer by 2s and the whole probe by 4s — longer
 * than most orchestrators' `periodSeconds`, which turns a check into a queue of
 * stale answers.
 *
 * ## What readiness checks, and what it deliberately does not
 *
 * The queue is checked, and it *fails* readiness when unhealthy, even though every
 * enqueue fails open. Those are not in conflict: fail-open is about not turning an
 * email delay into a failed registration, while readiness is about telling an
 * orchestrator that a replica is degraded. The operator needs the second far more
 * than the first, and a queue that silently stopped draining is exactly the failure
 * nobody notices for a week.
 *
 * The **rate limiter is not checked**, because it is in-process and there is
 * nothing to probe — it cannot be unhealthy. The honest statement about it is that
 * it does not yet scale with replicas, which is a documented constraint rather than
 * a health signal. See `docs/runbook.md`.
 *
 * @returns {Promise<{ ready: boolean, checks: object[] }>}
 */
async function readiness() {
  const [database, queueCheck, storage] = await Promise.all([
    probe("database", () => pingDatabase(PROBE_TIMEOUT_MS)),
    // `health()` already resolves `{ ok, backlog }`, the one shape `probe` accepts
    // besides a bare truthy value.
    probe("queue", () => queue.health()),
    probe("storage", () => getStorage().health()),
  ]);

  const checks = [database, queueCheck, storage];
  return { ready: checks.every((c) => c.ok), checks };
}

/**
 * Liveness. Synchronous by design — it checks the event loop is turning, which
 * it must be if this handler ran. Anything with an `await` here turns a liveness
 * probe into a readiness probe.
 *
 * @returns {{ status: string, uptimeSeconds: number }}
 */
function liveness() {
  return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
}

/**
 * Mounted at the **app root**, not at `/health`.
 *
 * That is not an accident of style. `app.use("/health", router)` makes the router
 * report `router.get("/")` as `/health/` — with a trailing slash — and
 * `test/contract/route-parity.test.js` walks the stack with
 * `scripts/route-table.js`, so the frozen baseline would change from `/health` to
 * `/health/` and every existing healthcheck would need a trailing slash. Declaring
 * the full paths keeps the M00 route table byte-identical and adds two entries.
 *
 * @returns {import("express").Router}
 */
function createHealthRouter() {
  // Required here rather than at module scope: `core/health/routes.js` is loaded
  // by `app.js`, which is loaded by tests, and the storage adapter should only be
  // built when a probe actually asks for it.
  const { Router } = require("express");
  const router = Router();

  // Legacy. Body is byte-identical to M01's `/health` — some external healthcheck
  // parses `{ status, timestamp }` and changing it would break that silently.
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  router.get("/health/live", (_req, res) => {
    res.json(liveness());
  });

  router.get("/health/ready", async (_req, res) => {
    const { ready, checks } = await readiness();

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not-ready",
      uptimeSeconds: Math.round(process.uptime()),
      checks,
      ...(config.isDevelopment && { prefix: config.metrics.prefix }),
    });
  });

  return router;
}

module.exports = { createHealthRouter, readiness, liveness, withTimeout, probe };
