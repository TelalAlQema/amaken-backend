/**
 * The only file in `modules/admins` that touches Prisma.
 *
 * The `admin` and `user` tables both live here, and that is not a layering
 * complaint: the admin endpoints *are* operations on those rows. The freeze and
 * delete transactions write `user`, `property`, `feedback` and `del_account`
 * together, and splitting them across two modules' repositories would mean passing
 * a transaction client between modules to get one atomic operation — so the
 * admin-facing transaction stays whole, and `del_account` is delegated to
 * `modules/accounts` with that client. See ADR 0002 and `accounts.repository`.
 *
 * ## The three transactions, and the bug they had
 *
 * `adminFreezeUser`, `adminUnfreezeUser` and `adminDeleteUser` each used
 * `prisma.$transaction([...])` with an `await` **inside the array literal**:
 *
 *     prisma.$transaction([
 *       prisma.user.update({ … }),
 *       prisma.delAccount.upsert({
 *         where: { id: (await prisma.delAccount.findFirst({ … }))?.id ?? -1 },
 *         …
 *       }),
 *     ]);
 *
 * JavaScript evaluates the array elements left to right, so that `await` completed
 * *before* `$transaction` was called — on a connection outside the transaction, and
 * `await` suspends the function, so the reads were issued immediately rather than
 * when `$transaction` walked the array. The result: a `findFirst` that could not
 * see the transaction's own writes, a primary key of `-1` when there was no ledger
 * row, and a read-then-upsert race between two concurrent freezes.
 *
 * All three are interactive transactions now, and the ledger write is a
 * single-statement `upsert` on `@@unique([email])`. The ordering of the statements
 * inside each transaction is unchanged, because in a freeze the order of
 * `user` → `property` → `feedback` → ledger is not observable — they touch disjoint
 * tables — while in a delete the *last* statement matters a great deal. See
 * {@link deleteUserRow}.
 */
const { prisma, withTransaction } = require("../../platform/db/prisma");
const { AppError } = require("../../core/errors");
const { paginate, toPrismaArgs } = require("../../core/http/pagination");
const accounts = require("../accounts");
const mapper = require("./admins.mapper");

// ── pin ─────────────────────────────────────────────────────────────────────

/**
 * The single PIN row, oldest first.
 *
 * `findFirst({ orderBy: { id: "asc" } })` — the table is expected to hold exactly
 * one row and the code picks the first rather than asserting that. It is compared
 * with `bcrypt.compare` against `upin`, so the PIN is a hash, not the digits
 * themselves; there is no plaintext PIN anywhere.
 *
 * @returns {Promise<object|null>}
 */
function findFirstPin() {
  return prisma.pin.findFirst({ orderBy: { id: "asc" } });
}

// ── admin ───────────────────────────────────────────────────────────────────

/**
 * @param {string} aemail already lowercased by the caller
 * @returns {Promise<object|null>}
 */
function findAdminByEmail(aemail) {
  return prisma.admin.findFirst({ where: { aemail } });
}

/**
 * @param {number} aid
 * @returns {Promise<object|null>}
 */
function findAdminById(aid) {
  return prisma.admin.findFirst({ where: { aid } });
}

/**
 * `GET /admin/profile` — 24 columns, and no `apass`.
 *
 * Every `admin` read in this module is an explicit `select` **except**
 * {@link updateAdminRow}, which is why the omission has to be deliberate here.
 *
 * @param {number} aid
 * @returns {Promise<object|null>}
 */
function findAdminProfile(aid) {
  return prisma.admin.findFirst({
    where: { aid },
    select: {
      aid: true,
      aname: true,
      alname: true,
      aemail: true,
      aphone: true,
      atype: true,
      aimage: true,
      agency: true,
      companylogo: true,
      astate: true,
      acity: true,
      agender: true,
      adateofbirth: true,
      aAddress: true,
      awphone: true,
      adminblock: true,
      main: true,
      website: true,
      afb: true,
      ainstagram: true,
      atwitter: true,
      atiktok: true,
      alinkedin: true,
    },
  });
}

