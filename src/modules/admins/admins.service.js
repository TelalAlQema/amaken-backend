/**
 * `admins` business rules.
 *
 * A port of `services/admin.service.js`. The substantive changes, each commented
 * where it happens:
 *
 *   1. **No SHA-1 fallback.** {@link adminLogin} and {@link changeAdminPassword} now
 *      verify through `core/password`.
 *   2. **Interactive transactions** in the freeze/unfreeze/delete paths, replacing
 *      three `$transaction([...])` calls that each contained an `await` in the array
 *      literal. See `admins.repository`'s header.
 *   3. **The ledger writes go through `modules/accounts`**, on the transaction
 *      client, instead of an inlined `delAccount.upsert` with an `id: … ?? -1`.
 *
 * Behaviour preserved, including one that is a genuine finding rather than a
 * decision — see {@link updateAdminProfile} and {@link verifyAdminPin}.
 */
const { AppError } = require("../../core/errors");
const password = require("../../core/password");
const storage = require("../../platform/storage");
const config = require("../../config");
const auth = require("../auth");
const accounts = require("../accounts");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

const repository = require("./admins.repository");
const mapper = require("./admins.mapper");

/** Avatars and admin logos share the `users/` upload directory. */
const ADMIN_DIR = storage.StorageDir.USERS;

// ── step 1: the PIN ─────────────────────────────────────────────────────────

/**
 * `POST /admin/pin` — half of the two-step admin login.
 *
 * The PIN is a bcrypt hash in `pin.upin`; there is no plaintext copy. Only the
 * **first** row is considered (`orderBy: { id: "asc" }`), on the assumption that
 * the table holds exactly one.
 *
 * ## Three things this does not do
 *
 *   - **No rate limiting, and no attempt counter.** `src/middleware/rateLimit.js`
 *     applies a per-IP limiter globally, which is the only thing standing between
 *     an attacker and an unbounded search of a 4-digit PIN. This endpoint is the
 *     most brute-forceable in the API and is not excluded from it.
 *   - **No lockout.** Nothing counts failures.
 *   - **No timing equalisation between "no PIN configured" and "wrong PIN".** A
 *     missing row returns 500 immediately; a wrong PIN pays a full bcrypt compare
 *     and returns 401. The 500-vs-401 split also discloses whether the deployment
 *     has been set up, which is not a secret worth guarding but is not a distinction
 *     worth making either.
 *
 * The 500 for "not configured" is deliberate and correct — it is an operator error,
 * not a caller error — and it is the reason the endpoint is safe to call before any
 * admin exists.
 *
 * @param {string} pin
 * @returns {Promise<{ message: string, step: string }>} `step` tells the frontend
 *   which half of the login to render next. It is the entire reason this endpoint
 *   exists: the PIN screen is a client-side gate, not an authentication step, and
 *   the real credential check is {@link adminLogin}.
 * @throws {AppError} 500 `PIN_NOT_FOUND`, 401 `PIN_INVALID`
 */
async function verifyAdminPin(pin) {
  const pinRecord = await repository.findFirstPin();

  if (!pinRecord) {
    throw new AppError("Admin PIN not configured", 500, "PIN_NOT_FOUND");
  }

  // `password.verify` is used rather than `bcrypt.compare` directly so that a PIN
  // stored as something other than a hash fails closed instead of throwing inside
  // bcrypt. It cannot be upgraded in place — there is no plaintext to rehash after
  // a successful compare unless we keep it, and a PIN is not a password worth a
  // migration.
  const { ok } = await password.verify(pin, pinRecord.upin);
  if (!ok) throw new AppError("Invalid PIN", 401, "PIN_INVALID");

  return { message: "PIN verified successfully", step: "email_password" };
}

// ── step 2: email + password ────────────────────────────────────────────────

