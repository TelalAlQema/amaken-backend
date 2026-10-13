/**
 * The only file in `modules/users` that touches Prisma.
 *
 * Straight port of the ten `prisma.*` calls in `services/user.service.js`, with the
 * three problems that file had moved out to where they can be read:
 *
 *   1. **`updateMany` on a user id that is not the caller's** — see the block/unblock
 *      note below.
 *   2. **A single-element `$transaction([...])`** in `deactivateAccount` and
 *      `activateAccount`. An array transaction with one write is a transaction with
 *      no atomicity to offer and an extra round trip to pay for; both are plain
 *      `update` calls now.
 *   3. **Filesystem deletion inside a database operation.** `deleteAccount` removed
 *      the avatar and the logo from disk *before* deleting the row, and
 *      `uploadProfileImage` deleted the old avatar *before* writing the new one.
 *      Both are ordered so that a failure leaves the file gone and the row pointing
 *      at nothing. The order is preserved deliberately — see the note on
 *      {@link findOwnedUser}.
 *
 * ## block/unblock is still wrong, and it is wrong here
 *
 * {@link setBlocked} takes a `userId` and a `flag`, and updates
 * `property.blocked_user` for `{ uid: userId, email: user.uemail }`. That is
 * correct given the id. The bug is upstream: the route passes
 * `req.params.id`, not `req.user.id`, so any authenticated user can freeze anyone.
 *
 * Nothing here decides that — a repository is handed an id and does the write. The
 * fix belongs in the service, which is the layer that knows whose id it is allowed
 * to use, and it is M00.6. The test that pins the current behaviour is
 * `test/contract/user.test.js`.
 *
 * `blocked_user` is inverted relative to `adminblock`, which reads as a mistake and
 * is not: `blocked_user = 0` on a property means "this owner's block applies",
 * `1` means "shown regardless". It is pre-M04 behaviour and both directions are
 * pinned by contract tests.
 */
const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../core/errors");
const mapper = require("./users.mapper");

/**
 * @param {number} userId the `uid`, not the `id`
 * @returns {Promise<object|null>}
 */
function findUserByUid(userId) {
  return prisma.user.findFirst({ where: { uid: userId } });
}

/**
 * `GET /users/me` — the full 30-column record.
 *
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
function findOwnProfile(userId) {
  return prisma.user.findFirst({
    where: { uid: userId },
    select: mapper.select(mapper.PROFILE_FIELDS_SELECT),
  });
}

/**
 * `GET /users/:id` — the public projection, and only for an *active* account.
 *
 * `deactivate: 1` is the active flag (see `mapper.toActivationUpdate`), so this
 * hides a self-deactivated account from the public endpoint while leaving it fully
 * readable at `/users/me`.
 *
 * Note it does **not** filter `adminblock`: a frozen user is still publicly
 * visible, and its properties are unpublished separately via `blocked_user`.
 * Pre-existing; `test/contract/public.test.js` pins it.
 *
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
function findPublicProfile(userId) {
  return prisma.user.findFirst({
    where: { uid: userId, deactivate: 1 },
    select: mapper.select(mapper.PUBLIC_PROFILE_FIELDS_SELECT),
  });
}

/**
 * `PUT /users/me`.
 *
 * The 21-column projection, not the 30-column one from {@link findOwnProfile} —
 * see `mapper.PROFILE_UPDATE_FIELDS_SELECT` for why the two differ.
 *
 * @param {number} userId
 * @param {Record<string, unknown>} data from `mapper.toProfileUpdate`
 * @returns {Promise<object>}
 */
function updateProfile(userId, data) {
  return prisma.user.update({
    where: { uid: userId },
    data,
    select: mapper.select(mapper.PROFILE_UPDATE_FIELDS_SELECT),
  });
}

/**
 * `PUT /users/me/links`. Returns nothing but the count of matched rows; the route
 * responds with a message, not the rows, so the caller re-reads if it needs them.
 *
 * @param {number} userId
 * @param {Record<string, unknown>} data from `mapper.toLinksUpdate`
 * @returns {Promise<object>}
 */
