/**
 * Request shapes for the sixteen `/api/admin` endpoints.
 *
 * Copied from `src/routes/admin.routes.js:12`, `:29-32`, `:65-82`, `:164-171`,
 * `:187-197`, `:220-224`, `:287-289` and `:340-343`.
 *
 * ## The three pagination schemas, and why there are three
 *
 * | where | default limit | cap | notes |
 * |---|---|---|---|
 * | `listUsersQuery` | 50 | 100 | also takes `?type=` |
 * | `paginationQuery` (accounts) | 50 | 100 | |
 * | `core/http/pagination.paginationQuery` | **20** | 100 | used by every other module |
 *
 * The admin screens default to 50 rows; the shared helper defaults to 20. The
 * admin app is built for tables you scroll and every other list is built for
 * infinite scroll, so the difference is intentional — but it is asserted in three
 * places rather than declared once, which is how `property.service.js:177` ended up
 * the only caller clamping `limit` at 100 while twelve others did not.
 *
 * M04 keeps all three. The admin defaults are the deployed contract and the clamp
 * is a genuine improvement that arrived with the shared helper, not with this
 * milestone.
 *
 * Note that `.max(100)` here is what *actually* clamps the admin lists: without it
 * `?limit=100000` is a full table scan. `.default(50)` is applied after
 * `z.coerce`, and there is no `.catch`, so `?page=abc` is a 400 — unlike the shared
 * helper, which degrades junk to the default. Preserved.
 */
const { z } = require("zod");

/**
 * `POST /api/admin/pin` — step 1 of the two-step admin login.
 *
 * `min(1)` and nothing else: a PIN's length is whatever the operator set in the
 * admin UI. There is no lockout, no attempt counter and no rate limit in this
 * schema — `rateLimit.js` applies a global limiter per IP, which is the only thing
 * standing between an attacker and an unbounded PIN search. A 4-digit PIN is
 * brute-forceable at any rate limit that permits human use.
 */
const pinSchema = z.object({ pin: z.string().min(1) });

/**
 * `POST /api/admin/login` — step 2.
 *
 * The email is **not** lowercased here; `admins.service.adminLogin` does
 * `email.toLowerCase().trim()` before querying, because `aemail` is stored
 * lowercased and the column is not case-insensitive. Validating `.trim()`-ed input
 * here instead would reject an address with a trailing space that currently works.
 */
const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * `PUT /api/admin/profile`.
 *
 * Note `aAddress` — capital `A`, middle of the name — and note that the column it
 * maps to is also `aAddress`. The `user` table's equivalent is the odd one out
 * (`address` → `Address`), not this one.
 *
 * The six link fields are also present **here**, on the profile endpoint, *and*
 * again on `adminLinksSchema` below with different names (`afb` vs `facebook`).
 * `PUT /profile` writes all six onto the `admin` row; `PUT /profile/links`
 * upserts an `adminSocial` row. Two tables, two endpoints, overlapping data, and
 * no reader in this codebase that would tell you which is authoritative. Both are
 * preserved exactly.
 */
const updateAdminProfileSchema = z.object({
  aname: z.string().max(100).optional(),
  alname: z.string().max(100).optional(),
  aphone: z.string().max(20).optional(),
  agency: z.string().max(100).optional(),
  astate: z.string().optional(),
  acity: z.string().optional(),
  agender: z.enum(["Male", "Female", "Other"]).optional(),
  adateofbirth: z.string().optional(),
  aAddress: z.string().max(200).optional(),
  awphone: z.string().max(20).optional(),
  website: z.string().optional(),
  afb: z.string().optional(),
  ainstagram: z.string().optional(),
  atwitter: z.string().optional(),
  atiktok: z.string().optional(),
  alinkedin: z.string().optional(),
});

/**
 * `PUT /api/admin/profile/links` — the `adminSocial` upsert.
 *
 * Plain `z.string()`, **not** `.url()`. These six are written to a separate table
 * and nothing in this codebase reads them back, so unlike `users`' `socialLinksSchema`
 * there is no rendering path to protect and no `.or(z.literal(""))` needed to allow
 * clearing — the service turns `""` into `null` itself.
 *
 * The field names are the full words (`facebook`, not `afb`) even though the
 * columns are prefixed (`afb`, `ainstagram`). The mismatch is the legacy contract.
 */
const adminLinksSchema = z.object({
  website: z.string().optional(),
  facebook: z.string().optional(),
  linkedin: z.string().optional(),
  instagram: z.string().optional(),
  tiktok: z.string().optional(),
  twitter: z.string().optional(),
});

/**
 * `PUT /api/admin/profile/password`.
 *
 * The same 8–16 / upper / lower / digit / special rule as the user endpoint. Two
 * differences from `users.schema.changePasswordSchema`, both preserved:
 *
 *   - `.max(16)` carries **no message**, so an over-long password fails with zod's
 *     default "String must contain at most 16 character(s)" rather than the rule's
 *     own "Password must be 8-16 characters". A cosmetic inconsistency in a 400.
 *   - There is no third password policy to reconcile against — `POST /auth/register`
 *     and `PUT /users/me/password` have their own.
 */
const adminPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Password must be 8-16 characters")
    .max(16)
    .regex(/[A-Z]/, "Must contain uppercase letter")
    .regex(/[a-z]/, "Must contain lowercase letter")
    .regex(/\d/, "Must contain a number")
    .regex(/[!@#$%^&*(),.?":{}|<>]/, "Must contain special character"),
});

/**
 * `GET /api/admin/users?type=&page=&limit=`.
 *
 * `type` is `User` / `Agent` / `Builder` — mixed case, matching `user.utype` as
 * written by `PUT /users/me`, and **not** matching `modules/accounts`' uppercase
 * `DELETED` / `BLOCKED` for the same column. See the casing note in
 * `users.mapper`.
 */
const listUsersQuerySchema = z.object({
  type: z.enum(["User", "Agent", "Builder"]).optional(),
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
});

/**
 * The four `adminSocial` columns' update-vs-create asymmetry.
 *
 * `create` writes all six with `|| null`; `update` writes the six with
 * `?? undefined`, which Prisma treats as "leave this column alone". So:
 *
 *   - first call with `{}` → six `null`s are created;
 *   - later call with `{}` → nothing changes.
 *
 * That is the legacy behaviour and it is the difference between "clear the page"
 * and "the form sent nothing". Preserved in `admins.repository.updateSocialLinks`,
 * where the two branches have to stay visually distinct — collapsing them to one
 * `data` object would silently change what a second empty submit does.
 */
const adminPaginationQuery = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
});

/**
 * `PUT /api/admin/users/:id/status`.
 *
 * `activate` / `deactivate` write `user.deactivate` (`1` = active);
 * `freeze` / `unfreeze` write `user.adminblock`, `property.adminblock`,
 * `feedback.fadminblock` and the `del_account` ledger. **They are unrelated flags**
 * and neither one implies the other: a user can be deactivated but not frozen,
 * frozen but not deactivated, or both.
 *
 * The admin UI presents them as one dropdown, which suggests they are one state.
 * They are four.
 */
const statusSchema = z.object({
  action: z.enum(["activate", "deactivate", "freeze", "unfreeze"]),
});

module.exports = {
  pinSchema,
  adminLoginSchema,
  updateAdminProfileSchema,
  adminLinksSchema,
  adminPasswordSchema,
  listUsersQuerySchema,
  adminPaginationQuery,
  statusSchema,
};