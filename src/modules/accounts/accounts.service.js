/**
 * `accounts` business rules.
 *
 * Thin on purpose. Almost everything here is a shape decision — the admin account
 * screens return Prisma rows with `email`/`type`/`utype` keys that the React admin
 * reads directly, so "fixing" the response shape is a client-breaking change and is
 * explicitly out of scope for a structural milestone.
 *
 * The service is also the **only** thing other modules may call. Per
 * `architecture/module-contract.md` a capability is published on `index.js` and
 * implemented on the service; nobody imports `accounts.repository` from outside
 * this directory. That is not fussiness — it is what makes "who can delete a ledger
 * row" answerable by reading one file.
 *
 * ## The ledger write, and the `tx` argument
 *
 * {@link recordLedger} and {@link clearLedger} both take a transaction client from
 * their caller and never open one. Their callers are
 * building a larger transaction — a freeze writes `user` *and* `del_account` and
 * sometimes `property` — and a ledger row that committed while the rest rolled back
 * would block an account that still exists. That is the worst possible failure
 * direction for this table, so the scope of the transaction belongs to whoever
 * decided what the operation is.
 */
const { AppError } = require("../../core/errors");
const repository = require("./accounts.repository");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

/**
 * The ledger's type vocabulary.
 *
 * `del_account.type` is lowercase — `"delete"` and `"block"` — and this module is
 * the only writer of it now. Those two values are read: the admin accounts screens
 * filter on them, and `modules/auth` branches on them.
 *
 * Note this is **not** `user.utype`, which is `User` / `Agent` / `Builder` (mixed
 * case, from `modules/users`) or `USER` / `ADMIN` (uppercase, checked by
 * `requireRole`). Same conceptual field, three vocabularies, three modules. They
 * never meet because they live in different tables.
 */
const LEDGER_TYPE = Object.freeze({
  delete: "delete",
  block: "block",
});

/**
 * `del_account.utype` — written on every ledger row and **read by nothing**.
 *
 * Verified: the only two writes in the pre-M04 tree were
 * `services/admin.service.js:368` and `:442`, both `utype: "user"`, and there is no
 * read anywhere in `src/`. (`auth.service.js:216` reads `register_email.utype`, a
 * different table with a different vocabulary.)
 *
 * An earlier draft of this file "corrected" the value to `DELETED` / `BLOCKED` to
 * match `User.utype`, on the theory that the column was meant to mirror it. It was
 * not: `adminBlockUser` wrote `utype: "BLOCK"`, which is in neither vocabulary, and
 * that row displayed correctly in the admin UI because the UI groups by `type`. So
 * the column has held `"user"`, `"BLOCK"` and (in a fourth path) nothing
 * meaningful, and never mattered.
 *
 * M04 keeps `"user"`. The column has no reader, so normalising it would change
 * stored data in a structural milestone for no observable gain — and the next
 * person to read this table deserves to find that the inconsistency was deliberate
 * rather than assuming they should go and "fix" the other values too.
 *
 * @type {string}
 */
const LEDGER_UTYPE = "user";

/**
 * Validates a ledger write's `type` and returns the payload's `utype`.
 *
 * Validation is still worth having: `type` **is** read, by the admin screens and by
 * `auth`, so a typo here would write a row that no screen can find and that the
 * login path does not treat as blocked. A 400 at the boundary is better than a
 * ledger row that silently fails to protect an account.
 *
 * @param {string} type `"delete"` or `"block"`
 * @returns {string} {@link LEDGER_UTYPE}
 * @throws {AppError} 400 `INVALID_LEDGER_TYPE`
 */
function assertLedgerType(type) {
  if (!LEDGER_TYPE[type]) {
    throw new AppError(`Unknown ledger type "${type}"`, 400, "INVALID_LEDGER_TYPE");
  }
  return LEDGER_UTYPE;
}

/**
 * Builds the `del_account` payload for a freeze or a delete.
 *
 * Shared by `admins` (freezing and deleting someone else) so every admin path
 * writes identical rows. `date` is passed in rather than defaulted to `new Date()`
 * because the caller is inside a transaction and wants the timestamp it already
 * chose — and because two rows written in one transaction should agree.
 *
 * @param {{ email: string, type: "delete" | "block", date?: Date }} input
 * @returns {{ email: string, type: string, utype: string, date: Date }}
 */
