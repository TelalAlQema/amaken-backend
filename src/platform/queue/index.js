/**
 * `platform/queue` — the producer API.
 *
 * Everything a caller outside this directory needs:
 *
 *     const queue = require("../platform/queue");
 *     await queue.enqueueOtpEmail({ to, otp, purpose: "register" });
 *
 * `services/auth.service.js` and `services/lead.service.js` require only this
 * file. They never see a queue name, a job id, the `jobs` table, or the retry
 * policy — which is what lets M05 add a fourth queue without touching a route.
 *
 * ## Fail-open is the defining behaviour
 *
 * **Every enqueue resolves; none of them throw.** An enqueue is a side effect on a
 * request that has already succeeded at something the user cares about — their lead
 * is recorded, their OTP is stored — and turning a background-email hiccup into a
 * `500` on the submission would be strictly worse for the user than a late email.
 * So a failed enqueue logs, counts itself in {@link stats}, and returns `null`.
 *
 * The cost is that a dropped enqueue is silent, which is why it is counted and why
 * `amaken_api_queue_enqueue_errors_total` exists. "Fail open" without a counter is
 * just "lose data quietly".
 *
 * ## The deadline
 *
 * Each enqueue is wrapped in a deadline, because the enqueue is on the request
 * path and a database that is slow rather than *down* would otherwise hold a
 * request open for its own timeout. With Redis this was not optional —
 * `maxRetriesPerRequest: null` means an un-deadlined enqueue against a dead Redis
 * never settles, and the request hangs instead of degrading. With MySQL the
 * deadline is defensive rather than corrective, and it is kept because the failure
 * it guards against is identical: the API's promise that a background email cannot
 * hold a registration open.
 *
 * ## No Redis, and what that costs
 *
 * M02's queue was BullMQ on Redis. Redis is not in this deployment, so the queue is
 * rows in MySQL. The consequences are listed honestly in `store.js`; the one an
 * operator feels is that the queue shares a fate with the API's database, so a
 * database outage stops background work as well as requests.
 */
const config = require("../../config");
const store = require("./store");
const { QUEUES, QUEUE_DEFAULTS, ALL_QUEUE_NAMES, otpJobId, leadNotificationJobId, exportJobId } =
  require("./queues");
const { getLogger } = require("../../core/logger");

/**
 * Deadline for a single enqueue. Not configurable: it is a property of the
 * request path's patience, not a knob, and a knob here is how "email is slow"
 * turns into "the whole site is slow" for someone with an afternoon to tune it.
 */
const ENQUEUE_DEADLINE_MS = 2000;

/** Enqueue attempts in this process, for `/metrics` and the boot log. */
const enqueueStats = {
  enqueued: 0,
  deduplicated: 0,
  enqueueErrors: 0,
  skippedDisabled: 0,
};

/** Whether the API has opened the queue. Reported by `/health/ready`. */
let opened = false;

/**
 * Resolves `promise`, or rejects after `ms`.
 *
 * The timer is `unref`'d so a pending deadline cannot hold the process open at the
 * end of a drain. The underlying promise is **not** cancelled — Prisma has no
 * cancel — so it settles later into the void; its rejection is already handled by
 * the `catch` in {@link enqueue}, which is why leaving it dangling is safe here and
 * would not be if the deadline were added somewhere else.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label for the timeout message
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`enqueue timed out after ${ms}ms (${label})`)), ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The one place a job is written.
 *
 * @param {{ id: string, queue: string, payload: object, runAt?: Date }} job
 * @returns {Promise<{ id: string, duplicate: boolean } | null>} `null` when the
 *   enqueue failed. Never throws.
 */
async function enqueue(job) {
  if (!config.queue.enabled) {
    enqueueStats.skippedDisabled += 1;
    return null;
  }

  try {
    const result = await withDeadline(store.enqueue(job), ENQUEUE_DEADLINE_MS, job.queue);

    if (result.duplicate) {
      enqueueStats.deduplicated += 1;
    } else {
      enqueueStats.enqueued += 1;
    }

    return result;
  } catch (err) {
    enqueueStats.enqueueErrors += 1;
    getLogger().error(
      { queue: job.queue, jobId: job.id, err: { message: err.message } },
      "enqueue failed — continuing without the background job"
    );
    try {
      const { countQueueEnqueueError } = require("../../core/observability");
      countQueueEnqueueError({ queue: job.queue });
    } catch {
      // A metric must never be the reason a request fails.
    }
    return null;
  }
}

