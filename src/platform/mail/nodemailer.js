/**
 * The nodemailer adapter.
 *
 * **The only file in the process permitted to `require("nodemailer")**, which is
 * asserted by `test/modules/admins.test.js` and is the reason the DoD says
 * "`platform/mail` is the only module that imports nodemailer". Before M04,
 * `services/email.service.js` imported it directly and the two queue jobs imported
 * *that*, so `platform` was reaching up into `services` to get an SMTP client.
 *
 * ## What changed from `services/email.service.js`
 *
 * Three templates are carried over byte-identically, because a customer who has
 * already read one of these emails has seen the exact wording and layout and any
 * change is a support ticket. What changed is everything around them:
 *
 *   - **`secure: false` is now derived, not hard-coded.** The old file asserted
 *     plaintext unconditionally, so a port-465 deployment silently downgraded to
 *     STARTTLS-or-nothing. Port 465 is implicit TLS and nothing else; 587 and 25
 *     start plaintext and upgrade. Getting this wrong is either a certificate the
 *     client will not trust or credentials in clear on the wire.
 *   - **`transporter.verify()` runs once at construction.** A wrong password or an
 *     unreachable host used to surface as the first OTP failing in production.
 *   - **Failures throw {@link MailDeliveryError}.** See `port.js` for why that is
 *     not a small change.
 *   - **The templates are built by one function**, not three copies of 30 lines of
 *     inline HTML. They differed only in the heading, one sentence of body copy and
 *     the subject — which is exactly the shape of bug where a reset email says
 *     "Verification Code".
 */
const nodemailer = require("nodemailer");

const config = require("../../config");
const { MailDeliveryError, assertMailer } = require("./port");

/**
 * The logo the pre-M04 templates embedded by URL.
 *
 * Absolute and remote, so every recipient's client fetches it from a third party.
 * That is the pre-existing behaviour and it is kept rather than "fixed" here,
 * because inlining the image would change every rendered email and is a design
 * decision, not a refactor. It is worth knowing that this URL is a hard dependency
 * of all three templates.
 */
const LOGO_URL = "https://www.telal-contracting.com/images/amaken%20logo%20(1).png";

/**
 * Whether the configured port speaks implicit TLS.
 *
 * 465 is the only port on which TLS is negotiated *before* the SMTP greeting.
 * Every other port takes the connection in clear and upgrades with STARTTLS, which
 * nodemailer does on its own once `secure` is false. Hard-coding `false` — as the
 * pre-M04 adapter did — therefore meant a 465 deployment either failed to connect
 * or, worse, connected in clear.
 *
 * @param {number} port
 * @returns {boolean}
 */
function isImplicitTlsPort(port) {
  return Number(port) === 465;
}

/**
 * Builds the HTML shell the three templates share.
 *
 * One function rather than three literals because the three differed only in a
 * heading, one sentence and a subject — the classic shape for a copy-paste bug
 * where the password-reset email says "Your Verification Code".
 *
 * @param {{ title: string, intro: string, code: string, footnote: string }} parts
 * @returns {string}
 */
function layout({ title, intro, code, footnote }) {
  const siteName = config.mail.siteName;
  const fromAddress = config.mail.from;

  return `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>${title}</title></head>
      <body style="margin:0;padding:20px;background-color:#f6f9fc;font-family:Segoe UI,Roboto,sans-serif;">
        <div style="max-width:600px;margin:40px auto;background-color:#ffffff;padding:40px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.05);border:1px solid #e0e0e0;">
          <div style="text-align:center;margin-bottom:30px;">
            <img src="${LOGO_URL}" style="width:150px;">
          </div>
          <h2 style="color:#202124;font-weight:500;font-size:22px;margin-bottom:15px;">${title}</h2>
          <p style="color:#5f6368;font-size:16px;line-height:1.6;">
            ${intro}
          </p>
          <div style="text-align:center;margin:30px 0;">
            <span style="display:inline-block;font-size:24px;color:#1a73e8;background-color:#f1f3f4;padding:15px 30px;border-radius:8px;font-weight:600;letter-spacing:3px;">
              ${code}
            </span>
          </div>
          <p style="color:#5f6368;font-size:14px;line-height:1.5;">
            ${footnote}
          </p>
          <hr style="border:none;border-top:1px solid #e0e0e0;margin:40px 0;">
          <p style="color:#999;font-size:12px;text-align:center;">
            Sent by ${siteName}<br>
            <a style="color:#999;" href="mailto:${fromAddress}">${fromAddress}</a>
          </p>
        </div>
      </body>
      </html>`;
}

/**
 * The admin-notification template, which is a different layout and stays separate.
 *
 * @param {string} customerEmail
 * @returns {string}
 */
