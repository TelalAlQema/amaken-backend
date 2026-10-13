/**
 * `accounts` — the two identity ledgers.
 *
 * `del_account` records that an address was deleted or blocked. `register_email`
 * records that an address completed registration. Neither is a user; both are the
 * **history** of users, and they answer questions no other table can:
 *
 *   - "was this address ever used, and how did it end?" — `del_account`, which is
 *     why a deleted address is not immediately re-registerable;
 *   - "did this address ever finish signing up?" — `register_email`, which is what
 *     the admin "registered" list reads.
 *
 * ## Why this is a module at all
 *
 * Before M04 both tables were reached through `prisma` directly, from four
 * different files, and `del_account` in particular was written by three unrelated
 * code paths. The cost was not that the writes were scattered — it was that a
 * freeze, a delete and a self-delete all *invented* their own ledger semantics,
 * and they did not agree.
 *
 * `services/admin.service.js:350-376` and `:432-453` both ran an `await` **inside**
 * a `prisma.$transaction([...])` array literal. That is the bug this module exists
 * to make un-repeatable: the `await prisma.delAccount.findFirst(...)` ran
 * *before* the batch was even assembled, on a connection that was not in the
 * transaction, and its `?? -1` fallback meant a first-time freeze tried to create a
 * row with `id: -1`. It only failed because `-1` happened to be unused.
 *
 * With `@@unique([email])` on `del_account` the whole thing is one statement:
 * `upsert({ where: { email } })`. There is no id to guess and no read to race.
 *
 * ## `mounts: []` — this module has no endpoints
 *
 * The four admin account screens (`/api/admin/accounts/{registered,deleted,blocked}`
 * and `DELETE /api/admin/accounts/:id`) are part of the **frozen route table** and
 * stay where the client expects them, under `modules/admins`. This module is the
 * logic behind them; it does not own the URLs.
 *
 * `users` and `auth` also write and read these ledgers. Those callers go through
 * `index.js`'s named capabilities, per the module contract.
 */
const accounts = require("./accounts.service");

module.exports = {
  name: "accounts",

  /**
   * Empty on purpose — see the header. This module publishes a capability, not a
   * router, and a manifest with `mounts: []` is the honest way to say so. The
   * registration loop in `bootstrap/registerModules.js` iterates zero mounts, so
   * adding one to this list would be the only way to change it.
   */
  mounts: [],

  /**
   * The capability surface. Every entry is a dependency edge this module now owns.
   *
   * Split by caller rather than grouped by table, because that is what makes the
   * surface reviewable: a reader can see at a glance that `admins` needs the four
   * list operations and the ledger write, and `auth` needs only the two address
   * lookups. One flat list would hide that `auth` has no business deleting a
   * ledger record.
   */
  capabilities: {
    // ── called by `modules/admins` ────────────────────────────────────────────
    // The URLs live in `modules/admins` (frozen route table); these are the
    // implementations behind them, which is why `mounts` is empty.
    //
    // The three list operations answer with `{ accounts, pagination }`, **not**
    // `pagedResult`'s `{ items, pagination }` — see the note in
    // `accounts.repository.js`.
    /** `GET /api/admin/accounts/registered` */
    listRegistered: accounts.listRegistered,
    /** `GET /api/admin/accounts/deleted` */
    listDeleted: accounts.listDeleted,
    /** `GET /api/admin/accounts/blocked` */
    listBlocked: accounts.listBlocked,
    /** `DELETE /api/admin/accounts/:id` */
    deleteRecord: accounts.deleteRecord,
    /**
     * The freeze/delete ledger write. Takes a `tx` because it is always part of a
     * larger transaction — see the header for why that matters.
     */
    recordLedger: accounts.recordLedger,
    /** `DELETE` of the ledger row, for an unfreeze. Takes a `tx`. */
    clearLedger: accounts.clearLedger,

    // ── called by `modules/auth` ──────────────────────────────────────────────
    /** Registration and login both refuse a blocked or deleted address. */
    findLedgerByEmail: accounts.findLedgerByEmail,
    /** Refuses a re-registration of an address that already completed one. */
    findRegistrationByEmail: accounts.findRegistrationByEmail,
    /** Registration writes the `user` and its `register_email` row together. */
    createUserWithRegistration: accounts.createUserWithRegistration,
    /** The "you have been suspended / removed" rule, with its two vocabularies. */
    ledgerVerdict: accounts.ledgerVerdict,
  },

  /**
   * Deliberately **not** published:
   *
   *   - `assertLedgerType` / `ledgerPayload` — the `type` → `utype` translation is
   *     a detail of writing *this* table. A caller that needed it would be
   *     constructing a `del_account` row by hand, which is the accident M04 removes.
   *     It passes `{ email, type, date }` instead and gets a correct `utype`.
   *   - `hasRegistered` — a boolean over one nullable row, and the only caller
   *     (`auth`) needs to distinguish "no row" from "row" anyway to build its error.
   *   - `LEDGER_TYPE` — same reasoning: nobody outside should know the ledger's
   *     spelling, and `recordLedger` validates it.
   */
};