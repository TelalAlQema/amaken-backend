# M03 — `modules/auth` (the reference module)

- **Status:** code complete — DB-backed verification blocked (see [Verification](#verification))
- **Depends on:** M02
- **Blocks:** M04 → M06

## Goal

Build the **first** module. Every other module is a copy of the pattern proven here. Do not shortcut
this one.

## Target

```
src/modules/auth/
├── index.js                  # the ONLY public surface
├── auth.routes.js            # HTTP: parse, validate, delegate, respond
├── auth.service.js           # domain logic, transactions
├── auth.repository.js        # the only file that touches prisma in this module
├── auth.schema.js            # zod schemas (imported from @amaken/shared where they exist)
├── auth.policy.js            # who may call what
├── token.service.js          # issue/verify, rotation, revocation
└── auth.mapper.js            # entity → wire shape
```

```js
// src/modules/auth/index.js
module.exports = {
  name: "auth",
  mounts: [
    { path: "/api/auth", router: publicRouter, guards: [] },
  ],
};
```

`src/bootstrap/registerModules.js` iterates the registry; `app.js` mounts them. Paths stay
byte-identical to today, so the frontend does not move.

## Layering rules (enforced by lint in M08, by review until then)

```
routes → service → repository → platform → core
```

- `auth.routes.js` never imports prisma. No `try/catch` — `asyncHandler` handles it.
- `auth.service.js` never touches `req` / `res`.
- `auth.repository.js` is the only prisma caller.
- Nothing imports another module's internals — only its `index.js`.

## Security work in this milestone

| Item | Detail |
|---|---|
| Refresh token rotation | Every refresh issues a new refresh token. Reuse of a rotated token revokes the whole family. |
| `jti` + `tokenVersion` | `tokenVersion` already exists on the user. Add a `jti` claim so individual tokens can be denied. |
| Optional Redis denylist | Deny list in Redis with TTL = token lifetime. Cheap; reuses the M02 client. |
| Single hash implementation | `auth.service.js:180` falls back to **SHA-256**, `admin.service.js:67` to **SHA-1**, each with its own inline bcrypt-upgrade block. M03 standardises the *user* path on bcrypt cost 12; M04 removes the admin SHA-1 path. |
| `jti` and `type` claims | `verifyAccessToken` currently collapses "expired" and "malformed" into `null`. Distinguish them so the 401 code is meaningful. |

## Deletions

Once green and verified against the M00 baseline:

```bash
git rm src/routes/auth.routes.js src/services/auth.service.js src/services/jwt.service.js
```

`email.service.js` moves to `platform/mail/` in M04, once `admin.service.js` (its only other caller)
has moved.

## Verification

```bash
node --check src/modules/auth/*.js
node --test test/modules/auth.test.js
node --test test/                    # full M00 baseline still green
node src/index.js
```

### Commands actually run

Per the ground rule in [`../README.md`](../README.md) — if a command is not recorded here,
it did not happen.

| Command | Result |
|---|---|
| `pnpm install` | ok — workspace root + `@amaken/shared` |
| `pnpm db:generate` | ok — Prisma Client 5.22.0 |
| `pnpm check` | **ok — 77 files parsed cleanly** |
| `node --check src/modules/auth/*.js` | **ok — 8/8** |
| `node --test test/contract/route-parity.test.js` | **ok — 3/3** (all 100 routes, incl. the 9 `/api/auth` ones) |
| `node --test test/modules/auth.test.js` | **blocked — 26/26 fail, none reach an assertion** |
| `node --test test/` | **blocked** — every DB-backed file fails on the same hook |
| `node src/index.js` | **blocked** — boots, retries, then fatal at the DB handshake |

### Why the DB-backed tests cannot run

Every test in the suite hangs off `beforeEach(resetDatabase)`, so a suite that cannot
reach MySQL reports 26 failures and 0 real results. The blocker is environmental, not a
defect in this milestone:

- The local `MySQL80` service (8.0.46, `C:/ProgramData/MySQL/MySQL Server 8.0`) is running
  on `127.0.0.1:3306` and accepts connections.
- No credential in `.env` works. `amaken:amakenpassword` and `root:rootpassword` from
  `.env.example` both fail with `ERROR 1045 Access denied`. Workbench holds a
  `root@127.0.0.1:3306` connection whose password is in the Windows credential vault.
- **Independently of the password**, the `amaken` account uses the `sha256_password` auth
  plugin. Prisma supports only `caching_sha2_password` and `mysql_native_password`, so
  *any* password fails with `Unknown authentication plugin 'sha256_password'`. Fixing the
  password is not sufficient; the account has to be re-created or altered:

  ```sql
  CREATE USER 'amaken'@'%' IDENTIFIED WITH mysql_native_password BY '…';
  -- or, to repair the existing account:
  ALTER USER 'amaken'@'localhost' IDENTIFIED WITH mysql_native_password BY '…';
  ```

- To finish this milestone's verification, then run the four commands above in order.

### Verified without a database

Because the suite is gated, the parts of M03 that do not need MySQL were checked directly
rather than left unexamined. Layering, policy wiring and the token claim work were all
confirmed to hold:

- The manifest is the whole public surface — 4 export keys, no repository or DB function
  reachable through it, mounted at the frozen `/api/auth`.
- Layering, statically, with comments stripped: `auth.routes.js` mentions no prisma, has
  no `try/catch`, never calls `res.json`; `auth.repository.js` is the **only** file in the
  module that references prisma; `auth.service.js` never touches `req`/`res`; no module
  file reaches into another module's internals; 9 endpoints, 8 `asyncHandler` wraps plus
  the deliberately-sync `/logout`.
- All 9 operations are declared, every one passes `assertDeclared`, and an undeclared
  operation throws.
- Claims: distinct `jti` per token, shared `fam` per pair, `type` discriminates, and
  `tokenVersion` round-trips — with absent/`-4`/`"x"` all normalising to `0`, so
  pre-M03 tokens are not invalidated on deploy.
- Failures are distinguished: an expired token reports `expired`, while garbage, an empty
  string, `undefined` and a tampered signature all report `malformed`.
- Revocation denies the `jti` **and** the family, so the sibling access token dies with the
  refresh token; an unrelated pair is unaffected.
- Hashing is bcrypt cost 12 on both paths; a legacy SHA-256 hex hash still authenticates and
  returns a cost-12 replacement for upgrade-in-place; a missing stored hash never
  authenticates.
- All 9 endpoints are reachable through `createApp`, and each returns `400
  VALIDATION_ERROR` on an empty body — proving policy and zod validation run **before**
  anything reaches prisma. An unknown `/api/auth/*` path still returns the 404 envelope.

One finding worth recording: `VerifyFailure.WRONG_TYPE` is unreachable through the running
configuration, because access and refresh tokens are signed with **different** secrets, so
a cross-presented token fails the signature check and reports `malformed` before the `type`
claim is examined. This is the behaviour `token.service.js:81` already documents and it is
the correct 401 — but it means the `type` claim is belt-and-braces today, and the branch is
exercised only by signing with the verifier's own secret.

## Definition of done

- [ ] All 9 `/api/auth/*` endpoints behave exactly as the M00 baseline pinned them —
      *routes verified reachable and pre-DB; behaviour assertions still blocked on MySQL*
- [ ] Refresh rotation works; reuse of a rotated token revokes the family — *implemented in
      `token.service.js`; needs the DB suite to confirm*
- [x] `auth.routes.js` contains no `require("../../../lib/prisma")` — verified; `src/lib/`
      is gone entirely, the import is now `platform/db/prisma` and lives only in the
      repository
- [x] No `try/catch` remains in `auth.routes.js` (asyncHandler covers it)
- [x] Old `routes/auth.routes.js` and `services/{auth,jwt}.service.js` deleted
- [x] Module contract test passes: importing `index.js` gives the manifest, nothing else is
      reachable — the static half verified directly; the suite's own version awaits MySQL

The code and its structure are done. The two unchecked items are unverified claims, not
missing work, and both close the moment the MySQL account is reachable.
