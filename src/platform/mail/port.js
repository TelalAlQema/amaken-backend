/**
 * The mail port.
 *
 * This file is an **interface, not an implementation**, and it exists so that no
 * module ever learns that mail is SMTP. `platform/mail/nodemailer.js` is the
 * adapter; a transactional provider (SES, Postmark, Resend) would be a second
 * adapter and nothing above this line would change.
 *
 * ## Why the adapter throws instead of returning `false`
 *
 * The pre-M04 `services/email.service.js` caught every send failure and returned
 * `false`. Three separate bugs lived in that one decision:
 *
 *   1. `auth.service` ignored the return value, so a rejected OTP email produced a
 *      `200 OK` and a registration that could never be completed;
 *   2. the queue jobs had to *compensate* — `processOtpEmail` re-implemented the
 *      check and threw by hand, with a comment explaining that returning `false`
 *      would mark the job `completed` and lose the mail;
 *   3. `platform/queue/jobs/*` had to import from `services/`, which is a layering
 *      inversion: `platform` is below every module, and it was reaching up into a
 *      service.
 *
 * Throwing removes all three at once. A delivery failure is an exception because it
 * *is* one — the SMTP server refused the message — and the natural propagation
 * (up to the queue, which retries, or up to the route, which reports it) is what
 * every caller actually wanted. The jobs no longer branch on a boolean, because a
 * rejection never reaches them as a value.
 *
 * ## The interface
 *
 * Adapters implement:
 *
 *   sendOtp(to, otp)                          → void
 *   sendPasswordReset(to, otp)                → void
 *   sendAdminNotification(to, customerEmail)  → void
 *   health()                                  → { ok, adapter, detail? }
 *   close()                                   → Promise<void>
 *
 * Every method **throws {@link MailDeliveryError}** on failure. None returns a
 * status, and that is the point: a return value invites a caller to ignore it,
 * which is how this bug happened.
 */

/**
 * A message that SMTP would not accept.
 *
 * Separate from `core/errors`' `AppError` on purpose. An `AppError` is an HTTP
 * answer — it carries a status code and a code the client reads — and mail is
 * almost never the reason a request should fail with a 4xx: the user asked to reset
 * a password, not to send an email. Whether a delivery failure becomes a 502 or a
 * 200-with-a-queued-retry is the *caller's* decision, and it is a different decision
 * on every call site. This error says only "the mail did not go out", and carries
 * enough context to retry or to alert.
 *
 * Not extending `AppError` also keeps `core/errors` free of a mail concept: the
 * error vocabulary of the process should not grow a member that no HTTP status ever
 * maps to.
 */
class MailDeliveryError extends Error {
  /**
   * @param {string} message what was being sent — never the recipient's OTP
   * @param {{ to?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "MailDeliveryError";
    /** @type {string | undefined} the intended recipient, for logs. */
    this.to = details.to;
    /**
     * Kept as a separate field rather than only on `cause` so a logger can record
     * "delivery failed" without serialising whatever SMTP object came back — which
     * carries the full message, headers and sometimes the body.
     */
    this.reason = details.cause instanceof Error ? details.cause.message : undefined;
    this.retryable = true;
  }
}

/** Every method an adapter must implement. */
const REQUIRED_METHODS = Object.freeze([
  "sendOtp",
  "sendPasswordReset",
  "sendAdminNotification",
  "health",
  "close",
]);

/**
 * Throws unless `impl` satisfies the port.
 *
 * Called by every adapter's factory, so a missing method fails at **boot** rather
 * than on the first registration that happens to need it. The same reasoning as
 * `platform/storage`'s `assertAdapter`, and for the same reason: a partial adapter
 * that satisfies the interface structurally but not in substance is otherwise
 * discovered by a customer, mid-registration.
 *
 * @param {object} impl
 * @param {string} name
 * @returns {object} impl
 */
function assertMailer(impl, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof impl[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`mail adapter "${name}" is missing: ${missing.join(", ")}`);
  }
  return impl;
}

module.exports = { MailDeliveryError, assertMailer, REQUIRED_METHODS };