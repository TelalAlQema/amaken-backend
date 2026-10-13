/**
 * `users` business rules.
 *
 * A port of `services/user.service.js` with three substantive changes, each
 * commented where it happens:
 *
 *   1. **One password verifier** (`core/password`) instead of a private SHA-256
 *      branch. See {@link changePassword}.
 *   2. **Storage through the `platform/storage` port** instead of absolute paths
 *      round-tripped through `services/upload.service.js`. See {@link
 *      replaceImage}.
 *   3. **The block/unblock id is still `req.params.id`.** Not changed — see the
 *      header in `users.routes.js` and the note in `users.repository.js`.
 *
 * Everything else is behaviour-preserving, including two things that look like
 * mistakes and are not:
 *
 *   - `deactivate = 1` means **active**;
 *   - freezing a user sets `blocked_user = 0` on their properties, not `1`.
 */
const { AppError } = require("../../core/errors");
const password = require("../../core/password");
const storage = require("../../platform/storage");
const repository = require("./users.repository");
const mapper = require("./users.mapper");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

/** The directory every avatar and company logo is written to. */
const USER_DIR = storage.StorageDir.USERS;

/**
 * `GET /users/me`.
 *
 * @param {number} userId the authenticated caller's `uid`
 * @returns {Promise<object>} the 30-column record
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function getProfile(userId) {
  const profile = await repository.findOwnProfile(userId);
  if (!profile) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  return profile;
}

/**
 * `PUT /users/me`.
 *
 * Existence is checked first, so a request for a uid that has been deleted returns
 * 404 rather than Prisma's `P2025`. The legacy service did the same for the same
 * reason: `update` on a missing row throws a Prisma error that the error handler
 * maps to a 404 with a different message.
 *
 * @param {number} userId
 * @param {Record<string, unknown>} body a validated body
 * @returns {Promise<object>} the 21-column projection
 */
async function updateProfile(userId, body) {
  await repository.findOwnedUser(userId);
  const profile = await repository.updateProfile(userId, mapper.toProfileUpdate(body));
  await invalidateDashboard();
  return profile;
}

/**
 * `PUT /users/me/links`.
 *
 * Writes all six columns and the timestamp on every call, including an empty body
 * — which clears every link. That is the legacy behaviour and it is what the
 * admin UI's "clear all" button does.
 *
 * @param {number} userId
 * @param {Record<string, string>} body
 * @returns {Promise<{ message: string }>}
 */
async function updateSocialLinks(userId, body) {
  await repository.findOwnedUser(userId);
  await repository.updateLinks(userId, mapper.toLinksUpdate(body));
  return { message: "Social links updated" };
}

/**
 * Swaps one stored image for another.
 *
 * Both the legacy `uploadProfileImage`/`uploadCompanyLogo` and the two `remove*`
 * functions are this function with different arguments: read the row, delete the
 * old file if there is one, write the new file, update the column.
 *
 * ## The ordering is preserved, and it is the wrong ordering
 *
 * The old file is deleted **before** the new one is written. If `saveImage` throws
 * — disk full, sharp rejects the buffer, the adapter is a remote bucket with no
 * credentials — the user has lost the image *and* still has the row pointing at a
 * filename that no longer exists, so `GET /users/me` returns a broken avatar URL
 * forever. Writing first and deleting afterwards leaves at worst a leaked file.
 *
 * Reversing it is a one-line change and is not made here: it alters observable
 * behaviour on a failure path that no test covers, and "fix the ordering" is a
 * better thing to do as a change with a test than as a drive-by inside a structural
 * move. Recorded in the M04 log.
 *
 * @param {number} userId
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @param {{ column: "uimage" | "ucompanylogo", prefix: string, size: number }} target
 * @returns {Promise<object>} `{ image|logo, message }`
 */
