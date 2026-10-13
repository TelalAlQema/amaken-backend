/**
 * The only file in `modules/auth` that touches Prisma.
 *
 * Every query the module needs and nothing else. There is no business rule here:
 * an `AppError` thrown from this file would be a rule wearing a disguise, because
 * the layer above cannot tell the difference when reviewing a diff.
 *
 * ## Two of these tables are not the module's
 *
 * `DelAccount` and `RegisterEmail` are the ledgers that M04 will extract into
 * `modules/accounts`. Writing them from here is legal under
 * [ADR 0002](../../../docs/adr/0002-single-prisma-client-split-schema.md) — one
 * client, one schema — and it is commented at each call site so a reviewer sees a
 * decision rather than an accident.
 */
// `withTransaction` moved out with `createUserWithLedger`: the only transaction this
// repository used was the one wrapping the ledger write, and that now lives in
// `modules/accounts`.
const { prisma } = require("../../platform/db/prisma");

/**
 * @param {string} email already lower-cased and trimmed by the service
 * @returns {Promise<object|null>}
 */
function findUserByEmail(email) {
  return prisma.user.findFirst({ where: { uemail: email } });
}

/**
 * @param {number|string} uid
 * @returns {Promise<object|null>}
 */
function findUserById(uid) {
  return prisma.user.findFirst({ where: { uid: Number(uid) } });
}

/**
 * M04 removed three functions from this file, and this is where they went:
 *
 *   - `findDeletedAccountByEmail` → `accounts.capabilities.findLedgerByEmail`
 *   - `findRegisterEmailByEmail`  → `accounts.capabilities.findRegistrationByEmail`
 *   - `createUserWithLedger`      → `accounts.capabilities.createUserWithRegistration`
 *
 * All three were marked in place as "becomes `modules/accounts` in M04", and all
 * three now are. Each was an ADR 0002 cross-module read or write with a comment
 * explaining why it was legal — legal, but a `user` repository reaching into the
 * identity ledger, which is the coupling M04 exists to remove.
 *
 * `createUserWithRegistration` keeps the transaction that made it atomic in M03:
 * a `register_email` failure must not leave a live account the admin "registered"
 * list does not show.
 */

/**
 * @param {number} uid
 * @returns {Promise<object>}
 */
function markLogin(uid) {
  return prisma.user.update({ where: { uid }, data: { uloginvalue: 1 } });
}

/**
 * Rewrites a stored hash that was verified against a legacy digest, so the upgrade
 * is invisible to the user and happens exactly once per account.
 *
 * @param {number} uid
 * @param {string} hash
 * @returns {Promise<object>}
 */
function upgradePasswordHash(uid, hash) {
  return prisma.user.update({ where: { uid }, data: { upass: hash } });
}

/**
 * Sets a new password **and invalidates every outstanding token** by bumping
 * `tokenVersion`.
 *
 * The bump is the whole reason the claim exists: without it a password reset left
 * a stolen refresh token working for the remaining seven days, which makes "I reset
 * my password because someone had it" a statement with no effect.
 *
 * @param {string} email
 * @param {string} hash
 * @param {string} date ISO string, matching the column's `VarChar(100)` shape
 * @returns {Promise<{count: number}>}
 */
function replacePassword(email, hash, date) {
  return prisma.user.updateMany({
    where: { uemail: email },
    data: { upass: hash, udate: date, tokenVersion: { increment: 1 } },
  });
}

/**
 * @param {string} email already lower-cased and trimmed by the service
 * @returns {Promise<object|null>}
 */
function findAdminByEmail(email) {
  return prisma.admin.findFirst({ where: { aemail: email } });
}

module.exports = {
  findUserByEmail,
  findUserById,
  markLogin,
  upgradePasswordHash,
  replacePassword,
  findAdminByEmail,
};