/**
 * `POST /admin/login`.
 *
 * ## What M04 removed
 *
 * The legacy verify was:
 *
 *     if (stored.startsWith("$2") || stored.startsWith("$argon")) {
 *       passwordOk = await bcrypt.compare(password, stored);
 *       if (passwordOk && bcrypt.getRounds(stored) < 12) { …rehash and write… }
 *     } else {
 *       const sha1 = crypto.createHash("sha1").update(password).digest("hex");
 *       if (sha1 === stored) { passwordOk = true; …rehash and write… }
 *     }
 *
 * The SHA-1 branch is gone, and with it the only code path in the application that
 * would **accept** an unsalted SHA-1 digest. `core/password.verify` keeps exactly
 * one self-erasing upgrade path — a bcrypt hash below cost 12 — and no second
 * algorithm.
 *
 * The upgrade is preserved: a correct password against a cost-4 hash still
 * rehashes to cost 12 on this request, and the write goes to the same
 * `markLogin` call that stamps `aloginvalue`.
 *
 * ## Consequence
 *
 * An admin account still holding a bare SHA-1 digest from the PHP migration cannot
 * sign in. Unlike a user, there is **no reset flow for an admin** — no
 * `forgot-password` equivalent — so recovery is an out-of-band password reset.
 * That is the sharp edge of removing the fallback here, it is in the M04 log, and
 * it is the price of not keeping a fast unsalted hash acceptable.
 *
 * ## The owner exemption
 *
 * `admin.main === config.admin.mainPhone` bypasses the block check. This is the
 * only way an admin can be un-blocked through the API: `adminUnfreezeUser` does not
 * exist for admins, so a blocked owner is locked out permanently. It is also a
 * bypass keyed on a **phone number in a config column**, which is a secretless
 * comparison — anyone who can write `admin.main` on a row exempts that row. That
 * write is admin-only and there is no endpoint for it, so today it is a migration
 * concern rather than an attack.
 *
 * @param {string} email
 * @param {string} plain
 * @returns {Promise<{ admin: object, accessToken: string, refreshToken: string }>}
 * @throws {AppError} 401 `AUTH_FAILED`, 403 `ACCOUNT_BLOCKED`
 */
async function adminLogin(email, plain) {
  const normalizedEmail = email.toLowerCase().trim();

  const admin = await repository.findAdminByEmail(normalizedEmail);

  // No `password.burn()` here, unlike `modules/auth`'s `loginUser`. The admin
  // table is small and its addresses are not public knowledge, so the enumeration
  // oracle is worth much less than it is for users. Noted rather than fixed —
  // `burn` costs a full bcrypt hash, and paying it on every admin login to hide
  // the existence of a dozen known addresses is a bad trade.
  if (!admin) {
    throw new AppError("Email or password does not match", 401, "AUTH_FAILED");
  }

  if (admin.adminblock === 1 && admin.main !== config.admin.mainPhone) {
    throw new AppError("This account has been blocked", 403, "ACCOUNT_BLOCKED");
  }

  const { ok, upgrade } = await password.verify(plain, admin.apass);
  if (!ok) {
    throw new AppError("Email or password does not match", 401, "AUTH_FAILED");
  }

  await repository.markLogin(admin.aid, upgrade ?? undefined);

  // Only the two tokens reach the response. `issueTokenPair` also returns the
  // family, both `jti`s and the refresh lifetime for the module's rotation
  // bookkeeping, and those are the server's business — spreading the whole object
  // here would publish them, which is how a `jti` ends up in a client and someone
  // builds a denylist against it.
  const { accessToken, refreshToken } = auth.capabilities.issueTokenPair(
    admin.aid,
    admin.aemail,
    "admin",
    admin.tokenVersion
  );

  return {
    admin: {
      id: admin.aid,
      email: admin.aemail,
      name: `${admin.aname} ${admin.alname}`,
      type: admin.atype,
      image: admin.aimage,
    },
    accessToken,
    refreshToken,
  };
}

// ── profile ─────────────────────────────────────────────────────────────────

/**
 * `GET /admin/profile`.
 *
 * @param {number} adminId
 * @returns {Promise<object>} 24 columns, no `apass`
 * @throws {AppError} 404 `ADMIN_NOT_FOUND`
 */
async function getAdminProfile(adminId) {
  const admin = await repository.findAdminProfile(adminId);
  if (!admin) throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  return admin;
}

/**
 * `PUT /admin/profile`.
 *
 * ## The response includes `apass`, and M04 leaves it there
 *
 * `repository.updateAdminRow` passes no `select`, so the whole `admin` row comes
 * back — including the bcrypt hash and `atokenversion` — and this returns it
 * directly. Every *read* of an admin in this module projects columns explicitly;
 * this one write does not, and the difference is invisible until you read the
 * response.
 *
 * The fix is one `select`. It is not applied here because:
 *
 *   - no test asserts the shape, so nothing would catch a regression either way;
 *   - the admin UI reads specific keys, so removing `apass` is very likely safe —
 *     but "very likely" is how a client breaks in a milestone whose contract is
 *     "nothing changed but the file locations";
 *   - the finding is not M04's to close. It belongs with the other M00 auth
 *     findings, and closing it there means the M00 log has one entry for it rather
 *     than two.
 *
 * Tracked as M00.9. See `admins.repository.updateAdminRow`.
 *
 * ## The `.substring()` calls are gone
 *
 * The legacy service truncated all ten fields (`data.aname.substring(0, 100)`).
 * Those were unreachable: `updateAdminProfileSchema` caps the same fields at the
 * same lengths and rejects an over-long value with a 400 first. The caps live in
 * one place now, which is the schema.
 *
 * @param {number} adminId
 * @param {Record<string, unknown>} body a validated body
 * @returns {Promise<object>}
 * @throws {AppError} 404 `ADMIN_NOT_FOUND`
 */
