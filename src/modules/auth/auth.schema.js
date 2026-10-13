/**
 * The request schemas.
 *
 * Byte-identical to the ones that lived inside `routes/auth.routes.js`, down to the
 * message wording — those messages are part of the frozen contract, because the
 * frontend renders the validation string directly rather than mapping codes to
 * copy. Changing "Must contain special character" is an API change.
 *
 * ## What is imported from `@amaken/shared`, and what is not
 *
 * `strongPasswordSchema`, `USER_TYPES` and `GENDERS` are imported rather than
 * re-declared, because they are **identical** to what this module needs and the
 * milestone asks for one definition where one exists. That is the entire import:
 * three symbols that agree exactly.
 *
 * The rest of `@amaken/shared` disagrees with the deployed contract and is
 * deliberately not used:
 *
 * | Shared schema | Divergence from the live route |
 * |---|---|
 * | `loginSchema` | `password` min 6 with "Invalid email address" wording — the live route is `z.string().email()` plus `min(6)` with zod's default messages, and the frontend matches on that text |
 * | `registerSchema` | rejects nothing the live route accepts, but omits 14 optional profile fields the live route carries, so using it would silently drop them |
 * | `resetPasswordSchema` | field is `token`, not `resetToken`, and `password` is `min(6)` rather than the 8-16 strong policy |
 * | `verifyOtpSchema` | adds "OTP must be 6 digits", which is *not* the live message |
 *
 * A shared schema becomes usable here when the live route and the shared copy agree
 * — which means either changing the route (an API change, needs an ADR against the
 * frozen `docs/api-contract.md`) or changing the shared copy to match the live
 * route. Neither is M03's to decide.
 */
const { z } = require("zod");
const { strongPasswordSchema, USER_TYPES, GENDERS } = require("@amaken/shared");

const emailField = z.string().email();

/** The six-digit code, exactly. `crypto.randomInt(100000, 999999)` always is. */
const otpField = z.string().length(6);

const registerSchema = z.object({
  email: emailField,
  uname: z.string().min(1).max(100),
  lname: z.string().min(1).max(100),
  phone: z.string().min(1).max(20),
  password: strongPasswordSchema,
  utype: z.enum(USER_TYPES),
  dateOfBirth: z.string().optional(),
  Address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  gender: z.enum(GENDERS).optional(),
  company: z.string().optional(),
  companyAddress: z.string().optional(),
  wphone: z.string().optional(),
  fb: z.string().optional(),
  linkedin: z.string().optional(),
  tiktok: z.string().optional(),
  instagram: z.string().optional(),
  twitter: z.string().optional(),
  website: z.string().optional(),
});

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(6),
});

const verifyEmailSchema = z.object({
  email: emailField,
});

const verifyOtpSchema = z.object({
  email: emailField,
  code: otpField,
});

const forgotPasswordSchema = z.object({
  email: emailField,
});

const verifyForgotOtpSchema = z.object({
  email: emailField,
  code: otpField,
});

const resetPasswordSchema = z.object({
  email: emailField,
  resetToken: z.string().min(1),
  password: strongPasswordSchema,
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

module.exports = {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  verifyOtpSchema,
  forgotPasswordSchema,
  verifyForgotOtpSchema,
  resetPasswordSchema,
  refreshSchema,
};