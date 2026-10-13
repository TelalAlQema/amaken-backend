/**
 * The queue worker.
 *
 * One process, started with `pnpm worker`. It owns no HTTP port and serves no
 * requests; it claims jobs and runs them.
 *
 * ## Why a separate process
 *
 * Because a job's runtime is not bounded. A TSV export over a large lead table, an
 * SMTP server that accepts connections and then stalls — running either inside the
 * API process means either the API stops answering or the queue stops draining.
 * `QUEUE_CONCURRENCY` in the API process would not fix that; it would just make
 * the coupling harder to see.
 *
 * It is a **separate** process rather than a thread because the API must be able
 * to restart without touching in-flight jobs, and a job's lease (`locked_at`)
 * makes that safe: an API restart is not a worker death, and a worker death is
 * recovered by the next poller.
 *
 * ## The loop
 *
 * BullMQ blocked on `BRPOP`. Here the worker polls at `QUEUE_POLL_INTERVAL_MS`,
 * claims with `FOR UPDATE SKIP LOCKED` (see `store.js`), and runs up to
 * `QUEUE_CONCURRENCY` jobs at once. Two properties matter and both are about
 * shutdown:
 *
 *   - **The sleep is interruptible.** A plain `setTimeout` would leave a worker
 *     asleep for a full interval after SIGTERM, which turns a 10-second drain into
 *     a 10-second drain for every deploy even when nothing is in flight.
 *   - **In-flight jobs are awaited, not abandoned.** `stop()` resolves when the
 *     last running job settles, bounded by `SHUTDOWN_TIMEOUT_MS`. Abandoning them
 *     is *recoverable* — the lease expires and another worker retries — but it
 *     costs a full lease interval of latency on a routine deploy.
 */
const config = require("../../config");
const { getLogger } = require("../../core/logger");
const store = require("./store");
const { QUEUES, QUEUE_DEFAULTS, ALL_QUEUE_NAMES } = require("./queues");
const { processOtpEmail } = require("./jobs/otp-email");
const { processLeadNotification } = require("./jobs/lead-notification");
const { processLeadsExport } = require("./jobs/leads-export");

/**
 * Every queue's processor.
 *
 * The map is the contract `test/unit/kernel.test.js` asserts: a queue with no
 * entry here is a queue whose jobs are claimed, run against `undefined`, thrown on
 * by TypeScript-free JS, and retried until they fail — so jobs sit in the table
 * looking exactly like jobs that succeeded.
 */
const PROCESSORS = Object.freeze({
  [QUEUES.OTP_EMAIL]: processOtpEmail,
  [QUEUES.LEAD_NOTIFICATION]: processLeadNotification,
  [QUEUES.LEADS_EXPORT]: processLeadsExport,
});

/** Identifies this worker in `jobs.locked_by`. Host + pid, so two replicas differ. */
const WORKER_ID = `${require("node:os").hostname()}:${process.pid}`;

let running = false;
let loopPromise = null;
let wakeSleep = null;

/** @type {Set<Promise<void>>} jobs currently executing */
const inFlight = new Set();

/** Counters for the process log and the `/metrics` bridge in the worker process. */
const counters = { claimed: 0, completed: 0, failed: 0, retried: 0 };

/** Idle polls since the last prune. */
let pruneCounter = 0;

/** How many idle polls between prunes. ~ once every 10 minutes at the default. */
const PRUNE_EVERY_POLLS = 600;

