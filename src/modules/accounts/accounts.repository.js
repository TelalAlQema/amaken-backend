/**
 * The only file in `modules/accounts` that touches Prisma.
 *
 * Two tables, both thin. The only non-obvious thing in here is {@link upsertLedger},
 * and its comment is the reason this module exists — read that before changing it.
 *
 * ## The `del_account` write, before and after
 *
 * **Before** (`services/admin.service.js:363-374`, and again at `:437-449`):
 *
 *     await prisma.$transaction([
 *       prisma.user.update({ … }),
 *       prisma.delAccount.upsert({
 *         where: { id: (await prisma.delAccount.findFirst({ where: { email } }))?.id ?? -1 },
 *         create: { email, type, utype, date: now },
 *         update: { type, date: now },
 *       }),
 *       // …
 *     ]);
 *
 * Four things are wrong with that, and only the last one is visible in a test:
 *
 *   1. **The `await` is inside the array literal.** JavaScript evaluates the array
 *      elements left to right, so the `findFirst` runs and *completes* before
 *      `$transaction` is ever called. The read happens on a connection outside the
 *      transaction, so it sees whatever was committed before it started.
 *   2. **`?? -1` is a primary key.** With no ledger row, `where: { id: -1 }` matches
 *      nothing and Prisma takes the `create` branch — with `id` supplied as `-1`,
 *      which succeeds the first time and then collides forever after.
 *   3. **Read-then-write is not atomic.** Two concurrent freezes of the same
 *      address both read null and both attempt a create.
 *   4. **The `date` is overwritten on update.** Freezing a user who had already
 *      been deleted re-stamped the *delete* ledger with the freeze time, so the
 *      `del_account` row claimed the account was blocked rather than deleted — and
 *      the admin "deleted accounts" list silently lost it.
 *
 * **After** (`@@unique([email])`, M04): one statement, no id, no read, and the
 * `update` branch touches only `type`. The date stops being rewritten for the same
 * row, which is what point 4 was about.
 *
 * ## Why the repository takes a `tx`
 *
 * {@link upsertLedger} and {@link clearLedger} accept a transaction client, because
 * their only real callers are inside a transaction that also writes `user`,
 * `property` and `feedback`. A ledger row that committed while the user update
 * rolled back would block an account that still exists — the worst possible
 * failure direction for this table.
 *
 * Passing the client in rather than opening a transaction here keeps the
 * transaction's scope with the operation that decided it, which is the caller's.
 */
const { prisma, withTransaction } = require("../../platform/db/prisma");
const { paginate, toPrismaArgs } = require("../../core/http/pagination");

/**
 * @param {string} email
 * @returns {Promise<object|null>}
 */
function findLedgerByEmail(email) {
  return prisma.delAccount.findFirst({ where: { email } });
}

/**
 * @param {string} email
 * @returns {Promise<object|null>}
 */
function findRegistrationByEmail(email) {
  return prisma.registerEmail.findFirst({ where: { email } });
}

/**
 * The single-statement ledger upsert. See the file header for what this replaced.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ email: string, type: "delete" | "block", utype: string, date: Date }} input
 * @returns {Promise<object>} the ledger row
 */
function upsertLedger(tx, { email, type, utype, date }) {
  return tx.delAccount.upsert({
    // Safe because of `@@unique([email])` on the model. Without that constraint
    // this is not a compile error — Prisma accepts a non-unique field here and
    // fails at runtime with a message about a missing unique constraint, which is
    // the shape of bug this module was created to end.
    where: { email },
    create: { email, type, utype, date },
    // `type` only. The pre-M04 version also wrote `date`, which re-stamped an
    // existing delete ledger on every freeze — see point 4 in the file header.
    update: { type },
  });
}

/**
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} email
 * @returns {Promise<{ count: number }>}
 */
function clearLedger(tx, email) {
  return tx.delAccount.deleteMany({ where: { email } });
}

/**
 * The three admin account screens.
 *
 * ## Canonical list result
 *
 * `core/http/pagination.js` offers `pagedResult()`, which returns
 * The API response helper wraps these rows in the single `{ items, pagination }`
 * contract. `paginate()` supplies its four-key pagination metadata.
 */

/**
 * `GET /api/admin/accounts/registered`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
async function listRegistered(page) {
  const [accounts, total] = await Promise.all([
    prisma.registerEmail.findMany({
      orderBy: { id: "desc" },
      ...toPrismaArgs(page),
    }),
    prisma.registerEmail.count(),
  ]);
  return { items: accounts, pagination: paginate({ ...page, total }) };
}

/**
 * `GET /api/admin/accounts/deleted`. `type` is the ledger's own lowercase
 * vocabulary (`"delete"`), not `User.utype` — see `accounts.service.LEDGER_TYPE`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
async function listDeleted(page) {
  const [accounts, total] = await Promise.all([
    prisma.delAccount.findMany({
      where: { type: "delete" },
      orderBy: { id: "desc" },
      ...toPrismaArgs(page),
    }),
    prisma.delAccount.count({ where: { type: "delete" } }),
  ]);
  return { items: accounts, pagination: paginate({ ...page, total }) };
}

/**
 * `GET /api/admin/accounts/blocked`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
async function listBlocked(page) {
  const [accounts, total] = await Promise.all([
    prisma.delAccount.findMany({
      where: { type: "block" },
      orderBy: { id: "desc" },
      ...toPrismaArgs(page),
    }),
    prisma.delAccount.count({ where: { type: "block" } }),
  ]);
  return { items: accounts, pagination: paginate({ ...page, total }) };
}

/**
 * @param {number} id
 * @returns {Promise<object|null>}
 */
function findRecordById(id) {
  return prisma.delAccount.findFirst({ where: { id } });
}

/**
 * @param {number} id
 * @returns {Promise<object>}
 */
function deleteRecord(id) {
  return prisma.delAccount.delete({ where: { id } });
}

/**
 * Creates a user and its registration ledger row together, or neither.
 *
 * Lives here rather than in `modules/auth` because `register_email` is this
 * module's table; `auth.repository` has carried this cross-module write since M03,
 * commented at the call site as the dependency M04 was meant to remove. The write
 * itself stays legal under ADR 0002 — one client, one schema — but it now happens
 * in the module that owns the row.
 *
 * @param {object} userData a `user` create payload
 * @param {object} ledgerData a `registerEmail` create payload
 * @returns {Promise<object>} the created user
 */
function createUserWithRegistration(userData, ledgerData) {
  return withTransaction(async (tx) => {
    await tx.registerEmail.create({ data: ledgerData });
    return tx.user.create({ data: userData });
  });
}

module.exports = {
  findLedgerByEmail,
  findRegistrationByEmail,
  upsertLedger,
  clearLedger,
  listRegistered,
  listDeleted,
  listBlocked,
  findRecordById,
  deleteRecord,
  createUserWithRegistration,
};