async function storeImage(userId, file, { column, prefix, size }) {
  const user = await repository.findOwnedUser(userId);

  if (user[column]) await storage.deleteFile(USER_DIR, user[column]);

  const filename = await storage.saveImage(file, USER_DIR, prefix, {
    maxWidth: size,
    maxHeight: size,
  });

  const payload =
    column === "uimage" ? mapper.toImageUpdate(filename) : mapper.toLogoUpdate(filename);

  await repository.setImage(userId, payload);

  // The two response keys differ (`image` vs `logo`) and the frontend reads them
  // by name. See the "2MB/5MB" note in users.routes for the field name coupling.
  return column === "uimage"
    ? { image: filename, message: "Profile image updated" }
    : { logo: filename, message: "Company logo updated" };
}

/**
 * `POST /users/me/avatar` — 2MB, stored at 400×400.
 *
 * @param {number} userId
 * @param {object} file a multer memory-storage file
 * @returns {Promise<object>}
 */
function uploadProfileImage(userId, file) {
  return storeImage(userId, file, { column: "uimage", prefix: "user", size: 400 });
}

/**
 * `POST /users/me/logo` — 5MB, stored at 500×500.
 *
 * @param {number} userId
 * @param {object} file
 * @returns {Promise<object>}
 */
function uploadCompanyLogo(userId, file) {
  return storeImage(userId, file, { column: "ucompanylogo", prefix: "logo", size: 500 });
}

/**
 * Clears an image column and removes the file.
 *
 * `deleteFile` resolves `false` when there was nothing to delete and never throws,
 * so a missing file is not an error — deleting an image the user never set is a
 * no-op, and the route still reports success.
 *
 * @param {number} userId
 * @param {"uimage" | "ucompanylogo"} column
 * @returns {Promise<{ message: string }>}
 */
async function removeImage(userId, column) {
  const user = await repository.findOwnedUser(userId);

  if (user[column]) await storage.deleteFile(USER_DIR, user[column]);

  await repository.setImage(
    userId,
    column === "uimage" ? mapper.toImageClear() : mapper.toLogoClear()
  );

  return { message: column === "uimage" ? "Profile image removed" : "Company logo removed" };
}

/**
 * `DELETE /users/me/avatar`.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 */
function removeProfileImage(userId) {
  return removeImage(userId, "uimage");
}

/**
 * `DELETE /users/me/logo`.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 */
function removeCompanyLogo(userId) {
  return removeImage(userId, "ucompanylogo");
}

/**
 * `PUT /users/me/password`.
 *
 * ## What M04 changed here
 *
 * The legacy version was:
 *
 *     const valid = await verifyPasswordLegacy(currentPassword, user.upass);
 *
 * where `verifyPasswordLegacy` accepted a bare SHA-256 hex digest and compared it
 * with `===`. M04 removes both the SHA-256 branch and the `===`.
 *
 * The consequence is real and worth stating plainly: **a user whose stored password
 * is still a bare SHA-256 digest from the PHP migration cannot change their
 * password through this endpoint**, because the current password cannot be
 * verified. They must use `POST /auth/forgot-password`, which verifies an OTP
 * against the cache instead of a hash. That is the intended trade — an unsalted
 * fast hash is not a password — and it is a support-visible change, so it is in the
 * M04 log rather than buried in a diff.
 *
 * `{ ok, upgrade }` rather than a boolean, so the "correct password, weak hash"
 * case can be persisted on the way past. `changePassword` overwrites the hash
 * anyway, so the `upgrade` field is only consulted to avoid a pointless double
 * hash: if the stored value is already a cost-12 bcrypt hash there is nothing to
 * upgrade and the new hash replaces it regardless.
 *
 * @param {number} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 400 `PASSWORD_INCORRECT` — including for an unverifiable
 *   stored hash, which is deliberately not distinguished
 */
async function changePassword(userId, currentPassword, newPassword) {
  const user = await repository.findOwnedUser(userId);

  const { ok } = await password.verify(currentPassword, user.upass);
  if (!ok) throw new AppError("Current password is incorrect", 400, "PASSWORD_INCORRECT");

  await repository.setPassword(userId, await password.hash(newPassword));

  return { message: "Password updated successfully" };
}

/**
 * `POST /users/me/deactivate`.
 *
 * Hides the account from `GET /users/:id` and leaves it fully usable at
 * `/users/me`. Does **not** revoke tokens: a deactivated user keeps a working
 * session until it expires. Reversible via `/me/activate`, which is the point of
 * it being a soft flag rather than a delete.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 */
