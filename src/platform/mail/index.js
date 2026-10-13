/**
 * `platform/mail` — the one place the application is allowed to send mail.
 *
 * M04 splits mail into a **port** (`port.js`) and an **adapter** (`nodemailer.js`)
 * and this module is the single resolved instance. The rule it enforces: nothing
 * outside `platform/mail/` imports `nodemailer`, and nothing outside it needs to
 * know that mail is SMTP at all.
 *
 * ## Why that matters here specifically
 *
 * Before M04 the mail code was in `services/email.service.js`, and the only two
 * callers were **queue jobs** — which meant `platform/queue/jobs/*.js` imported
 * from `services/`. That is the layering arrow backwards: `platform` is the bottom
 * layer, below every module, and it was reaching up into a service. Nothing about
 * that import was illegal, and that is the failure — it looked completely ordinary.
 *
 * The two callers are unchanged in intent and now read
 * `require("../../mail")`, which is what they should always have read.
 *
 * @see ./port.js for the interface and `MailDeliveryError`
 * @see ./nodemailer.js for the current implementation
 */
const config = require("../../config");
const { MailDeliveryError } = require("./port");
const { createNodemailerMailer } = require("./nodemailer");

/** @type {object | null} */
let mailer = null;

/**
 * The resolved adapter. Lazily built, like `platform/storage`'s, so a process that
 * only serves `/health` opens no SMTP connection and reads no credentials.
 *
 * @returns {object}
 */
function getMailer() {
  if (!mailer) mailer = createNodemailerMailer();
  return mailer;
}

/**
 * Test seam — points the process at a stub adapter.
 *
 * Exists for the same reason `platform/storage.setStorage` does: SMTP is the one
 * dependency with no local implementation, so the only way to test a failure path
 * without a live server is to substitute the whole adapter.
 *
 * @param {object | null} adapter `null` restores the real one.
 * @returns {object | null} the previous adapter
 */
function setMailer(adapter) {
  const previous = mailer;
  mailer = adapter;
  return previous;
}

/**
 * `POST /verify-email` — the registration code.
 *
 * @param {string} to
 * @param {string} otp
 * @returns {Promise<void>}
 * @throws {MailDeliveryError}
 */
async function sendOtp(to, otp) {
  return getMailer().sendOtp(to, otp);
}

/**
 * `POST /forgot-password` — the reset code.
 *
 * @param {string} to
 * @param {string} otp
 * @returns {Promise<void>}
 * @throws {MailDeliveryError}
 */
async function sendPasswordReset(to, otp) {
  return getMailer().sendPasswordReset(to, otp);
}

/**
 * The admin inbox notification for a new registration or lead.
 *
 * @param {string} to the admin mailbox
 * @param {string} customerEmail
 * @returns {Promise<void>}
 * @throws {MailDeliveryError}
 */
async function sendAdminNotification(to, customerEmail) {
  return getMailer().sendAdminNotification(to, customerEmail);
}

module.exports = {
  // the port
  MailDeliveryError,
  // the resolved adapter
  getMailer,
  setMailer,
  // helpers. Deliberately not re-exporting config.mail.siteName: a caller that
  // needs the site name for something other than a subject line is a caller that
  // should be building a message, and only an adapter may do that.
  sendOtp,
  sendPasswordReset,
  sendAdminNotification,
  // re-exported for the one caller that has a legitimate use: `lead-notification`
  // reports which mailbox it notified. See the note there.
  adminMailbox: () => config.mail.user,
};