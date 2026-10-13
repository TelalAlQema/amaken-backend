# M00 — Safety net + P0 security

- **Status:** in progress
- **Depends on:** nothing
- **Blocks:** M01 → M08 (all of them)
- **Structural change:** none. This milestone is deliberately structure-free so it reviews fast and
  reverts instantly.

---

## Goal

Make every later milestone verifiable, and close the live vulnerabilities found during the
architecture review.

Two outputs, in order:

1. A **contract baseline** — a test that pins the current HTTP surface of every endpoint, passing
   against unmodified `src/`.
2. A **closed** set of P0/P1 holes, each with a regression test.

Without (1), a 9-milestone structural refactor is unfalsifiable. With (1), every later milestone is
just a diff against a known-good baseline.

---

## Findings this milestone addresses

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | **P0** | `dotenv.config()` runs *after* the `require` graph. `jwt.service.js` reads `process.env.JWT_SECRET` at module load and always gets `undefined`, so it falls back to the committed literal `"dev-secret-fallback-only"`. Anyone can forge an admin token. The `NODE_ENV === "production"` guard never fires. | `src/index.js:9-10` before `src/index.js:12`; `src/services/jwt.service.js:3,13` |
| 2 | **P0** | `GET /api/properties/:id` returns `include: { leads: true }` unauthenticated — every lead's name, email, phone and IP is public. | `src/services/property.service.js:255`, `src/routes/property.routes.js:174` |
| 3 | **P0** | `POST /api/users/block/:id` and `/unblock/:id` take the target id from the path with no ownership check. Any authenticated user can block any other user. | `src/routes/user.routes.js:221,236` |
| 4 | **P1** | `router.use(authenticate)` is applied router-wide, so the intended-public `GET /api/users/:id` requires a token. The frontend calls it with no token. | `src/routes/user.routes.js:12,251` |
| 5 | **P1** | `GET /api/feedback/:id` has no guard — any feedback is world-readable by id. | `src/routes/feedback.routes.js:71` |
| 6 | **P1** | Frontend sends FormData field `avatar` / `logo`; multer is `.single("image")`. Four upload endpoints 400 with "No image file provided". | `src/services/upload.service.js:33,39` vs frontend `profile/picture/page.tsx:51` |
| 7 | **P1** | `email.service` catches every send failure and returns `false`. Callers in `auth.service.js:63,66,222` ignore the return value, so OTP and password-reset emails fail **silently** while the API returns success. | `src/services/email.service.js:55-58,100-103,126-129` |
| 8 | **P1** | `morgan` logs, the error handler logs only `err.message` (no stack, no request id). No correlation across a request. | `src/index.js:62`, `src/middleware/errorHandler.js:11` |
| 9 | **P2** | `GET /api` advertises `docs: "/api/docs"`, but no such route exists. | `src/index.js:77` |
| 10 | **P2** | `Property.price` is `VarChar(100)` and is both range-filtered and sorted as a string. `"9000000" < "950000"` lexicographically, so the price filter and price sort are wrong today. **Fix deferred to M05** (needs a data migration). | `schema.prisma:122`, `property.service.js:192-194,207-208` |

---

## Steps

### 0.1 — Docs skeleton + ADRs
Create `docs/` with the architecture overview, module contract, envelope spec, ADRs 0001-0003, the
runbook, and this milestone log. **Command log starts below.**

### 0.2 — Test harness
Add `supertest`. `test/helpers/app.js` builds the app in-process against the real MySQL test
database. `node --test` is the runner — zero new toolchain, no build step, Node 22 already has it.

### 0.3 — Contract baseline
One test file per domain, pinning the current status code, envelope keys and representative payload
of every endpoint. **These must pass against unmodified `src/` before anything else is touched.**
That is the definition of "baseline".

**Done — 106 assertions across 5 files**, all green against unmodified `src/`:

