/**
 * The OTP email job.
 *
 * Why it exists: SMTP has a multi-second tail, and before M02 that tail was in
 * the user's critical path. A registration used to be gated on a full SMTP
 * round-trip, so a slow mail server was a slow website and a failed one was a
 * registration that returned 500 having stored nothing the user could use. The
 * queue takes SMTP off the request; the retry policy means a transient failure no
 * longer loses the mail.
 *
 * The processor **throws** on failure, and that is the load-bearing line: it is how
 * "the mail did not go out" becomes a retry and then a visible `failed` row.
 *
 * **M04 removed the boolean.** This used to be
 *
 *     const sent = await emailService.sendOtpEmail(to, otp);
 *     if (!sent) throw new Error(…);
 *
 * which is a hand-rolled version of what an exception already does, and existed
 * only because `services/email.service` swallowed every send error and returned
 * `false`. The adapter in `platform/mail` now throws `MailDeliveryError` itself, so
 * the check below is gone and the throw is the adapter's. Retry behaviour is
 * unchanged: a failure throws either way, and the queue sees the same rejection.
 *
 * The import also moves from `services/` to `platform/mail`, which is the layering
 * fix: this file is in `platform`, and it was reaching up into a service.
 */
const config = require("../../../config");
const mail = require("../../mail");

/**
 * @param {object} payload
 * @param {string} payload.to recipient
 * @param {string} payload.otp the code, as cached by `auth.service.storeOtp`
 * @param {"register" | "reset"} payload.purpose
 * @returns {Promise<{ to: string, purpose: string }>}
 * @throws when SMTP reports a failure, so the job retries
 */
async function processOtpEmail({ to, otp, purpose }) {
  if (!to || !otp) {
    // A payload this shape is a bug in the producer, not a transient failure.
    // Throwing anyway costs three attempts and then surfaces it as a failed row,
    // which is where it belongs — silently completing would drop a registration
    // email with no trace anywhere.
    throw new Error(`otp-email job is missing ${!to ? "to" : "otp"}`);
  }

  if (purpose === "reset") {
    await mail.sendPasswordReset(to, otp);
  } else {
    await mail.sendOtp(to, otp);
  }

  return { to, purpose: purpose || "register", site: config.mail.siteName };
}

module.exports = { processOtpEmail };