async function deactivateAccount(userId) {
  await repository.setActive(userId, false);
  return { message: "Account deactivated" };
}

/**
 * `POST /users/me/activate`.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 */
async function activateAccount(userId) {
  await repository.setActive(userId, true);
  return { message: "Account activated" };
}

/**
 * `DELETE /users/me`.
 *
 * Removes the two files, then the row. The legacy order — **files first, row
 * second** — means a failure deleting the row leaves a user with no avatar and no
 * account, which is recoverable; the reverse order would leave an orphan file that
 * nobody will ever clean up. Files first is the right choice for a *delete*, which
 * is the opposite of {@link storeImage}'s reasoning and for the same underlying
 * reason: prefer the recoverable failure.
 *
 * What is **not** cleaned up: nothing in the schema cascades. A user with
 * properties, feedback or messages keeps them, pointing at a `uid` that no longer
 * exists. The legacy service did exactly this and the orphaned rows are still in
 * production; `adminDeleteUser` in `modules/admins` deletes a user's children
 * explicitly, so the two paths are not equivalent and never were.
 *
 * No ledger row is written either. `del_account` records admin decisions (see
 * `modules/accounts`), and a self-delete that wrote one would block the user's own
 * address from re-registering — which `register_email` already does, and which is
 * the ledger's actual purpose.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function deleteAccount(userId) {
  const user = await repository.findOwnedUser(userId);

  if (user.uimage) await storage.deleteFile(USER_DIR, user.uimage);
  if (user.ucompanylogo) await storage.deleteFile(USER_DIR, user.ucompanylogo);

  await repository.deleteUser(userId);
  await invalidateDashboard();

  return { message: "Account deleted" };
}

/**
 * Freezes an account: `adminblock = 1`, and unpublishes its properties.
 *
 * ## The id is the caller's choice, not the caller's
 *
 * `userId` comes from `req.params.id`. Any authenticated user can therefore freeze
 * any other account by calling `POST /api/users/block/<victim uid>`. This is the
 * M00.6 IDOR: M04's note says it was fixed in M00, it was not, and
 * `test/contract/user.test.js` pins the vulnerable behaviour. The fix is to pass
 * `req.user.id` and ignore the path parameter — one line — but it changes a
 * documented response, so it belongs to the milestone that owns the finding.
 *
 * Note that this is **not** the same operation as `adminBlockUser` in
 * `modules/admins`, which writes a `del_account` ledger row and is role-guarded.
 * A self-freeze leaves no ledger entry; an admin freeze does.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 */
async function blockSelf(userId) {
  const user = await repository.findOwnedUser(userId);

  await repository.setPropertiesBlocked(userId, user.uemail, 0);
  await repository.setAdminBlock(userId, true);

  return { message: "Account blocked" };
}

/**
 * Un-freezes: `adminblock = 0`, and republishes its properties.
 *
 * @param {number} userId
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function unblockSelf(userId) {
  const user = await repository.findOwnedUser(userId);

  await repository.setPropertiesBlocked(userId, user.uemail, 1);
  await repository.setAdminBlock(userId, false);

  return { message: "Account unblocked" };
}

/**
 * `GET /users/:id` — the public profile.
 *
 * Public since M04, so this is reachable with no credential. It returns
 * `uemail`, `ugender` and no `dateofbirth`; see
 * `mapper.PUBLIC_PROFILE_FIELDS_SELECT` for the exposure this creates and why the
 * projection is not narrowed here.
 *
 * @param {number} userId
 * @returns {Promise<object>}
 * @throws {AppError} 404 `USER_NOT_FOUND` — also for an inactive account, since
 *   the query filters `deactivate: 1`
 */
async function getPublicProfile(userId) {
  const profile = await repository.findPublicProfile(userId);
  if (!profile) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  return profile;
}

module.exports = {
  getProfile,
  updateProfile,
  updateSocialLinks,
  uploadProfileImage,
  removeProfileImage,
  uploadCompanyLogo,
  removeCompanyLogo,
  changePassword,
  deactivateAccount,
  activateAccount,
  deleteAccount,
  blockSelf,
  unblockSelf,
  getPublicProfile,
};
