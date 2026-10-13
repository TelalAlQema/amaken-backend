/**
 * The admin lead/registration notification job.
 *
 * The admin inbox is told about a new registration or a new property enquiry
 * off the request path, for the same reason as the OTP email: SMTP latency is not
 * something a "I would like to view this property" form submission should be
 * waiting on, and the pre-M02 code did both — it awaited the send *and* scanned
 * the lead table synchronously inside the request.
 *
 * `lead.service.submitLead` commits the lead row **before** enqueueing, so a
 * worker that picks the job up immediately still sees the row.
 *
 * M04: the import moves from `services/email.service` to `platform/mail`, and the
 * `if (!sent) throw` goes away with the boolean the old adapter returned. A
 * delivery failure now arrives as a `MailDeliveryError` from the adapter, which is
 * the same throw the queue retried before — the retry policy is unchanged.
 */
const config = require("../../../config");
const mail = require("../../mail");

/**
 * @param {object} payload
 * @param {"lead" | "registration"} payload.kind
 * @param {string} payload.leadId the lead row's id, or the address for a registration
 * @param {string} payload.email the customer's address
 * @returns {Promise<{ to: string, kind: string, subject: string }>}
 * @throws when SMTP reports a failure, or when there is nowhere to send it
 */
async function processLeadNotification({ kind, leadId, email }) {
  // The admin mailbox is the SMTP account itself. There is no separate
  // "notification address" config key, and adding one here would mean a second
  // source of truth for a value that has never existed.
  //
  // Read from `config` rather than `mail.adminMailbox()`: this is a *check* on
  // whether the deployment has an SMTP account at all, which is a configuration
  // question, and the config key is the honest place to ask it. `adminMailbox()`
  // exists for a caller that wants to display the address, not gate on it.
  const adminEmail = config.mail.user;

  if (!adminEmail) {
    // Not retryable: no number of attempts will produce SMTP_USER. Failing loudly
    // is the point — the alternative is a silent inbox that stopped being told
    // about leads, which is the failure mode M00.8 was about.
    throw new Error("SMTP_USER is not configured — lead notifications have nowhere to go");
  }

  if (!email) {
    throw new Error(`lead-notification job for ${kind || "lead"} ${leadId} has no customer email`);
  }

  await mail.sendAdminNotification(adminEmail, email);

  return { to: adminEmail, kind: kind || "lead", subject: String(leadId) };
}

module.exports = { processLeadNotification };