async function updateAdminProfile(adminId, body) {
  const admin = await repository.findAdminById(adminId);
  if (!admin) throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");

  return repository.updateAdminRow(adminId, mapper.toProfileUpdate(body));
}

// ── avatar and logo ─────────────────────────────────────────────────────────

/**
 * One helper for all four image endpoints.
 *
 * The delete-before-write ordering and the reason not to reverse it are documented
 * in `modules/users`' `storeImage`; the same trade applies here, and the same fix
 * is equally not made.
 *
 * @param {number} adminId
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @param {{ column: "aimage" | "companylogo", prefix: string, size: number }} target
 * @returns {Promise<object>}
 */
async function storeImage(adminId, file, { column, prefix, size }) {
  const admin = await repository.findAdminById(adminId);
  if (!admin) throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");

  if (admin[column]) await storage.deleteFile(ADMIN_DIR, admin[column]);

  const filename = await storage.saveImage(file, ADMIN_DIR, prefix, {
    maxWidth: size,
    maxHeight: size,
  });

  await repository.setAdminImage(adminId, { [column]: filename });

  return column === "aimage"
    ? { image: filename, message: "Admin image updated" }
    : { logo: filename, message: "Admin logo updated" };
}

/**
 * `POST /admin/profile/avatar` — 400×400.
 *
 * @param {number} adminId
 * @param {object} file
 * @returns {Promise<object>}
 */
function uploadAdminImage(adminId, file) {
  return storeImage(adminId, file, { column: "aimage", prefix: "admin", size: 400 });
}

/**
 * `POST /admin/profile/logo` — 500×500.
 *
 * @param {number} adminId
 * @param {object} file
 * @returns {Promise<object>}
 */
function uploadAdminLogo(adminId, file) {
  return storeImage(adminId, file, { column: "companylogo", prefix: "adminlogo", size: 500 });
}

/**
 * @param {number} adminId
 * @param {"aimage" | "companylogo"} column
 * @returns {Promise<{ message: string }>}
 */
async function removeImage(adminId, column) {
  const admin = await repository.findAdminById(adminId);
  if (!admin) throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");

  if (admin[column]) await storage.deleteFile(ADMIN_DIR, admin[column]);

  await repository.setAdminImage(adminId, { [column]: "" });

  return {
    message: column === "aimage" ? "Admin image removed" : "Admin logo removed",
  };
}

/**
 * `DELETE /admin/profile/avatar`.
 *
 * @param {number} adminId
 * @returns {Promise<{ message: string }>}
 */
function removeAdminImage(adminId) {
  return removeImage(adminId, "aimage");
}

/**
 * `DELETE /admin/profile/logo`.
 *
 * @param {number} adminId
 * @returns {Promise<{ message: string }>}
 */
function removeAdminLogo(adminId) {
  return removeImage(adminId, "companylogo");
}

// ── links, password ─────────────────────────────────────────────────────────

/**
 * `PUT /admin/profile/links`.
 *
 * Upserts the `adminSocial` row. It does **not** touch the six link columns on
 * the `admin` row itself, which `updateAdminProfile` also writes and which the
 * admin UI may read instead. Two tables, two endpoints, one set of concepts.
 * Preserved.
 *
 * @param {number} adminId
 * @param {Record<string, string | undefined>} body
 * @returns {Promise<{ message: string }>}
 */
async function updateAdminSocialLinks(adminId, body) {
  await repository.updateSocialLinks(adminId, body);
  return { message: "Social links updated" };
}

/**
 * `PUT /admin/profile/password`.
 *
 * ## The SHA-1 branch is gone
 *
 * The legacy version had `if (isLegacyHash(stored)) { sha1 === stored }`. Like the
 * user's, an admin whose password is still a bare digest cannot change it here —
 * and unlike the user, there is no reset flow to fall back on. See
 * {@link adminLogin}.
 *
 * @param {number} adminId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `ADMIN_NOT_FOUND`, 400 `PASSWORD_INCORRECT`
 */
