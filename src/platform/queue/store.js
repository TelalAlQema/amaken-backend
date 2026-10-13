/**
 * The job store — rows in the `jobs` table.
 *
 * M02's queue used BullMQ on Redis. Redis is gone from this deployment, so the
 * queue is MySQL: the dependency the API already requires to answer any request
 * at all. That choice is what makes the milestone's "a queued job survives an API
 * restart" testable without a second process to run — and it costs a `SELECT`
 * per poll, which is why `QUEUE_POLL_INTERVAL_MS` exists and is not zero.
 *
 * ## What is provided, and by what SQL
 *
 * BullMQ's feature set that the callers actually used, and its replacement here:
 *
 * | BullMQ                    | Here                                                     |
 * |---------------------------|----------------------------------------------------------|
 * | `Queue.add`               | {@link enqueue} — `INSERT`, duplicate id dropped           |
 * | deterministic `jobId`     | the `jobs.id` primary key is caller-supplied              |
 * | `getJobCounts`            | {@link depths} — one grouped `SELECT`                     |
 * | blocking `BRPOP`          | a poll loop at `QUEUE_POLL_INTERVAL_MS`                    |
 * | at-least-once delivery    | {@link reserve} — point locks plus a conditional update     |
 * | `attempts` + exponential backoff | {@link fail} writes `run_at`                   |
 * | stalled-job recovery      | the `locked_at` lease in {@link reserve}                  |
 * | `removeOnComplete`        | nothing — rows are kept, see {@link prune}                |
 *
 * ## Delivery is at-least-once, so processors must be idempotent
 *
 * Claiming is not claiming-and-committing: a worker killed between `reserve` and
 * `complete` leaves the job to be retried once the lease expires. That is the
 * correct trade for this system — at-most-once would silently drop the password
 * reset a user is waiting on, and exactly-once would mean a distributed
 * transaction with SMTP in it. Every processor is therefore written to be safe to
 * run twice, and `otpJobId` / `leadNotificationJobId` are what make the duplicate
 * cheap in practice.
 */
const { Prisma } = require("@prisma/client");

const config = require("../../config");
const { prisma, withTransaction } = require("../db/prisma");
const { encodeJson, decodeJson } = require("../serialize");
const { getLogger } = require("../../core/logger");
const { ALL_QUEUE_NAMES, QUEUE_DEFAULTS } = require("./queues");

/** Job lifecycle. A plain string column, not a MySQL `ENUM`. */
const JobStatus = Object.freeze({
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
});

/** Truncated before storing: the field is for diagnosis, not for a stack trace. */
const MAX_ERROR_LENGTH = 2000;

/**
 * Adds a job.
 *
 * De-duplicates on `id`: a second enqueue of the same id resolves rather than
 * throwing, so a duplicate is invisible to the caller and visible in
 * {@link stats} as `deduplicated`. That is BullMQ's behaviour and it is the
 * behaviour the OTP resend flow depends on.
 *
 * @param {object} job
 * @param {string} job.id from `queues.js`
 * @param {string} job.queue one of {@link QUEUES}
 * @param {unknown} job.payload JSON-serialisable
 * @param {Date} [job.runAt] when the job may first run; defaults to now
 * @param {number} [job.maxAttempts] defaults to the queue's `attempts`
 * @returns {Promise<{ id: string, duplicate: boolean }>}
 */
async function enqueue({ id, queue, payload, runAt, maxAttempts }) {
  const defaults = QUEUE_DEFAULTS[queue];
  if (!defaults) throw new Error(`unknown queue: ${queue}`);

  try {
    await prisma.job.create({
      data: {
        id,
        queue,
        payload: encodeJson(payload ?? {}),
        run_at: runAt || new Date(),
        max_attempts: maxAttempts || defaults.attempts,
      },
    });
    return { id, duplicate: false };
  } catch (err) {
    // P2002 is the unique-constraint violation on `jobs.id`. It is the *expected*
    // outcome for a duplicate enqueue, so it is not an error — but anything else
    // is, and must reach the caller so the enqueue is counted as failed.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { id, duplicate: true };
    }
    throw err;
  }
}