/**
 * A sleep that {@link stopWorker} can cut short.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, ms);

    // Not unref'd: this timer is the worker's heartbeat, and a worker that has
    // nothing to do must still be alive to claim the next job.
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

/**
 * Runs one claimed job and records the outcome.
 *
 * **Rejecting is a last resort, not a guarantee.** Every processor failure —
 * including a processor that is not a function — is turned into a job row state,
 * because an escaping rejection becomes an `unhandledRejection` in the worker
 * process, and `worker.js` drains and exits non-zero on those. One malformed
 * payload would take the worker down and every other job with it.
 *
 * It can still reject: the failure path calls `store.fail`, which itself queries
 * the database, so a database that is down *after* the processor failed rejects
 * here. That is a real inability to record the outcome, not a bug to swallow, and
 * the claim path catches it — counts the job failed, logs that it will be retried
 * when its lease expires, and carries on. The job is left `active` and the lease is
 * what recovers it.
 *
 * @param {{ id: string, queue: string, payload: unknown, attempts: number }} job
 * @returns {Promise<void>}
 */
async function runJob(job) {
  const logger = getLogger();
  const processor = PROCESSORS[job.queue];

  try {
    if (typeof processor !== "function") {
      throw new Error(`no processor registered for queue "${job.queue}"`);
    }

    const result = await processor(job.payload, job);
    await store.complete(job.id);
    counters.completed += 1;
    countMetric(job.queue, "completed");
    logger.info({ jobId: job.id, queue: job.queue, attempts: job.attempts, result }, "job completed");
  } catch (err) {
    const outcome = await store.fail(job.id, err.message);
    countMetric(job.queue, outcome.status);

    if (outcome.status === store.JobStatus.FAILED) {
      counters.failed += 1;
      logger.error(
        { jobId: job.id, queue: job.queue, attempts: job.attempts, err: { message: err.message } },
        "job failed permanently — no further attempts"
      );
    } else {
      counters.retried += 1;
      logger.warn(
        {
          jobId: job.id,
          queue: job.queue,
          attempts: job.attempts,
          nextRunAt: outcome.nextRunAt,
          err: { message: err.message },
        },
        "job attempt failed — retry scheduled"
      );
    }
  }
}

/**
 * Bridges a job outcome into the Prometheus registry.
 *
 * The registry lives in this process, so a worker running on its own host exposes
 * its own `/metrics`-worthy counters — scraped from the worker's own endpoint, or
 * simply read at exit. Required lazily: `core/observability` reads config, and the
 * worker already has.
 */
function countMetric(queue, outcome) {
  try {
    const { countQueueJob } = require("../../core/observability");
    // `result`, not `outcome`: the metric's label set is `{ queue, result }`, and a
    // wrong property name here does not throw — it silently writes
    // `result="unknown"`, which is the one label an alert on this counter can never
    // act on.
    countQueueJob({ queue, result: outcome });
  } catch {
    // Metrics are not worth failing a job over.
  }
}

/**
 * Claims a batch of jobs and starts them.
 *
 * Asks for the **whole remaining concurrency budget in one `reserve` call** rather
 * than one job per call. Two reasons, both measurable:
 *
 *   - Fewer transactions. Filling a budget of 5 was five round-trip pairs; it is one.
 *   - Fairness between workers. `store.reserve` takes a candidate read, locks by
 *     primary key and updates conditionally — see the note there on why a single
 *     `LIMIT … SKIP LOCKED` does not distribute work. Asking for the full budget is
 *     what lets several workers take several jobs each instead of one worker taking
 *     everything.
 *
 * @returns {Promise<number>} how many jobs were claimed and started
 */
async function claimMore() {
  if (!running) return 0;

  const budget = config.queue.concurrency - inFlight.size;
  if (budget <= 0) return 0;

  const jobs = await store.reserve({
    queues: ALL_QUEUE_NAMES,
    workerId: WORKER_ID,
    limit: budget,
  });

  for (const job of jobs) {
    counters.claimed += 1;

    // `runJob` handles its own failures, but its error path calls `store.fail` —
    // which itself queries the database, so a database that is down *after* the
    // processor failed rejects `runJob`. Unhandled, that becomes an
    // `unhandledRejection` in a process that drains and exits non-zero on those, so
    // one job and one outage would take the worker down for every other job's sake.
    const settled = runJob(job).catch((err) => {
      counters.failed += 1;
      getLogger().error(
        { jobId: job.id, queue: job.queue, err: { message: err.message } },
        "job outcome could not be recorded — it will be retried when its lease expires"
      );
    });

    inFlight.add(settled);
    settled.finally(() => inFlight.delete(settled));
  }

  return jobs.length;
}