async function changeAdminPassword(adminId, currentPassword, newPassword) {
  const admin = await repository.findAdminById(adminId);
  if (!admin) throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");

  const { ok } = await password.verify(currentPassword, admin.apass);
  if (!ok) throw new AppError("Current password is incorrect", 400, "PASSWORD_INCORRECT");

  await repository.setAdminPassword(adminId, await password.hash(newPassword));

  return { message: "Password updated successfully" };
}

// ── user management ─────────────────────────────────────────────────────────

/**
 * `GET /admin/users`, `/users/agents`, `/users/builders`.
 *
 * @param {"User" | "Agent" | "Builder" | undefined} type
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ users: object[], pagination: object }>}
 */
function listUsers(type, page) {
  return repository.listUsers(type, page);
}

/**
 * `GET /admin/users/admins`. A bare array — no pagination, unlike its siblings.
 *
 * @returns {Promise<object[]>}
 */
function listAdmins() {
  return repository.listAdmins();
}

/**
 * `PUT /admin/users/:id/status` → `freeze`.
 *
 * Unlike the user's own `POST /users/block/:id`, this writes a `del_account`
 * ledger row, so a self-frozen account and an admin-frozen account are different
 * states and only one of them is visible in the admin "blocked accounts" screen.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function adminFreezeUser(userId) {
  const user = await repository.findUserRow(userId);
  await repository.freezeUser(user, new Date());
  await invalidateDashboard();
  return { message: "User frozen" };
}

/**
 * `PUT /admin/users/:id/status` → `unfreeze`.
 *
 * Clears `adminblock` on the user, its properties and its feedback, and deletes
 * the ledger row.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function adminUnfreezeUser(userId) {
  const user = await repository.findUserRow(userId);
  await repository.unfreezeUser(user);
  await invalidateDashboard();
  return { message: "User unfrozen" };
}

/**
 * `PUT /admin/users/:id/status` → `activate` / `deactivate`.
 *
 * Moves `deactivate` only. Does not touch `adminblock`, so "deactivated" and
 * "frozen" are independent, and does not 404 on a missing user: the legacy pair of
 * one-line `update` calls let Prisma's `P2025` surface, which `core/errors/prisma.js`
 * maps to a 404 — but with a generic message instead of "User not found".
 *
 * Preserved, because changing it would change which message a caller gets for the
 * same request. The asymmetry is visible in the tests and is commented here so it
 * does not read as an oversight.
 *
 * @param {number} userId
 * @param {boolean} active
 * @returns {Promise<{ message: string }>}
 */
async function setUserActive(userId, active) {
  await repository.setUserActive(userId, active);
  await invalidateDashboard();
  return { message: active ? "User activated" : "User deactivated" };
}

/**
 * `DELETE /admin/users/:id`.
 *
 * Writes a `delete` ledger row, then removes the user's properties and feedback,
 * then the user. Does **not** remove their avatar or logo — see
 * `admins.repository.deleteUserRow`.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function adminDeleteUser(userId) {
  const user = await repository.findUserRow(userId);
  await repository.deleteUserRow(user, new Date());
  await invalidateDashboard();
  return { message: "User deleted" };
}

// ── account screens (implemented in `modules/accounts`) ──────────────────────

/**
 * These four are `accounts.capabilities` called through one line each.
 *
 * They exist so `admins.routes.js` talks to its own module's service rather than
 * reaching across into `modules/accounts` for each handler, and so the dependency
 * is visible in one place rather than spread across four route handlers.
 */

const { listRegistered, listDeleted, listBlocked, deleteAccountRecord } = accounts.capabilities;

module.exports = {
  verifyAdminPin,
  adminLogin,
  getAdminProfile,
  updateAdminProfile,
  uploadAdminImage,
  removeAdminImage,
  uploadAdminLogo,
  removeAdminLogo,
  updateAdminSocialLinks,
  changeAdminPassword,
  listUsers,
  listAdmins,
  adminFreezeUser,
  adminUnfreezeUser,
  setUserActive,
  adminDeleteUser,
  // account screens
  listRegisteredAccounts: listRegistered,
  listDeletedAccounts: listDeleted,
  listBlockedAccounts: listBlocked,
  deleteAccountRecord,
};