function updateLinks(userId, data) {
  return prisma.user.update({ where: { uid: userId }, data });
}

/**
 * The image/logo column write. One function for four routes because the payload is
 * always `{ column: filename, editColumn: now }` and the only thing that varies is
 * which pair of columns.
 *
 * @param {number} userId
 * @param {Record<string, unknown>} data from a `mapper.to*` helper
 * @returns {Promise<object>}
 */
function setImage(userId, data) {
  return prisma.user.update({ where: { uid: userId }, data });
}

/**
 * `POST /users/me/password`.
 *
 * @param {number} userId
 * @param {string} hash a cost-12 hash from `core/password.hash`
 * @returns {Promise<object>}
 */
function setPassword(userId, hash) {
  return prisma.user.update({
    where: { uid: userId },
    data: { upass: hash, udate: new Date().toISOString() },
  });
}

/**
 * `POST /users/me/{deactivate,activate}`.
 *
 * @param {number} userId
 * @param {boolean} active
 * @returns {Promise<object>}
 */
function setActive(userId, active) {
  return prisma.user.update({ where: { uid: userId }, data: mapper.toActivationUpdate(active) });
}

/**
 * `DELETE /users/me`.
 *
 * A bare `delete`. The legacy comment said "delete images" immediately above it and
 * the caller did that part; nothing cascades in the schema, so a user row with
 * properties still referencing it is deleted and the properties are orphaned
 * unless the caller removes them first. See `users.service.deleteAccount` for the
 * order in which that happens, and why it is the wrong order.
 *
 * @param {number} userId
 * @returns {Promise<object>}
 */
function deleteUser(userId) {
  return prisma.user.delete({ where: { uid: userId } });
}

/**
 * Posts a property's visibility to the owner's freeze flag.
 *
 * `email` is in the `where` as well as `uid`, which looks redundant because `uid`
 * alone is unique. It is not redundant: `property.uid` is set by the *author* at
 * create time, and a row whose `email` disagrees with its owner is a data-integrity
 * problem. Matching on both means a mismatched row is left alone rather than
 * flipped, which is the conservative direction.
 *
 * @param {number} userId
 * @param {string} email
 * @param {number} blockedUser `0` when freezing, `1` when unfreezing
 * @returns {Promise<{ count: number }>}
 */
function setPropertiesBlocked(userId, email, blockedUser) {
  return prisma.property.updateMany({
    where: { uid: userId, email },
    data: { blocked_user: blockedUser },
  });
}

/**
 * `POST /users/{block,unblock}/:id` — the `adminblock` switch on the user row.
 *
 * @param {number} userId
 * @param {boolean} blocked
 * @returns {Promise<object>}
 */
function setAdminBlock(userId, blocked) {
  return prisma.user.update({ where: { uid: userId }, data: { adminblock: blocked ? 1 : 0 } });
}

/**
 * The two `findFirst`s the legacy service ran before every mutating call, folded
 * into one helper so "the user must exist" is stated once.
 *
 * It returns the **whole row**, not the projection, because the callers need
 * `uimage` and `ucompanylogo` to remove files from disk and `uemail` to scope the
 * property update. Selecting a subset here and then re-reading in the service is
 * the pattern that produced four slightly different `findFirst` calls in the legacy
 * file, one of which had forgotten the columns it needed.
 *
 * @param {number} userId
 * @returns {Promise<object>} the user row
 * @throws {import("../../core/errors").AppError} 404 `USER_NOT_FOUND`
 */
async function findOwnedUser(userId) {
  const user = await findUserByUid(userId);
  if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  return user;
}

module.exports = {
  findUserByUid,
  findOwnProfile,
  findPublicProfile,
  updateProfile,
  updateLinks,
  setImage,
  setPassword,
  setActive,
  deleteUser,
  setPropertiesBlocked,
  setAdminBlock,
  findOwnedUser,
};