/**
 * Queues an OTP email.
 *
 * @param {{ to: string, otp: string, purpose?: string }} payload
 * @returns {Promise<object|null>}
 */
function enqueueOtpEmail({ to, otp, purpose = "register" }) {
  return enqueue({
    id: otpJobId(to, purpose, otp),
    queue: QUEUES.OTP_EMAIL,
    // The code is in the payload, not looked up from the cache by the worker: a
    // resend between enqueue and execution overwrites the cached code, and a
    // worker that read the cache would email the *new* code from the old job —
    // the one email that arrives is the one that stops working.
    payload: { to, otp, purpose },
  });
}

/**
 * Queues an admin notification about a new registration or lead.
 *
 * @param {{ kind: string, leadId: string | number, email: string, propertyId?: number }} payload
 * @returns {Promise<object|null>}
 */
function enqueueLeadNotification({ kind, leadId, email, propertyId }) {
  // De-duplicates on the thing being announced. A retried `submitLead` notifies
  // once; two different leads from the same address notify twice.
  const subject = kind === "registration" ? `registration:${email}` : `lead:${leadId}`;
  return enqueue({
    id: leadNotificationJobId(subject),
    queue: QUEUES.LEAD_NOTIFICATION,
    payload: { kind, leadId, email, propertyId },
  });
}

/**
 * Queues a TSV export.
 *
 * Not called by any route yet — M05 replaces `GET /api/admin/leads/export` with a
 * `202` and a job id, and that endpoint's contract is pinned by the M00 baseline.
 * It exists here so M05 is an edit to one route rather than a new subsystem.
 *
 * @param {{ mode?: string, from?: string, to?: string, page?: number, limit?: number, requestedBy: string }} payload
 * @returns {Promise<object|null>}
 */
function enqueueLeadsExport({ mode, from, to, page, limit, requestedBy }) {
  const scope = JSON.stringify({ mode: mode || "all", from: from || null, to: to || null });
  return enqueue({
    id: exportJobId(requestedBy, scope),
    queue: QUEUES.LEADS_EXPORT,
    payload: { mode, from, to, page, limit },
  });
}

/**
 * Marks the queue as open. Called by `server.js` at boot so `/health/ready` and
 * `/metrics` can report on it; the store itself has no connection state to report,
 * because it is the API's own database.
 */
function open() {
  opened = true;
}

/**
 * Releases the queue's side of the drain.
 *
 * There is nothing to close — the API holds no dedicated connection and the shared
 * Prisma pool is closed by `platform/db/prisma` afterwards — but the drain calls
 * this unconditionally so a future adapter with a real handle does not need a
 * separate code path, and so the boot log can assert the queue was closed.
 */
async function closeQueues() {
  opened = false;
}

/**
 * Records that a process (the API, or a test) is holding the queue open.
 * @returns {boolean}
 */
function isOpen() {
  return opened;
}

/**
 * Readiness of the queue.
 *
 * @returns {Promise<{ ok: boolean, backlog: number }>}
 */
function health() {
  return store.health();
}

/**
 * Enqueue counters, for `/metrics` and the boot log.
 *
 * @returns {{ enqueued: number, deduplicated: number, enqueueErrors: number, skippedDisabled: number }}
 */
function stats() {
  return { ...enqueueStats };
}

/**
 * Resets the counters. The test seam.
 *
 * @returns {void}
 */
function resetStats() {
  enqueueStats.enqueued = 0;
  enqueueStats.deduplicated = 0;
  enqueueStats.enqueueErrors = 0;
  enqueueStats.skippedDisabled = 0;
}

module.exports = {
  // producer API
  enqueue,
  enqueueOtpEmail,
  enqueueLeadNotification,
  enqueueLeadsExport,
  // lifecycle
  open,
  closeQueues,
  isOpen,
  health,
  stats,
  resetStats,
  // names, so a caller can log a queue name without reaching into ./queues
  QUEUES,
  QUEUE_DEFAULTS,
  ALL_QUEUE_NAMES,
  // the store, for the worker and for tests. Not part of the caller-facing API.
  store,
  // internals a test needs and a caller does not
  withDeadline,
  ENQUEUE_DEADLINE_MS,
};