/**
 * `PUT /admin/profile`.
 *
 * ## This returns the whole row, `apass` included
 *
 * The pre-M04 service passed no `select`, so Prisma returned every column —
 * `apass` (the bcrypt hash), `atokenversion`, `aloginvalue` — and the handler sent
 * it to the browser as `data`. Any admin's password hash and token version is
 * therefore in the network tab of the admin profile page.
 *
 * A hash is not a password, but it is enough to mount an offline cracking
 * dictionary against it, and `atokenversion` is a secret-adjacent knob: knowing it
 * lets someone reason about token invalidation.
 *
 * This is **not fixed here** — see `admins.service.updateAdminProfile`, which
 * explains why a `select` on this endpoint is a change with a client-visible
 * consequence and belongs to the milestone that owns the finding. `apass` is
 * deliberately not projected here either, so that when that milestone lands it is
 * a one-line diff in a file that already gets this right three times.
 */
function updateAdminRow(aid, data) {
  return prisma.admin.update({ where: { aid }, data });
}

/**
 * Writes one image column. Same helper as the user's, different table.
 *
 * @param {number} aid
 * @param {Record<string, string>} data `{ aimage }` or `{ companylogo }`
 * @returns {Promise<object>}
 */
function setAdminImage(aid, data) {
  return prisma.admin.update({ where: { aid }, data });
}

/**
 * `POST /admin/login` — `aloginvalue = 1`.
 *
 * Written as a separate `update` after the password check rather than folded into
 * it, because the pre-M04 code also updated `apass` there (the hash upgrade). The
 * upgrade is now `core/password`'s job and returns a hash instead of writing it, so
 * the caller decides whether to write one or two columns.
 *
 * @param {number} aid
 * @param {string} [upgradeHash] a cost-12 hash to persist, when the stored one was weak
 * @returns {Promise<object>}
 */
function markLogin(aid, upgradeHash) {
  return prisma.admin.update({
    where: { aid },
    data: upgradeHash ? { aloginvalue: 1, apass: upgradeHash } : { aloginvalue: 1 },
  });
}

/**
 * `PUT /admin/profile/password`.
 *
 * @param {number} aid
 * @param {string} hash
 * @returns {Promise<object>}
 */
function setAdminPassword(aid, hash) {
  return prisma.admin.update({ where: { aid }, data: { apass: hash } });
}

// ── admin social links ──────────────────────────────────────────────────────

/**
 * `PUT /admin/profile/links` — the `adminSocial` upsert.
 *
 * The two branches are genuinely different and must not be merged:
 *
 *   - `create` writes all six columns, mapping `""` to `null`, because the row does
 *     not exist and there is nothing to preserve;
 *   - `update` passes `undefined` for absent fields, which Prisma reads as "leave
 *     this column alone", so a partial submit only changes what it names.
 *
 * The legacy code had exactly this asymmetry. Collapsing it to one `data` object
 * would turn "save an empty form" from a no-op into "clear every link", on the
 * second submit onwards. `mapper.toSocialLinkPayload` builds the two branches —
 * see its header for why they are shaped separately rather than inline here.
 *
 * @param {number} aid
 * @param {Record<string, string | undefined>} data validated `adminLinksSchema` body
 * @returns {Promise<object>}
 */
function updateSocialLinks(aid, data) {
  const payload = mapper.toSocialLinkPayload(data);

  return prisma.adminSocial.upsert({
    where: { admin_id: aid },
    create: { admin_id: aid, ...payload.create },
    update: { ...payload.update, updated_at: new Date() },
  });
}

// ── user lists ──────────────────────────────────────────────────────────────

/**
 * The `select` for `GET /admin/users` and its three filtered variants.
 *
 * 11 columns. Deliberately excludes `upass` — this one was already a `select` in
 * the pre-M04 service and is the counterexample that makes
 * {@link updateAdminRow} look like an oversight rather than a decision.
 */
