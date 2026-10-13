/**
 * Request shapes for `PUT /api/users/me`, `PUT /me/password` and `PUT /me/links`.
 *
 * Copied verbatim from `src/routes/user.routes.js:25-38`, `:129-138` and `:159-166`,
 * including the regex list, because the *set* of passwords a deployed system has
 * already accepted is a wire contract: tightening it locks out everyone whose
 * existing password no longer qualifies. A new minimum belongs to the milestone
 * that announces it.
 *
 * The consequence is that M04's ban on SHA-1/SHA-256 password storage applies to
 * *verification*, not to *acceptance*. See `core/password` for that distinction —
 * an old account with a bare SHA-256 digest cannot change its password, because
 * `PUT /me/password` verifies the current one first, and it must use the reset
 * flow instead.
 */
const { z } = require("zod");

/**
 * `PUT /api/users/me`.
 *
 * Every field optional, so `{}` is a valid body and is a no-op — the service writes
 * nothing and does not stamp `editprofile`. See `users.mapper.toProfileUpdate`.
 *
 * `utype` is constrained to `["User", "Agent", "Builder"]`, which is what stops
 * this endpoint from being a privilege-escalation route: `Admin` is not in the
 * enum, so a user cannot promote themselves through their own profile form.
 *
 * The casing here is `User` / `Agent` / `Builder` — mixed case — while
 * `modules/accounts` writes `DELETED` / `BLOCKED` uppercase for `utype` and
 * `modules/admins` checks `USER` / `ADMIN` uppercase. Three vocabularies for one
 * column across three modules, all pre-existing. Collapsing them would change what
 * `GET /users/me` returns for every user, so it is documented in
 * `users.mapper` rather than done here.
 *
 * `state`, `city` and `dateOfBirth` are unbounded strings against `VarChar`
 * columns. Over-long input is rejected by MySQL rather than validated here, which
 * is a 500 rather than a 400; the legacy service was the same.
 */
const updateProfileSchema = z.object({
  uname: z.string().min(1).max(100).optional(),
  lname: z.string().min(1).max(100).optional(),
  phone: z.string().max(20).optional(),
  address: z.string().max(200).optional(),
  company: z.string().max(100).optional(),
  companyAddress: z.string().max(200).optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  gender: z.enum(["Male", "Female", "Other"]).optional(),
  dateOfBirth: z.string().optional(),
  wphone: z.string().max(20).optional(),
  utype: z.enum(["User", "Agent", "Builder"]).optional(),
});

/**
 * `PUT /api/users/me/password`.
 *
 * The policy is 8–16 characters with an uppercase, a lowercase, a digit and a
 * special character. Six separate `.regex()` calls rather than one lookahead —
 * the message on each names the specific rule that failed, which is the only
 * reason a user can act on a 400 here.
 *
 * Note the asymmetry with the rest of the auth module: `POST /auth/register` has
 * its own password policy in `auth.schema.js`, and the two are not the same rule.
 * Unifying them would reject registrations the deployed system accepts.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Password must be 8-16 characters")
    .max(16, "Password must be 8-16 characters")
    .regex(/[A-Z]/, "Must contain uppercase letter")
    .regex(/[a-z]/, "Must contain lowercase letter")
    .regex(/\d/, "Must contain a number")
    .regex(/[!@#$%^&*(),.?":{}|<>]/, "Must contain special character"),
});

/**
 * `PUT /api/users/me/links`.
 *
 * `.optional().or(z.literal(""))` rather than `.optional()` alone: the admin UI
 * sends `""` to clear a field, and a bare `.url()` would 400 on it. `.url()` also
 * rejects protocol-relative input like `//evil.example`, which is the right
 * behaviour for a value that gets rendered into an `href`.
 *
 * A `javascript:` URL fails `.url()`; a bare `example.com` fails it too, because
 * the UI sends fully-qualified links.
 */
const socialLinksSchema = z.object({
  fb: z.string().url().optional().or(z.literal("")),
  linkedin: z.string().url().optional().or(z.literal("")),
  tiktok: z.string().url().optional().or(z.literal("")),
  instagram: z.string().url().optional().or(z.literal("")),
  twitter: z.string().url().optional().or(z.literal("")),
  website: z.string().url().optional().or(z.literal("")),
});

module.exports = { updateProfileSchema, changePasswordSchema, socialLinksSchema };