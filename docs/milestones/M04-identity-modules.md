# M04 — Identity modules: users, admins, accounts

- **Status:** code complete; blocked on a database-auth change before the suite can run
- **Depends on:** M03
- **Blocks:** M05, M06

## Goal

Complete the identity cut. These three services are one horizontal concern spread across three files
with three divergent password implementations. They cannot be split cleanly until M03 provides the
pattern.

## Modules

```
src/modules/users/      # profile, avatar, logo, social links, password, deactivate, block
src/modules/admins/     # PIN step, admin login, admin profile, user management
src/modules/accounts/   # DelAccount + RegisterEmail ledgers
```

## Notes per module

### users
- `user.service.js:303,325` writes `prisma.property` on delete/block. That is a cross-module write.
  It stays legal under [ADR 0002](../adr/0002-single-prisma-client-split-schema.md) but must be an
  explicit, commented repository call — not an accident.
- `user.routes.js:221,236` IDOR already fixed in [M00](M00-safety-net.md); keep the regression test.
- `GET /api/users/:id` must stay public — the frontend calls it with no token.

### admins
- `adminLogin` re-implements login against `prisma.admin` instead of sharing `loginUser`, and has
  **diverged**: SHA-1 fallback (`admin.service.js:67`) where auth uses SHA-256. Collapse onto one
  `password.service`.
- The admin PIN step (`POST /api/admin/pin` → `admin_pin_verified`) is a second factor implemented as
  a single-row `Pin` table. Document the limitation; do not redesign it here.
- `admin.service.js:347-348,421-422` run an `await` **inside** a `$transaction` array literal. Each
  call issues a client-side query *and then* the batch, and `?? -1` can attempt a create with
  `id: -1`. Fix: proper `upsert` on a unique email.

### accounts
- Pure ledger CRUD extracted from `admin.service.js:445,461,476`. It exists only because admin user
  management writes to it. Extracting it removes a four-way cross-domain dependency.

### platform/mail
- `email.service.js` moves here as the nodemailer adapter behind a `Mailer` port. Fixed in
  [M00](M00-safety-net.md) to throw `MailDeliveryError` instead of returning `false`.

## Deletions

```bash
git rm src/routes/user.routes.js src/routes/admin.routes.js
git rm src/services/user.service.js src/services/admin.service.js src/services/email.service.js
```

## Verification

```bash
node --test test/modules/users.test.js test/modules/admins.test.js
node --test test/                    # baseline green
node src/index.js
```

## What the code does now

### Modules added

```
src/core/password/       password.service.js + index.js — bcrypt cost 12, verify returns {ok, upgrade}
src/platform/mail/       port.js (MailDeliveryError), nodemailer.js, index.js
src/modules/users/       index, routes, service, repository, schema, policy, mapper — 14 endpoints
src/modules/admins/      index, routes, service, repository, schema, policy, mapper — 20 endpoints
src/modules/accounts/    index, service, repository — no mounts, capability surface only
```

`accounts` publishes ten capabilities to the other two modules. `users` and `admins` publish
none: their surface is entirely their URLs, so the frozen route table *is* their dependency
list. That is asserted rather than assumed — `test/modules/*.test.js` fails if `index.js`
ever grows a `service`/`repository` export.

### Password consolidation

`core/password` is the only file in `src/` that imports `bcryptjs`. Verification accepts a
bcrypt or argon2 hash and reports `{ok, upgrade}`; only a bcrypt hash can be upgraded, so an
argon2 row rehashes on the next successful login-or-change through the bcrypt path and an
argon2 row is never silently rewritten.

The SHA-1 (`admin.service.js:67`) and SHA-256 fallbacks are gone. **This has a migration
consequence:** a row still holding a bare legacy digest now fails verification and must be
reset. Legacy users get the normal forgot-password flow; **legacy admins have no recovery
path**, because admin credentials are only reachable through `adminLogin`/`verifyPin`. An
admin stuck on a bare digest needs an out-of-band reset. `Admins.service.js:95,354` documents
this.

The admin PIN check uses the same service. A bare (non-prefixed) PIN is rejected outright
rather than compared, because there is no way to know what it was hashed with.

### Ledger writes

`del_account` gained `@@unique([email])`, so a freeze is one `upsert`. The pre-M04 pattern in
`admin.service.js:347-348,421-422` — an `await` *inside* a `prisma.$transaction([...])` array
literal, reading with an `id: -1` fallback — is gone; freeze/unfreeze/delete now run inside
interactive transactions opened by `admins.repository.js` and delegate the row write to
`accounts.capabilities.recordLedger`/`clearLedger`.