| File | Tests | Covers |
|---|---|---|
| `harness.test.js` | 6 | db reset, bcrypt fixtures, error envelope |
| `route-parity.test.js` | 3 | the 97 frozen routes, the test-app mirror |
| `auth.test.js` | 16 | register, login, refresh (user+admin), OTP, reset, logout |
| `public.test.js` | 21 | `/api`, properties, lead submission, about, team, states, cities, contact, `users/:id` |
| `user.test.js` | 22 | `/users/me/*`, password, links, deactivate/activate/delete, `properties/my`, block/unblock |
| `admin.test.js` | 38 | PIN, admin login, role enforcement, users, properties, leads, contacts, feedback, dashboard |

Assertions whose names begin `BUG:`, `SECURITY:`, `DIVERGENCE:` or that carry a
`FIXME(M00.x)` comment assert the **current, wrong** behaviour on purpose — they
are the tripwires that fire when the fix lands. They are listed in
[api-contract.md](../api-contract.md#known-divergences).

### 0.4 — Fix env load order
`dotenv` loads before any application `require`. Add a boot-time assertion that `JWT_SECRET` and
`JWT_REFRESH_SECRET` are present and are not the fallback values in *any* environment.

### 0.5 — Close the PII leaks
Drop `include: { leads: true }` from `getPropertyById`. Scope `GET /users/:id` explicitly public
instead of relying on router-wide auth. Require auth on `GET /feedback/:id`.
**Also found at 0.3:** repair the two `await import(...)` calls in
`admin-property.routes.js` (finding 11) and alias the dashboard and feedback admin
paths the frontend already calls (findings 13, 14).

### 0.6 — Fix the IDOR
`block` / `unblock` operate on `req.user.id`. The `:id` path param is either removed or validated
against the caller. **Also found at 0.3:** enforce the PIN gate server-side (finding 12) and write
a `DelAccount` ledger on self-delete (finding 15).

### 0.7 — Fix upload field names
Accept the field names the client actually sends.

### 0.8 — Stop swallowing mail failures
`email.service` throws a typed `MailDeliveryError`. Auth flows surface it instead of returning a
false success.

### 0.9 — Structured logging
`pino` replaces `morgan`. Request id generated per request, propagated, attached to every log line
and to the error handler output.

### 0.10 — Fix the `/api/docs` claim
Serve real content or stop advertising it. **Also folds in the 0.3 shape findings:** normalise the
`feedbacks` → `feedback` array key (19), reconcile the unreachable `NO_IDS` branch (17), and either
merge or distinctly document the duplicated `hide`/`disapprove` and `display`/`approve` pairs (18).

### 0.11 — Document the price bug
Add a failing-by-design test that proves the lexicographic sort, marked `skip` with a pointer to
M05. Documented, not fixed.

---

## Commands run

> Appended as executed. `cd C:\amaken-fullProject\backend` unless stated.

| # | Command | Result |
|---|---|---|
| 1 | `mkdir -p docs/architecture docs/adr docs/milestones` | ok — 3 dirs created |
| 2 | *(wrote `docs/README.md`)* | ok |
| 3 | *(wrote `docs/adr/0001-modular-monolith.md`)* | ok |
| 4 | *(wrote `docs/adr/0002-single-prisma-client-split-schema.md`)* | ok |
| 5 | *(wrote `docs/adr/0003-canonical-envelope.md`)* | ok |
| 6 | *(wrote this file)* | ok |
| 7 | *(wrote `docs/milestones/M01`…`M08`)* | ok — 8 files |
| 8 | *(wrote `docs/architecture/overview.md`)* | ok |
| 9 | *(wrote `docs/architecture/module-contract.md`)* | ok |
| 10 | *(wrote `docs/architecture/envelope.md`)* | ok |
| 11 | *(wrote `docs/api-contract.md`)* | ok — **draft**, frozen at 0.3; divergences section rewritten at step 53 |
| 12 | *(wrote `docs/runbook.md`)* | ok |
| 13 | link check: `for f in $(find docs -name '*.md'); do … done` | 3 broken found |
| 14 | *(fixed `adr/0001` → `../adr/0004`, `api-contract` → `../milestones/*`)* | ok |
| 15 | link check re-run | **0 broken — all resolve** |
| 16 | `node -e "net.connect 3306"` | MySQL **reachable** |
| 17 | `node -e "require.resolve('prisma/package.json')"` | prisma 5.22.0 local; `npx.cmd` spawns fail `EINVAL` under this shell |
| 18 | `ls node_modules/.prisma/client` | **missing** — client had never been generated |
| 19 | `pnpm db:generate` | ok — client generated (5.22.0) |
| 20 | `pnpm add -D supertest` | ok — `supertest@7.3.0` |
| 21 | *(wrote `scripts/test-db.js`)* | first draft spawned `npx.cmd` → `spawnSync npx.cmd EINVAL` |
| 22 | *(fixed: resolve `prisma/build/index.js`, run via `process.execPath`)* | ok |
| 23 | `node scripts/test-db.js ensure` | ok — created `amaken_db_test`, schema pushed |
| 24 | *(wrote `test/helpers/env.js`)* | single source of truth for the derived test URL |
| 25 | *(refactored `scripts/test-db.js` to use `test/helpers/env.js`)* | ok — no drift possible |
| 26 | *(wrote `test/helpers/app.js`)* | mirrors `src/index.js`, no `listen()`, no signal handlers |
| 27 | *(wrote `test/helpers/fixtures.js`, `test/helpers/auth.js`)* | ok — one shared cost-12 bcrypt hash |
| 28 | *(wrote `test/contract/harness.test.js`)* | first run: **3 failed** — `TRUNCATE` used Prisma model names, not physical table names (`RegisterEmail` is `@map("register_email")`) |
| 29 | *(fixed: discover table names from `information_schema`)* | ok |
| 30 | `node --test test/contract/harness.test.js` | **6/6 pass** |
| 31 | *(fixed login payload: `password`, not `upassword`)* | ok |
| 32 | *(wrote `scripts/check-syntax.js`)* | ok — the static gate, since `pnpm lint` is dead |
| 33 | `pnpm check` | ok — **31 files parsed cleanly** |
| 34 | `pnpm test` | first run failed — `node --test test/` treats the dir as a module |
| 35 | `node --test "test/**/*.test.js"` | ok — glob form works on this Node |
| 36 | `pnpm test` | **6/6 pass**, 3.9s |
| 37 | `node src/index.js` + `curl /health` + `curl /api` | ok — both 200, server boots unchanged |
| 38 | *(wrote `scripts/route-table.js`, `scripts/dump-routes.js`)* | ok — routes read off the live Express `app._router` stack |
| 39 | `node scripts/dump-routes.js` | ok — **97 routes** frozen |
| 40 | *(wrote `test/contract/route-parity.test.js`)* | **3/3 pass** — test app mirrors `src/index.js` |
| 41 | *(wrote `test/contract/auth.test.js`)* | **16/16 pass** on first run |
| 42 | *(wrote `test/contract/public.test.js`)* | first run **5 failed** — `createProperty` relied on the schema default `adminapproval: 0`, so every fixture property was invisible to the public list |
| 43 | *(fixed: `adminapproval: 1` fixture default, matching `VISIBLE_CONDITIONS`)* | **21/21 pass** |
| 44 | *(wrote `test/contract/user.test.js`)* | first run **3 failed** — all three were wrong assumptions, not app bugs |
| 45 | *(corrected: `PASSWORD_INCORRECT` is 400 not 401; self-delete writes no ledger; `blockSelf` scopes by `{uid, email}`)* | **22/22 pass** |
| 46 | *(fixed `createProperty` to resolve `email` from the owner's `uemail`)* | ok — `blockSelf` now reaches the rows |
| 47 | `pnpm test` (all files) | **11 failed** while each file passed alone — see the serialization note below |
| 48 | `node --test --test-concurrency=1 "test/**/*.test.js"` | **68/68 pass** |
| 49 | *(added `--test-concurrency=1` to `package.json`)* | ok — `pnpm test` is now 68/68 |
| 50 | *(wrote `test/contract/admin.test.js`)* | first run **6 failed**, of which **3 were new production bugs** |
| 51 | *(corrected the other 3: ledger `type: "delete"`, `NO_IDS` unreachable behind zod, `feedbacks` is plural)* | **38/38 pass** |
| 52 | `pnpm test` | **106/106 pass**, 61.5s |
| 53 | *(rewrote the Known divergences section of `api-contract.md`)* | ok — 7 broken endpoints, 6 path divergences |
| 54 | link check re-run (node script, all `](…)` targets resolved against disk) | **3 broken** — `envelope.md` pointed at `milestones/…` from inside `architecture/`, and two M00 links guessed wrong sibling filenames (`M03-ratelimit-locking-idempotency.md`, `../M05-property-domain.md`) |
| 55 | *(fixed all three: `../milestones/…`, `M03-auth-module.md`, `M05-property-domain.md`)* | **0 broken — all resolve** |
| 56 | `pnpm check` | ok — 31 files parsed cleanly |
| 57 | `pnpm test` | **106/106 pass**, 61.3s |

### Serial execution is mandatory

`node --test` runs each test **file** in its own concurrent process. Every file's
`beforeEach` truncates the one shared `amaken_db_test` database, so concurrent files
wiped each other's fixtures mid-test. Step 47: **11 failures that do not reproduce
when a file is run alone.** `--test-concurrency=1` is now baked into `package.json`
and the reason is recorded at the top of `test/helpers/app.js`. Per-file schema
isolation lands in [M03](M03-auth-module.md); until then serial
execution is part of the contract, not a preference.

### New findings from 0.3

These were not in the 0.1 review; 0.3 found them, and each is now pinned by a test.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 11 | **P1** | `GET /api/admin/contacts` and `DELETE /api/admin/contacts/:id` **always return 500**. Both handlers use `await import("../services/contact.service")`; ESM `import()` does not apply CJS extension resolution, so it throws `ERR_MODULE_NOT_FOUND` and `errorHandler` renders a 500. Contact submissions cannot be listed or deleted by an admin at all. | `admin-property.routes.js:272,289` |
| 12 | **P0** | The admin PIN gate is **client-side only**. `adminLogin` never checks that `POST /api/admin/pin` was completed and no server-side state records it, so email+password alone mints a full admin token. The frontend's two-step UI is the only enforcement. | `admin.service.js:39`, `admin.routes.js:34` |
| 13 | **P1** | Every admin dashboard panel is blank: the frontend calls `/admin/dashboard/{stats,charts,sidebar-counts}` but `routes/index.js:44` mounts the router at `/admin` with inner paths `/stats`, `/charts`, `/sidebar-counts`. The stale `/dashboard` prefix survives only in comments. | `adminApi.ts:250-257` vs `routes/index.js:44` |
| 14 | **P1** | Same class of divergence for admin feedback: the frontend calls `/admin/feedback/{company,agents}` but the routes are `/api/feedback/admin/{company,agents}`. Even once the path is aliased, `baseApi.ts:13` selects the admin token by `url.startsWith("/admin")`, so the call would carry a *user* token. | `adminApi.ts:242,246` vs `feedback.routes.js:130,147` |
| 15 | **P2** | `DELETE /api/users/me` hard-deletes the user row and writes **no** `DelAccount` ledger, unlike the admin delete path. A self-deleted address is immediately re-registerable and the deletion leaves no audit trail. | `user.service.js:290` vs `admin.service.js` delete path |
| 16 | **P2** | `DelAccount` stores `type: "delete"` and a **lowercased** `utype: "user"`, while `User.utype` is `"User"` — the ledger cannot be joined to the user table by type without a case fold. | `admin.service.js` vs `schema.prisma` |
| 17 | **P2** | The `NO_IDS` branch in `lead.service.js:64` is unreachable over HTTP: the route's zod schema rejects the empty array first and returns `VALIDATION_ERROR`. Dead code that documents an intent the route contradicts. | `admin-property.routes.js` bulk-delete schema |
| 18 | **P2** | `hide` and `disapprove` are byte-identical writes, as are `display` and `approve` — four endpoints, two behaviours, so the admin UI cannot express "hide" without also meaning "withdraw approval". | `property.service.js:374-412` |
| 19 | **P2** | Array keys are inconsistent: `properties`, `leads`, `contacts`, `users` are singular but feedback returns `feedbacks` (plural). | `feedback.service.js:53,78` |
| 20 | **P2** | A wrong *current* password is `400 PASSWORD_INCORRECT`, not 401, while a wrong *login* password is 401. Defensible, but it is a contract the client must not guess. | `user.service.js:237` vs `auth.service.js:159` |

Findings 11–14 join the 0.5/0.6 fix lists; 15–20 are normalised in 0.10 and
[M07](M07-contract-consolidation.md).

### Empirical confirmation of finding #1

Step 37 printed this, unprompted, on a server whose `.env` **does** define `JWT_SECRET`:

```
⚠️  Using fallback JWT secrets — NOT safe for production
```

That is [finding #1](#findings-this-milestone-addresses) reproduced on the running system: the
committed literal is in use. Fixed at 0.4.

### 0.2 harness notes

- The test app deliberately duplicates `src/index.js`'s middleware chain, because M00 is
  structure-free. `test/contract/route-parity.test.js` (step 0.3) guards the mirror from drifting.
  **M01 deletes this duplication** — `src/app.js` becomes the single source of truth.
- The harness calls `dotenv.config()` *before* the require graph, which is the **correct** order.
  Tests therefore do not bake in the 0.4 bug; they encode the post-fix behaviour.
- `resetDatabase()` discovers table names from `information_schema` rather than hardcoding them, so
  a schema change in [M05](M05-property-domain.md) cannot silently break cleanup.

1,879 lines of documentation. No `src/` touched, so nothing to boot or verify yet.

### Decisions locked at 0.1

| # | Decision | Consequence |
|---|---|---|
| D1 | Canonical `data: { items, pagination }`, legacy key dual-emitted behind `ENVELOPE_LEGACY_KEY` | Zero-downtime in [M07](M07-contract-consolidation.md); alias removed one release later |
| D2 | JSDoc + `checkJs`, no build step | Two tsconfigs — strict gate on new code, ratcheting legacy glob, self-cleaning |
| D3 | Redis in M02; S3 deferred behind the storage port | **Single replica until the S3 adapter lands.** Recorded in the runbook |
| D4 | `node:test` + `supertest` | Zero new toolchain |
| D5 | Docker + compose; migrations as a `release` step, never on boot | Needs `--init` for SIGTERM delivery |

---

## Verification

Run before marking the milestone done:

```bash
pnpm check                                    # static gate (pnpm lint is dead)
pnpm test                                     # 106 contract assertions, serial
node src/index.js                             # then: GET /health, GET /api
```

`pnpm test` runs `--test-concurrency=1` on purpose — see the serialization note
under [Commands run](#commands-run).

## Definition of done

- [x] `pnpm test` green, covering every domain — **106/106 at 0.3**
- [x] `node src/index.js` boots; `/health` and `/api` respond — step 37
- [ ] JWT is signed with the real secret — a test proves the fallback is never reachable *(0.4)*
- [ ] No unauthenticated path returns PII (leads on property detail, feedback by id) *(0.5)*
- [ ] The two always-500 contact admin endpoints respond *(0.5)*
- [ ] Dashboard and feedback admin paths match what the frontend calls *(0.5)*
- [ ] Cross-user `block` is rejected *(0.6)*
- [ ] The PIN gate is enforced server-side, not just by the admin UI *(0.6)*
- [ ] Self-delete writes an audit ledger row *(0.6)*
- [ ] The four upload endpoints accept the field names the client sends *(0.7)*
- [ ] SMTP failure surfaces as an error, not a false 200 *(0.8)*
- [ ] Every log line for a request carries the same request id *(0.9)*
- [ ] `/api/docs` claim resolved *(0.10)*
- [ ] Price sort/filter bug pinned by a skipped test with an M05 pointer *(0.11)*
- [x] `docs/api-contract.md` written and frozen at 0.3

## Rollback

No structural change, so rollback is `git checkout` of the touched files. The test suite and docs
are additive. Nothing in M01+ can reference this milestone until it is green.