const USER_LIST_SELECT = Object.freeze({
  uid: true,
  uname: true,
  lname: true,
  uemail: true,
  utype: true,
  uimage: true,
  ugender: true,
  adminblock: true,
  deactivate: true,
  uloginvalue: true,
  lastseen: true,
});

/**
 * `GET /admin/users`, `/users/agents`, `/users/builders`.
 *
 * All three are this function with a different `utype`. The pre-M04 routes called
 * `listUsers("Agent", …)` by hand from each one; there was no reason for that to be
 * three copies of the same query except that they were written three times.
 *
 * ## The response key is `users`
 *
 * Returns the canonical `{ items, pagination }` list result.
 *
 * @param {string | undefined} type `User` / `Agent` / `Builder`; undefined = all
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
async function listUsers(type, page) {
  const where = type ? { utype: type } : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: USER_LIST_SELECT,
      orderBy: { uid: "desc" },
      ...toPrismaArgs(page),
    }),
    prisma.user.count({ where }),
  ]);

  return { items: users, pagination: paginate({ ...page, total }) };
}

/**
 * `GET /admin/users/admins` — **not paginated**.
 *
 * Returns a bare array. The pre-M04 route called `listAdmins()` with no page
 * argument and returned the result directly, so this endpoint has no `pagination`
 * key at all while its four siblings do. The admin UI knows which is which.
 *
 * @returns {Promise<object[]>}
 */
function listAdmins() {
  return prisma.admin.findMany({
    select: {
      aid: true,
      aname: true,
      alname: true,
      aemail: true,
      aphone: true,
      atype: true,
      aimage: true,
      adminblock: true,
      main: true,
      adeactivate: true,
    },
    orderBy: { aid: "asc" },
  });
}

// ── the freeze / delete transactions ────────────────────────────────────────

/**
 * `PUT /admin/users/:id/status` → `freeze`.
 *
 * One transaction over four tables. `lastseen` is stamped with `now` even though
 * the account is being frozen — the pre-M04 code did that too, and it means a
 * frozen account's "last seen" is the moment it was frozen rather than the moment
 * it was last active. Preserved; `adminblock`, not `deactivate`, is what actually
 * stops the login.
 *
 * @param {object} user the row from {@link findUserRow}
 * @param {Date} now
 * @returns {Promise<{ user: object }>}
 */
function freezeUser(user, now) {
  return withTransaction(async (tx) => {
    const iso = now.toISOString();

    await tx.user.update({
      where: { uid: user.uid },
      data: { uloginvalue: 0, lastseen: iso, adminblock: 1 },
    });

    // Scoped by **email**, not `uid`. Both pre-M04 paths did this, and it is not
    // equivalent: `property.uid` is the author and `property.email` is the account
    // the listing belongs to. A property authored by an admin on a user's behalf
    // carries the admin's `uid` and the user's `email`, so a `uid` scope would miss
    // it and an `email` scope would catch it. The email is the broader and — for
    // freezing someone's presence — the intended scope.
    await tx.property.updateMany({ where: { email: user.uemail }, data: { adminblock: 1 } });
    await tx.feedback.updateMany({
      where: { send_email: user.uemail },
      data: { fadminblock: 1 },
    });

    await accounts.capabilities.recordLedger(tx, {
      email: user.uemail,
      type: "block",
      date: now,
    });

    return { user };
  });
}

/**
 * `PUT /admin/users/:id/status` → `unfreeze`.
 *
 * Clears all three flags **and** deletes the ledger row, so a re-frozen user starts
 * from a clean `del_account` and the next freeze re-creates it with a fresh date.
 *
 * Note that this touches `property.adminblock`, whereas the user's own
 * `POST /users/unblock/:id` touches `property.blocked_user`. **Two different
 * columns, two different freeze mechanisms** — a self-freeze is invisible to the
 * admin UI and an admin freeze is invisible to `GET /users/me`. Both are
 * pre-M04 and both are pinned by contract tests.
 *
 * @param {object} user
 * @returns {Promise<{ user: object }>}
 */
