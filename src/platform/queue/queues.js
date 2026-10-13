/**
 * Queue names, per-queue defaults, and the deterministic job ids.
 *
 * Everything about *what* a queue is lives here, so `platform/queue/index.js`
 * (the producer API) and `platform/queue/worker.js` (the consumer) cannot
 * disagree about a name — and `test/unit/kernel.test.js` can assert that every
 * declared queue has a processor without enumerating either file.
 *
 * ## Why job ids are digests
 *
 * The `jobs.id` primary key is caller-supplied, and a second `INSERT` of the same
 * id is dropped. That is the queue's de-duplication, and it is what makes a
 * double-clicked "resend OTP" produce one email rather than two.
 *
 * Three properties the digests have to keep, each of which was a bug in some
 * version of this file:
 *
 *   1. **Case-folded input.** OTPs are cached against a lowercased address, so
 *      `A@B.com` and `a@b.com` must produce one job, not two.
 *   2. **The OTP code is part of the digest.** A resend overwrites the cached
 *      code and invalidates the previous one, so the new email must be a new job.
 *      Deduplicating on the address alone would drop exactly the mail the user
 *      asked for, leaving them with a code that no longer exists.
 *   3. **No raw input in the id.** An email address is user input; putting it in a
 *      primary key puts it in the table's index, in any log line that prints the
 *      id, and in `SHOW INDEX` output. The digest is 32 hex characters.
 */
const crypto = require("node:crypto");

const config = require("../../config");

/** Every queue in the system. The value is the `jobs.queue` column. */
const QUEUES = Object.freeze({
  OTP_EMAIL: "otp-email",
  LEAD_NOTIFICATION: "lead-notification",
  LEADS_EXPORT: "leads-export",
});

/**
 * Per-queue retry and concurrency policy.
 *
 * Read from config rather than hard-coded so an operator can lengthen SMTP
 * retries without a deploy, but declared here as the *shape* every queue must
 * have — the invariant the worker relies on is that a queue always exists in this
 * map, so there is no queue whose failure policy is "whatever".
 *
 * `concurrency` bounds SMTP: without it a burst of registrations opens one
 * connection per job and Gmail rejects the excess, turning a load spike into
 * bounced mail.
 */
const QUEUE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    Object.values(QUEUES).map((name) => [
      name,
      Object.freeze({
        attempts: config.queue.attempts,
        backoffMs: config.queue.backoffMs,
        concurrency: config.queue.concurrency,
      }),
    ])
  )
);

/**
 * A stable, opaque id.
 *
 * 16 hex characters of a SHA-256: 64 bits of collision resistance against the
 * handful of jobs this system enqueues, at a fixed width so the index stays
 * small. Truncated rather than full-length because the id is not a secret and
 * full-length buys nothing here.
 *
 * @param {string} scope the queue, so two queues cannot collide on identical input
 * @param {string} material the de-duplication input
 * @returns {string}
 */
function jobId(scope, material) {
  const digest = crypto.createHash("sha256").update(`${scope}\u0000${material}`).digest("hex");
  return `${config.queue.prefix}:${scope}:${digest.slice(0, 16)}`;
}

/**
 * The id for an OTP email.
 *
 * @param {string} to recipient address, case-insensitive
 * @param {string} purpose `"register"` or `"reset"`
 * @param {string} code the code that was just cached, so a resend is a new job
 * @returns {string}
 */
function otpJobId(to, purpose, code) {
  return jobId(QUEUES.OTP_EMAIL, `${String(to).trim().toLowerCase()}|${purpose}|${code}`);
}

/**
 * The id for an admin notification.
 *
 * `subject` is the thing being announced, not the recipient: a registration is
 * announced once per address, a lead once per lead row. A retried request that
 * submits the same lead twice therefore notifies once, and two different leads
 * from the same person are two notifications — which is what an admin wants.
 *
 * @param {string} subject
 * @returns {string}
 */
function leadNotificationJobId(subject) {
  return jobId(QUEUES.LEAD_NOTIFICATION, String(subject));
}

/**
 * The id for a leads export.
 *
 * @param {string} requestedBy who asked for it — an admin id, not a secret
 * @param {string} scope the filter the export was rendered with
 * @returns {string}
 */
function exportJobId(requestedBy, scope = "all") {
  return jobId(QUEUES.LEADS_EXPORT, `${requestedBy}|${scope}`);
}

/** Every queue name, for a `WHERE queue IN (…)` claim or a depth query. */
const ALL_QUEUE_NAMES = Object.freeze(Object.values(QUEUES));

module.exports = {
  QUEUES,
  QUEUE_DEFAULTS,
  ALL_QUEUE_NAMES,
  jobId,
  otpJobId,
  leadNotificationJobId,
  exportJobId,
};