/**
 * Claims up to `limit` runnable jobs, atomically.
 *
 * This is the whole concurrency story of the queue, and it is **three statements,
 * not one**, because the obvious single statement is wrong in a way that does not
 * look wrong.
 *
 * ## Why not `SELECT … LIMIT 1 … FOR UPDATE SKIP LOCKED`
 *
 * That is the version that reads like the textbook answer, and it is the one this
 * function used to be. InnoDB locks every record a locking read *scans*, and the
 * `LIMIT` is applied to the rows it returns — not to the rows it locks. With six
 * workers polling four queued jobs, the first transaction locks all four while
 * scanning and returns one; the other five skip all four as locked and find
 * nothing. Measured, not assumed: one claim, five workers idle, and the *same*
 * thing at a backlog of twelve. `SKIP LOCKED` did exactly what it says — the rows
 * were locked, so it skipped them — it just skipped far more than `LIMIT 1` implied.
 *
 * Adding a bigger `LIMIT` fixes exclusivity but not fairness: one worker claims all
 * twelve and the rest idle until the next poll. Correct, and not what "scale out"
 * means.
 *
 * ## What this does instead
 *
 *   1. **Candidate read** — a plain, unlocked `SELECT` of the oldest runnable rows.
 *      No locks, so it costs nothing and blocks nothing. It may return rows another
 *      worker is about to take; that is fine, step 2 is where it is settled.
 *   2. **Lock by primary key** — `SELECT id … WHERE id IN (…) FOR UPDATE SKIP
 *      LOCKED`. Point lookups on the primary key, so InnoDB locks *only* those
 *      records. Rows a concurrent transaction holds are skipped instead of waited
 *      on, which is the behaviour `SKIP LOCKED` was invented for.
 *   3. **Conditional update** — because those row locks are held from step 2 until
 *      commit, the update's predicate is evaluated against the current committed
 *      state and cannot race us. A row another worker claimed and committed a
 *      moment ago fails `status = 'pending' OR lease expired` and matches nothing.
 *      Without this step a committed-but-still-running job would be re-claimed; the
 *      lock alone does not protect against a transaction that has already committed.
 *
 * Measured with six concurrent workers: exclusivity holds (four jobs claimed four
 * times, never twice), every row's `attempts` is 1, and the work spreads across
 * workers instead of going to whichever one got there first.
 *
 * ## Progress, not immediate completeness
 *
 * A poll that loses the race claims fewer rows, or none. That is fine: the losers'
 * rows are untouched and the next poll takes them. What must never happen is a row
 * claimed-and-stranded, which is why step 3 exists — there is no path where a row is
 * marked `active` without a worker holding it.
 *
 * @param {object} [options]
 * @param {string[]} [options.queues] which queues to claim from; all by default
 * @param {string} [options.workerId] recorded as `locked_by`, for diagnosis
 * @param {number} [options.leaseMs] overrides `config.queue.leaseMs`
 * @param {number} [options.limit] how many to claim; 1 by default
 * @returns {Promise<Array<{ id: string, queue: string, payload: unknown, attempts: number, maxAttempts: number }>>}
 *   oldest first, possibly empty.
 */