function unfreezeUser(user) {
  return withTransaction(async (tx) => {
    await tx.user.update({ where: { uid: user.uid }, data: { adminblock: 0 } });
    await tx.property.updateMany({ where: { email: user.uemail }, data: { adminblock: 0 } });
    await tx.feedback.updateMany({
      where: { send_email: user.uemail },
      data: { fadminblock: 0 },
    });

    await accounts.capabilities.clearLedger(tx, user.uemail);

    return { user };
  });
}

/**
 * `PUT /admin/users/:id/status` → `activate` / `deactivate`.
 *
 * `deactivate: 1` is **active**. Only that one column moves: not `adminblock`,
 * not `uloginvalue`, not the properties. An admin can therefore deactivate a frozen
 * user and the account stays frozen, and `GET /users/:id` hides them while
 * `GET /users/me` still works. Preserved from the pre-M04 pair of one-line updates.
 *
 * @param {number} userId
 * @param {boolean} active
 * @returns {Promise<object>}
 */
function setUserActive(userId, active) {
  return prisma.user.update({
    where: { uid: userId },
    data: { deactivate: active ? 1 : 0 },
  });
}

/**
 * `DELETE /admin/users/:id`.
 *
 * Five statements in one transaction: kill the login flag, write the ledger, delete
 * the properties, delete the feedback, delete the user.
 *
 * Two things preserved that look wrong:
 *
 *   - **The user row is deleted last.** It has to be — the other four statements
 *     key off `user.uemail`, so the row has to still be there to read. The pre-M04
 *     version got this by accident (the array's last element was the delete, and
 *     `$transaction` executes in order); it is now explicit, and commented, because
 *     reordering this list silently orphans the properties.
 *   - **The user is `update`d before being `delete`d.** The `uloginvalue: 0,
 *     lastseen: now` write is pointless immediately before a delete. It is kept
 *     because it is in the same transaction, so it cannot be observed, and because
 *     removing it would change nothing at all.
 *
 * ## What this does not clean up
 *
 * The user's avatar and company logo. `modules/users`' `deleteAccount` removes both
 * from disk before deleting the row; this path does not, so an admin-deleted user
 * leaves two orphaned files forever. Neither `property` nor `feedback` cascades in
 * the schema, which is why the explicit `deleteMany`s are here at all.
 *
 * Fixing the file leak is not a structural change and would mean `admins` reaching
 * for the storage port — which it does anyway for its own avatar, so it is only the
 * ordering and the intent that are missing. Recorded in the M04 log rather than
 * done here.
 *
 * @param {object} user the row from {@link findUserRow}
 * @param {Date} now
 * @returns {Promise<{ user: object }>}
 */
function deleteUserRow(user, now) {
  return withTransaction(async (tx) => {
    const iso = now.toISOString();

    await tx.user.update({ where: { uid: user.uid }, data: { uloginvalue: 0, lastseen: iso } });

    await accounts.capabilities.recordLedger(tx, {
      email: user.uemail,
      type: "delete",
      date: now,
    });

    await tx.property.deleteMany({ where: { email: user.uemail } });
    await tx.feedback.deleteMany({ where: { send_email: user.uemail } });

    // Must stay last — see the header.
    await tx.user.delete({ where: { uid: user.uid } });

    return { user };
  });
}

/**
 * The row the three destructive operations read, and the 404 for a bad id.
 *
 * @param {number} userId
 * @returns {Promise<object>} the user row
 * @throws {AppError} 404 `USER_NOT_FOUND`
 */
async function findUserRow(userId) {
  const user = await prisma.user.findFirst({ where: { uid: userId } });
  if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");
  return user;
}

module.exports = {
  findFirstPin,
  findAdminByEmail,
  findAdminById,
  findAdminProfile,
  updateAdminRow,
  setAdminImage,
  markLogin,
  setAdminPassword,
  updateSocialLinks,
  listUsers,
  listAdmins,
  freezeUser,
  unfreezeUser,
  setUserActive,
  deleteUserRow,
  findUserRow,
};