**Existing databases need a cleanup before the constraint applies.** Duplicate `del_account`
rows must be reduced to one per email first:

```sql
SELECT email, COUNT(*) FROM del_account GROUP BY email HAVING COUNT(*) > 1;
DELETE d1 FROM del_account d1
  JOIN del_account d2 ON d1.email = d2.email AND d1.id > d2.id;
```

### Deliberately unchanged

Four pre-existing defects were left alone because M04 is structural and each fix changes a
pinned response or removes a capability:

| Finding | Behaviour |
|---|---|
| M00.6 IDOR | `POST /block/:id` still acts on the path parameter, so any authenticated user can freeze another. Pinned by `test/contract/user.test.js:236` and by `test/modules/users.test.js`. |
| `GET /api/users/:id` | Public, and exposes `uemail` and `ugender`. The route is the one the frontend fetches anonymously. |
| M00.9 | `PUT /api/admin/profile` still returns `apass` in the response. Pinned by `test/modules/admins.test.js`. |
| Self-delete | `DELETE /api/users/me` writes **no** ledger row, so the address is immediately re-registerable and the deletion leaves no audit trail. Pinned by `test/contract/user.test.js:181`. The `recordSelfDelete` capability was removed rather than left available, since publishing it invites reintroducing exactly that. |

Also unchanged, and noted in the code: user delete removes the image file *before* deleting the
row (a storage failure leaves a live row with a missing avatar), and admin delete orphans files
rather than deleting them.

## Definition of done

- [x] One `password.service` — no SHA-1, no SHA-256 fallback, one bcrypt-upgrade path
- [x] No `admin.service.js` / `user.service.js` files remain
- [x] `admin.service.js:347` double-query pattern replaced with an upsert
- [x] `platform/mail` is the only module that imports nodemailer
- [x] `GET /api/users/:id` still responds without a token
- [x] 14 user + 20 admin + 9 auth endpoints mounted, policy and router in agreement
- [x] `node scripts/check-syntax.js` — 94 files parse
- [ ] M00 baseline green — **blocked**, see below

## Blocked: test database authentication

Every database-backed test fails in `beforeEach`, not in the assertions:

```
Error querying the database: Unknown authentication plugin `sha256_password'.
```

The MySQL account uses `sha256_password`, which Prisma 5.22's bundled connector does not
support. It is an environment change, not a code defect — nothing in this milestone caused it,
and it predates M04. Resolve it by switching the account to `mysql_native_password`, or by
upgrading the Prisma connector, then re-run the verification block below.

The contract-half assertions of both new module tests were run without the database and pass
(10/10 users, 10/10 admins). The behaviour halves are unverified until the above is fixed.

## Verification

```bash
node scripts/check-syntax.js                                  # passes
node scripts/test-db.js ensure && node --test test/modules/users.test.js test/modules/admins.test.js
node --test --test-concurrency=1 "test/**/*.test.js"          # full baseline
node src/index.js
```

## Command log

| Command | Result |
|---|---|
| `node scripts/check-syntax.js` | OK — 94 files parsed cleanly |
| `node -e "require('./src/app')"` | loads; modules registered `auth, admins, users, accounts` |
| route-table walk of the live Express stack | 43 identity routes mounted (9 auth + 20 admin + 14 users), 100 total |
| `users.policy` / `admins.policy` route assertion | 14 and 20 declared; users has exactly 1 anonymous route, admins exactly 2 |
| `npx eslint src` | **not run** — no eslint config in flat format and eslint is not a dependency; `npm run lint` cannot work in this repo |
| `pnpm db:generate` | OK — after the `@@unique([email])` change |
| `node scripts/test-db.js ensure` | fails — `Unknown authentication plugin 'sha256_password'` |
| `node --test test/modules/*.test.js` | 20 contract tests pass without a DB; behaviour tests blocked in `beforeEach` |

## Note: M04's "admin login moves into the auth module"

The milestone says `modules/admins` owns the admin login but also that the login "moves into
this module" for auth. Those are different claims, and the second one is wrong. The admin login
is one of the twenty `/api/admin` endpoints the frozen route table pins, so it stays in
`modules/admins`. What moved is the dependency: it used to mint its own tokens through
`auth.capabilities.issueTokenPair` from a service in `src/services/`, and now it does from a
module that declares that capability in its own manifest. `src/modules/auth/index.js` records
the reasoning.