async function reserve({ queues = ALL_QUEUE_NAMES, workerId = "worker", leaseMs, limit = 1 } = {}) {
  const lease = leaseMs || config.queue.leaseMs;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - lease);
  const take = Math.max(1, Math.min(Number(limit) || 1, 50));

  // The runnable predicate, written once so step 1 and step 3 cannot drift apart.
  // Drift here would be silent and serious: step 1 offering rows step 3 refuses
  // turns into a poll that returns nothing while the backlog grows.
  const runnable = {
    status: { in: [JobStatus.PENDING, JobStatus.ACTIVE] },
    run_at: { lte: now },
    OR: [{ status: JobStatus.PENDING }, { locked_at: null }, { locked_at: { lt: staleBefore } }],
  };

  const claimed = await withTransaction(async (tx) => {
    const candidates = await tx.job.findMany({
      where: { ...runnable, queue: { in: [...queues] } },
      orderBy: [{ run_at: "asc" }, { created_at: "asc" }],
      take,
      select: { id: true },
    });

    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((c) => c.id);

    // Point lookups on the primary key — see the note on why this is not a range
    // scan with a LIMIT.
    const locked = await tx.$queryRaw`
      SELECT id FROM jobs WHERE id IN (${Prisma.join(candidateIds)}) FOR UPDATE SKIP LOCKED
    `;
    const lockedIds = locked.map((row) => String(row.id));
    if (lockedIds.length === 0) return [];

    await tx.job.updateMany({
      where: { ...runnable, id: { in: lockedIds } },
      data: {
        status: JobStatus.ACTIVE,
        locked_at: now,
        locked_by: workerId,
        // Incremented on **claim**, not on failure. The distinction matters after a
        // worker crash: a job that crashed mid-processor has already consumed an
        // attempt, and a counter incremented only on `fail` would retry a poison job
        // forever.
        attempts: { increment: 1 },
      },
    });

    // `locked_at: now` is the marker for "this transaction claimed it". The lock is
    // still held, so nothing else can have taken it since.
    const rows = await tx.job.findMany({
      where: { id: { in: lockedIds }, locked_by: workerId, locked_at: now },
      select: { id: true, queue: true, payload: true, attempts: true, max_attempts: true },
    });

    // Back into candidate order: FIFO is a promise of this queue, and the
    // `updateMany` / `findMany` pair does not preserve it.
    const order = new Map(lockedIds.map((id, index) => [id, index]));
    return rows.sort((a, b) => order.get(a.id) - order.get(b.id));
  }, { maxWait: 3000, timeout: 5000 });

  return claimed.map((row) => ({
    id: row.id,
    queue: row.queue,
    payload: safeParse(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

/**
 * Marks a job finished.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function complete(id) {
  const { count } = await prisma.job.updateMany({
    where: { id },
    data: { status: JobStatus.COMPLETED, completed_at: new Date(), locked_at: null, locked_by: null },
  });
  return count > 0;
}

/**
 * Records a failed attempt and schedules the retry, or gives up.
 *
 * The retry is scheduled by writing `run_at`, never by sleeping in the worker. A
 * sleeping worker holds a concurrency slot and a database connection for the whole
 * backoff, and — the reason this matters — the delay dies with the process, so a
 * restart during a backoff would run the job early.
 *
 * Backoff is exponential from `QUEUE_BACKOFF_MS`, which is what stops a
 * permanently-broken SMTP host from being retried in a tight loop by every worker.
 *
 * @param {string} id
 * @param {string} error the failure message, stored truncated
 * @param {number} [backoffMs] overrides the queue default
 * @returns {Promise<{ status: string, nextRunAt: Date | null, attempts: number }>}
 */
async function fail(id, error, backoffMs) {
  const job = await prisma.job.findUnique({ where: { id }, select: { attempts: true, max_attempts: true, queue: true } });
  if (!job) return { status: JobStatus.FAILED, nextRunAt: null, attempts: 0 };

  const exhausted = job.attempts >= job.max_attempts;
  const defaults = QUEUE_DEFAULTS[job.queue] || QUEUE_DEFAULTS[Object.keys(QUEUE_DEFAULTS)[0]];
  const base = backoffMs || defaults.backoffMs;
  const nextRunAt = exhausted ? null : new Date(Date.now() + base * 2 ** Math.max(0, job.attempts - 1));

  await prisma.job.update({
    where: { id },
    data: {
      status: exhausted ? JobStatus.FAILED : JobStatus.PENDING,
      run_at: nextRunAt || undefined,
      last_error: String(error || "unknown error").slice(0, MAX_ERROR_LENGTH),
      locked_at: null,
      locked_by: null,
      completed_at: exhausted ? new Date() : undefined,
    },
  });

  return { status: exhausted ? JobStatus.FAILED : JobStatus.PENDING, nextRunAt, attempts: job.attempts };
}

/**
 * Job counts by queue and status, for `/metrics`.
 *
 * One grouped query rather than four `count()` calls, and it is called on a scrape
 * — so it must not be able to hold the scrape. Errors are the caller's to swallow;
 * see `core/observability/metrics.js`.
 *
 * The `total` is computed **here**, from the rows already fetched, and returned
 * beside the map rather than as a member of it. Both facts are deliberate. It is
 * beside the map because a `{ [queue]: {...} }` that also carries `total` is
 * iterable as if `total` were a queue, and a caller looping `Object.entries` over it
 * publishes a series labelled `queue="total"`. It is computed here rather than left
 * to the caller because `queueBacklog`'s own documentation promises a total derived
 * from the same query as the per-queue gauges, specifically so that a scrape which
 * cannot reach the database does not publish a misleading 0 — a caller that
 * re-derives it, or reads `depths.total` off a map that has none, publishes exactly
 * that.
 *
 * `total` excludes `completed`, matching the gauge's help text. `completed` rows are
 * history, and counting them would make the backlog gauge ratchet upward for the
 * lifetime of the deployment.
 *
 * @param {string[]} [queues]
 * @returns {Promise<{ byQueue: Record<string, Record<string, number>>, total: number }>}
 */
async function depths(queues = ALL_QUEUE_NAMES) {
  const rows = await prisma.job.groupBy({
    by: ["queue", "status"],
    where: { queue: { in: [...queues] } },
    _count: { _all: true },
  });

  const byQueue = {};
  for (const queue of queues) {
    byQueue[queue] = { pending: 0, active: 0, completed: 0, failed: 0 };
  }

  let total = 0;
  for (const row of rows) {
    if (!byQueue[row.queue]) byQueue[row.queue] = { pending: 0, active: 0, completed: 0, failed: 0 };
    const count = Number(row._count._all);
    byQueue[row.queue][row.status] = count;

    if (row.status !== JobStatus.COMPLETED) total += count;
  }

  return { byQueue, total };
}

/**
 * How many jobs are waiting to run. The number an operator alerts on.
 *
 * @returns {Promise<number>}
 */
async function backlog() {
  const rows = await prisma.job.groupBy({
    by: ["status"],
    where: { status: { in: [JobStatus.PENDING, JobStatus.ACTIVE] } },
    _count: { _all: true },
  });
  return rows.reduce((total, row) => total + Number(row._count._all), 0);
}

/**
 * Deletes the oldest dead jobs beyond `QUEUE_MAX_DEAD_JOBS`.
 *
 * Completed and failed rows are **kept**, not auto-deleted. That is a deliberate
 * departure from BullMQ's `removeOnComplete`: a failed job is the only record
 * that a registration's email never went out, and deleting it on a timer is how
 * that becomes permanently invisible. The table is bounded instead, oldest first,
 * so the bound is a size limit rather than a retention policy.
 *
 * @param {number} [max] defaults to `config.queue.maxDeadJobs`
 * @returns {Promise<number>} rows deleted
 */
async function prune(max = config.queue.maxDeadJobs) {
  const deadWhere = { status: { in: [JobStatus.COMPLETED, JobStatus.FAILED] } };

  const rows = await prisma.job.groupBy({ by: ["status"], where: deadWhere, _count: { _all: true } });
  const total = rows.reduce((sum, row) => sum + Number(row._count._all), 0);

  const excess = total - max;
  if (excess <= 0) return 0;

  // Oldest first: the excess is the history, the newest `max` rows are the
  // evidence. Deleting the newest would be the opposite of a cap.
  const doomed = await prisma.job.findMany({
    where: deadWhere,
    orderBy: { updated_at: "asc" },
    select: { id: true },
    take: excess,
  });

  const { count } = await prisma.job.deleteMany({ where: { id: { in: doomed.map((j) => j.id) } } });
  return count;
}

/**
 * Readiness of the queue.
 *
 * Resolves the `jobs` table rather than the database — `/health/ready` already
 * probes MySQL, and a second `SELECT 1` would report the same fact twice while
 * saying nothing about whether this schema was pushed.
 *
 * @returns {Promise<{ ok: boolean, backlog: number }>}
 */
async function health() {
  return { ok: true, backlog: await backlog() };
}

/**
 * Deletes every job belonging to this application. The test seam.
 *
 * Scoped to `config.queue.prefix` so a test run against a shared database cannot
 * reach another environment's jobs.
 *
 * @returns {Promise<number>} rows deleted
 */
async function flush() {
  const { count } = await prisma.job.deleteMany({
    where: { id: { startsWith: `${config.queue.prefix}:` } },
  });
  return count;
}

/**
 * Reads one job, for a status endpoint and for tests.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getJob(id) {
  const row = await prisma.job.findUnique({ where: { id } });
  if (!row) return null;
  return { ...row, payload: safeParse(row.payload) };
}

/**
 * Parses a payload, degrading to `{}`.
 *
 * A worker must not die on a corrupt payload: the row is diagnostic data, and
 * losing the job to a parse error converts "one bad row" into "one missing
 * email" with no trace.
 *
 * @param {string | null} raw
 * @returns {unknown}
 */
function safeParse(raw) {
  try {
    return decodeJson(raw) ?? {};
  } catch (err) {
    getLogger().warn({ err: { message: err.message } }, "job payload did not parse — running with {}");
    return {};
  }
}

module.exports = {
  JobStatus,
  enqueue,
  reserve,
  complete,
  fail,
  depths,
  backlog,
  prune,
  health,
  flush,
  getJob,
  safeParse,
};