function ledgerPayload({ email, type, date }) {
  return {
    email,
    type,
    utype: assertLedgerType(type),
    // `date` arrives as a `Date`. The pre-M04 callers passed an ISO **string** to a
    // `DateTime` column, which Prisma accepts and coerces — but only because it
    // happened to be a valid ISO string, and the column stored it at second
    // precision either way. An explicit `Date` says what is meant.
    date: date ?? new Date(),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * @param {string} email
 * @returns {Promise<object|null>} the `del_account` row, or null
 */
async function findLedgerByEmail(email) {
  return repository.findLedgerByEmail(email);
}

/**
 * @param {string} email
 * @returns {Promise<object|null>} the `register_email` row, or null
 */
async function findRegistrationByEmail(email) {
  return repository.findRegistrationByEmail(email);
}

// ── the ledger write ────────────────────────────────────────────────────────

/**
 * Records a freeze or a delete. **Inside the caller's transaction.**
 *
 * This replaces the read-then-upsert described in `accounts.repository`'s header,
 * and it is one statement now rather than a `findFirst` outside the transaction
 * plus an `id: ?? -1` guess.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ email: string, type: "delete" | "block", date?: Date }} input
 * @returns {Promise<object>} the ledger row
 */
function recordLedger(tx, { email, type, date }) {
  return repository.upsertLedger(tx, ledgerPayload({ email, type, date }));
}

/**
 * Removes a ledger row, for an unfreeze or an admin deleting a ledger entry.
 * **Inside the caller's transaction.**
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} email
 * @returns {Promise<{ count: number }>}
 */
function clearLedger(tx, email) {
  return repository.clearLedger(tx, email);
}

// ── the admin account screens ───────────────────────────────────────────────

/**
 * `GET /api/admin/accounts/registered`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
function listRegistered(page) {
  return repository.listRegistered(page);
}

/**
 * `GET /api/admin/accounts/deleted`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
function listDeleted(page) {
  return repository.listDeleted(page);
}

/**
 * `GET /api/admin/accounts/blocked`.
 *
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
function listBlocked(page) {
  return repository.listBlocked(page);
}

/**
 * `DELETE /api/admin/accounts/:id` — removes the ledger row itself.
 *
 * Note what this does **not** do: it does not unblock or undelete the user. It
 * forgets that the event happened. The admin UI's "delete" button on a blocked
 * account therefore clears the block's history without restoring access, which is
 * confusing but is the pre-M04 behaviour, pinned here deliberately.
 *
 * Both strings are the legacy ones: the 404 says "Account record not found" and the
 * 200 says "Account record deleted". No test covers them, but the admin app shows
 * the success message to an operator, and "Ledger record deleted" would be a
 * different string in the same UI that also says "Account record deleted" in
 * another column.
 *
 * @param {number} id
 * @returns {Promise<{ message: string }>}
 * @throws {AppError} 404 `NOT_FOUND`
 */
async function deleteRecord(id) {
  const record = await repository.findRecordById(id);
  if (!record) throw new AppError("Account record not found", 404, "NOT_FOUND");

  await repository.deleteRecord(id);
  await invalidateDashboard();
  return { message: "Account record deleted" };
}

/**
 * Whether an address is unusable, and why.
 *
 * Called on registration and on login. A `delete` ledger row and a `block` row mean
 * the same thing to this application — you cannot sign in — but they are reported
 * differently, because telling a blocked user they were "deleted" would disclose a
 * moderation decision, and telling a deleted user they were "blocked" is just
 * wrong.
 *
 * @param {object | null} ledger a `del_account` row
 * @returns {{ blocked: boolean, deleted: boolean, reason: string | null }}
 */
function ledgerVerdict(ledger) {
  if (!ledger) return { blocked: false, deleted: false, reason: null };

  const blocked = ledger.type === "block";
  const deleted = ledger.type === "delete";

  return {
    blocked,
    deleted,
    reason: blocked ? "Your account has been suspended" : "Your account has been removed",
  };
}

/**
 * Whether an address has already completed registration.
 *
 * `register_email` is the authority for this, **not** `user`, because it survives
 * deletion: the ledger's entire purpose is that a deleted address cannot silently
 * re-register and have its history vanish. See the module header.
 *
 * @param {object | null} registration a `register_email` row
 * @returns {boolean}
 */
function hasRegistered(registration) {
  return Boolean(registration);
}

/**
 * Creates a user and its `register_email` row together, or neither.
 *
 * Called by `modules/auth`. This write lived in `auth.repository` since M03 under an
 * ADR 0002 cross-module comment; it is here now because `register_email` is this
 * module's table and the whole point of M04 is that one module owns one concern.
 *
 * @param {object} userData a `user` create payload
 * @param {{ email: string, firstname?: string, lastname?: string }} ledgerData
 * @returns {Promise<object>} the created user
 */
async function createUserWithRegistration(userData, ledgerData) {
  const user = await repository.createUserWithRegistration(userData, ledgerData);
  await invalidateDashboard();
  return user;
}

module.exports = {
  LEDGER_TYPE,
  findLedgerByEmail,
  findRegistrationByEmail,
  recordLedger,
  clearLedger,
  listRegistered,
  listDeleted,
  listBlocked,
  deleteRecord,
  ledgerVerdict,
  hasRegistered,
  createUserWithRegistration,
};