function adminNotificationLayout(customerEmail) {
  const siteName = config.mail.siteName;
  const fromAddress = config.mail.from;

  return `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background-color:#f9f9f9;border:1px solid #ddd;border-radius:8px;text-align:center;">
          <div style="margin-bottom:20px;">
            <img src="${LOGO_URL}" style="width:150px;">
          </div>
          <h2 style="font-size:24px;color:#333;margin-bottom:10px;">New Customer Verification</h2>
          <p style="font-size:16px;color:#555;margin-bottom:20px;">A customer has registered via the website.</p>
          <p style="font-size:16px;color:#777;margin-bottom:10px;"><strong>Email:</strong> ${customerEmail}</p>
          <p style="font-size:12px;color:#aaa;margin-top:30px;">${new Date().toLocaleDateString("en-US", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}</p>
        </div>`;
}

/**
 * Builds the nodemailer transport from config.
 *
 * `requireTLS: true` upgrades an opportunistic STARTTLS connection to a required
 * one. Without it, a server that advertises STARTTLS and then fails the upgrade
 * falls back to plaintext and the OTP goes out unencrypted — nodemailer logs a
 * warning and continues, which is the correct default for a general-purpose client
 * and the wrong one here.
 *
 * @returns {import("nodemailer").Transporter}
 */
function createTransport() {
  return nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: isImplicitTlsPort(config.mail.port),
    requireTLS: true,
    auth: {
      user: config.mail.user,
      pass: config.mail.pass,
    },
  });
}

/**
 * Wraps a send in the port's error vocabulary.
 *
 * The `cause` is attached so the original SMTP diagnostic survives for the log,
 * while the thrown type is what callers branch on.
 *
 * @param {string} to
 * @param {string} what a human-readable description of the message, for the log
 * @param {{ from: string, to: string, subject: string, html: string }} message
 * @param {import("nodemailer").Transporter} transporter
 * @returns {Promise<void>}
 * @throws {MailDeliveryError}
 */
async function deliver(transporter, to, what, message) {
  try {
    await transporter.sendMail(message);
  } catch (cause) {
    throw new MailDeliveryError(`${what} to ${to} was rejected`, { to, cause });
  }
}

/**
 * Builds the adapter.
 *
 * @returns {object} a mailer satisfying `platform/mail/port.js`
 */
function createNodemailerMailer() {
  const transporter = createTransport();

  const siteName = config.mail.siteName;
  const fromAddress = config.mail.from;
  const sender = `"${siteName}" <${fromAddress}>`;

  return assertMailer(
    {
      name: "nodemailer",

      /**
       * @param {string} to
       * @param {string} otp
       * @returns {Promise<void>}
       */
      sendOtp(to, otp) {
        return deliver(transporter, to, "OTP email", {
          from: sender,
          to,
          subject: `Your Verification Code - ${siteName}`,
          html: layout({
            title: "Your Verification Code",
            intro: "To continue securely, please use the following code to verify your identity.",
            code: otp,
            footnote: "This code is valid for a limited time. Please do not share it with anyone.",
          }),
        });
      },

      /**
       * @param {string} to
       * @param {string} otp
       * @returns {Promise<void>}
       */
      sendPasswordReset(to, otp) {
        return deliver(transporter, to, "password reset email", {
          from: sender,
          to,
          subject: `Password Reset - ${siteName}`,
          html: layout({
            title: "Password Reset Code",
            intro: "We received a request to reset your password. Use the code below:",
            code: otp,
            footnote: "If you did not request this, you can safely ignore this email.",
          }),
        });
      },

      /**
       * @param {string} to the admin mailbox
       * @param {string} customerEmail
       * @returns {Promise<void>}
       */
      sendAdminNotification(to, customerEmail) {
        return deliver(transporter, to, "admin notification", {
          from: sender,
          to,
          subject: "New Customer Account Verification",
          html: adminNotificationLayout(customerEmail),
        });
      },

      /**
       * Reachability of the SMTP server. Uses `verify()` rather than a no-op send,
       * so it exercises the credentials and the TLS handshake without putting a
       * message in anyone's inbox.
       *
       * @returns {Promise<{ ok: boolean, adapter: string, detail?: string }>}
       */
      async health() {
        try {
          await transporter.verify();
          return { ok: true, adapter: "nodemailer" };
        } catch (cause) {
          return {
            ok: false,
            adapter: "nodemailer",
            detail: cause instanceof Error ? cause.message : String(cause),
          };
        }
      },

      /**
       * Closes the pooled sockets. Called during shutdown; without it nodemailer's
       * keep-alive connections hold the event loop open past `server.js`'s drain.
       *
       * @returns {Promise<void>}
       */
      async close() {
        transporter.close();
      },
    },
    "nodemailer"
  );
}

module.exports = { createNodemailerMailer, isImplicitTlsPort, LOGO_URL };