/** One pass of the loop, including the dead-job prune. */
async function tick() {
  // A single pass fills the whole budget. A `while` loop around `claimMore` would
  // be the same work in more transactions, and would spin against the database when
  // another worker holds every candidate row.
  const claimed = await claimMore();

  // Every N-th pass rather than every pass: pruning is a `DELETE` and this loop
  // runs a few times a second.
  if (claimed === 0) {
    pruneCounter += 1;
    if (pruneCounter % PRUNE_EVERY_POLLS === 0) {
      const pruned = await store.prune();
      if (pruned > 0) getLogger().info({ pruned }, "pruned finished jobs");
    }
  }
}

/**
 * The polling loop.
 *
 * A failure in `tick` is caught and the loop continues: a database blip during a
 * poll must not end the worker, because the alternative is that nobody restarts it
 * and the queue silently stops draining until someone notices the backlog.
 */
async function loop() {
  while (running) {
    try {
      await tick();
    } catch (err) {
      getLogger().error({ err: { message: err.message } }, "queue poll failed — retrying next interval");
      await interruptibleSleep(config.queue.pollIntervalMs);
      continue;
    }

    if (!running) break;
    await interruptibleSleep(config.queue.pollIntervalMs);
  }
}

/**
 * Starts polling. Idempotent — a second call while running is a no-op rather than a
 * second loop, because two loops in one process would claim twice as fast and
 * double every concurrency setting.
 *
 * @returns {Promise<{ workerId: string, stop: () => Promise<void> }>}
 */
async function startWorker() {
  if (running) {
    getLogger().warn({ workerId: WORKER_ID }, "worker already running — ignoring start");
    return { workerId: WORKER_ID, stop: stopWorker };
  }

  running = true;
  pruneCounter = 0;
  loopPromise = loop();

  getLogger().info(
    {
      workerId: WORKER_ID,
      queues: ALL_QUEUE_NAMES,
      concurrency: config.queue.concurrency,
      pollIntervalMs: config.queue.pollIntervalMs,
      leaseMs: config.queue.leaseMs,
    },
    "queue worker started"
  );

  return { workerId: WORKER_ID, stop: stopWorker };
}

/**
 * Stops claiming and waits for in-flight jobs.
 *
 * Bounded by the caller's `SHUTDOWN_TIMEOUT_MS` — this function has no timer of
 * its own, because a drain that can time itself out but cannot be observed cannot
 * be reported honestly by whoever called it.
 *
 * @returns {Promise<void>} resolves when the last running job has settled
 */
async function stopWorker() {
  if (!running && !loopPromise) return;

  running = false;
  if (wakeSleep) wakeSleep();
  if (loopPromise) await loopPromise.catch(() => {});
  loopPromise = null;

  const pending = [...inFlight];
  if (pending.length > 0) {
    getLogger().info({ pending: pending.length }, "waiting for in-flight jobs to finish");
    await Promise.allSettled(pending);
  }

  getLogger().info({ ...counters }, "queue worker stopped");
}

/** Whether this process is polling. Used by `worker.js` and by tests. */
function isRunning() {
  return running;
}

/** The worker's counters, for a status endpoint or a test. */
function stats() {
  return { ...counters, inFlight: inFlight.size, running, workerId: WORKER_ID, queues: ALL_QUEUE_NAMES };
}

module.exports = {
  PROCESSORS,
  QUEUE_DEFAULTS,
  WORKER_ID,
  startWorker,
  stopWorker,
  isRunning,
  stats,
  runJob,
};