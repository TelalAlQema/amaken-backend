# M01 — Core kernel + `app.js` / `server.js` split

- **Status:** done
- **Depends on:** [M00](M00-safety-net.md) (0.1–0.3 — the contract baseline only)
- **Blocks:** M02 → M08

## Goal

Split the composition root and build the primitives every module will use. The single highest-value
change in the whole plan is making the Express app **importable without side effects**, because that
is what makes every later milestone testable.

## Starting state

`src/index.js` was 122 lines doing six jobs at once: env validation, security middleware, rate
limiting, body parsing, static files, route mounting, 404, error handling, `listen`, and process
signal handling. It also called `dotenv.config()` *after* requiring the app, which is [M00 finding
#1](M00-safety-net.md). There was no way to build the app without binding a port — which is why
M00.2 had to hand-copy the middleware chain into `test/helpers/app.js` and spend a test keeping the
copy honest.

## What landed

### `src/config/` — the only reader of `process.env`

`env.schema.js` declares all 31 environment keys in zod. `index.js` calls `dotenv.config()` as its
first statement, validates, warns on the three production-required keys outside production, and
exports a deeply frozen, grouped object. `NODE_ENV` is a free string rather than an enum: only
`production` is branched on, and `staging` is not ours to reject.

Load order is now structural rather than conventional. `require("./config")` is the first statement
of `server.js`, so the secret is in `process.env` before `jwt.service` is ever evaluated. **M00
finding #1 is closed as a load-order fact**, though the literal `"dev-secret-fallback-only"` still
exists (see [Open items](#open-items-carried-forward)).

| Before | After |
|---|---|
| 7 files read `process.env` directly | 1 does (`src/config`), plus `NODE_ENV` in the logger |
| `jwt.service` froze secrets at module load, post-`dotenv` | reads validated config, guaranteed pre-`dotenv` |
| `smtp.gmail.com` / `587` / `no-reply@…` inlined in `email.service` | `config.mail.*` |
| `process.env.ADMIN_MAIN_PHONE` in `admin.service` | `config.admin.mainPhone` |
| `path.join(__dirname, "../public/uploads")` in `index.js` | `config.paths.uploads`, absolute, overridable |
| rate-limit windows inline in `index.js` | `config.http.rateLimit.*` |

### `src/core/` — framework-agnostic primitives

| Directory | Exports |
|---|---|
| `errors/` | `AppError`, `ErrorCode` (13 closed codes), `STATUS_BY_CODE`, factories `notFound` / `unauthorized` / `forbidden` / `conflict` / `badRequest` / `rateLimited` / `internal` / …, `isPrismaError`, `fromPrisma` |
| `http/` | `ok` `created` `noContent` `paginated` `raw` `fail` + the `envelope()` decorator, `asyncHandler`, `paginationQuery` / `paginate` / `toPrismaArgs` / `pagedResult`, `notFound` |
| `logger/` | `createLogger` (pino, redaction), `requestId`, `acceptInboundId`, `httpLogger`, `getLogger` / `setLogger` |
| `observability/` | `registry`, `getMetrics`, `observeRequest`, `countError`, `routeLabel`, `metricsHandler` |

`AppError` keeps its three-argument `(message, statusCode, code)` signature, so the ten services
that import it from `middleware/errorHandler` are untouched; that file now re-exports the class
from `core/errors` and the re-export is deleted when the last module is migrated.

### `src/platform/db/prisma.js`

`src/lib/prisma.js` moved. `ping()` (a bounded `SELECT 1`), `disconnect()` (drains the pool and
clears the `globalThis` cache) and `withTransaction(fn, { maxWait, timeout, isolationLevel })` added.
The export shape changed from the bare client to `{ prisma, ping, disconnect, withTransaction }`,
because attaching methods to a `PrismaClient` instance collides with Prisma's `$`-prefixed
namespace; all 11 importers were repointed in the same commit.

### `src/app.js`, `src/server.js`, `src/index.js`

`createApp(deps)` — 178 lines, no `listen`, no `dotenv`, no process events. `deps` accepts
`{ config, logger, routes }`; all three default to the real singletons. `server.js` owns
`dotenv → config → connect DB → createApp() → listen → signals`. `index.js` is a one-statement shim,
so `pnpm dev`, `pnpm start` and Playwright's `webServer` need no change.

### New endpoint

`GET /metrics` — Prometheus text format, not enveloped, unauthenticated. Added to the frozen route
table in `test/contract/route-parity.test.js` as the 98th route, and to `docs/api-contract.md` in
the same commit.

### Also replaced

`morgan` is gone. `pino` + `pino-http` now log one structured line per request, with the request id
on it, honouring an inbound `X-Request-Id`, and the `errorHandler` logs a stack and the request id
where it previously logged `err.message`. `/health` and `/metrics` are excluded from the access log
or an orchestrator's 2-second probe would bury every real request.

## Migration method followed

Mechanical and non-breaking at every step:

1. Added `config/`, `core/`, `platform/db/` alongside the existing files. ✅
2. Added `app.js` / `server.js`; made `index.js` delegate. ✅
3. Mounted the **existing** `src/routes` from `app.js` unchanged. ✅
4. M03 onward replaces routes with modules. — not this milestone

The app behaves identically after M01. The M00 contract tests are what prove it: **106/106 pass with
`src/routes` byte-identical**, and `pnpm check` parses 51 files.

## Deviations from the plan, and why

| Planned | Shipped | Reason |
|---|---|---|
| `prom-client` | `@prometheus-io/client` | `prom-client` is deprecated in favour of this; installing a deprecated package into the kernel to satisfy a line in a plan is not a trade worth making. Same API, same output format. |
| `logger/` — "pino instance, request-id middleware, redaction" | plus `pino-http` wiring and a `getLogger`/`setLogger` pair | [M00.9](M00-safety-net.md) asks for one line per request carrying a request id; hand-rolling that duplicates pino-http and does it worse. |
| `withTransaction()` | + explicit `maxWait` 5s / `timeout` 10s | Prisma's defaults are 5s interactive timeout — exceeded by every bulk import — and an unbounded transaction holds row locks for `innodb_lock_wait_timeout` (50s), turning a slow query into a site-wide stall. |
| — | `src/platform/db/` has no barrel `index.js` | One file does not need one. `platform/` grows a barrel when `cache/` and `queue/` land in M02. |
| — | boot now **fails** if MySQL is unreachable, after 5 retries | The deliverable says `connect DB` before `listen`. A replica that answers 500s for the first seconds of every deploy is worse than one that is not yet accepting connections; a load balancer does not wait for a closed port. M02 adds `/health/ready` on top. |
| — | `validateQuery`'s write-back is left broken | See finding 2. |
| — | `core/logger` reads `NODE_ENV` | Explicitly permitted by the DoD. The logger must be constructible before `config` is required, or a module that logs during import would be unconstructable. |

## New findings from this milestone

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 21 | **P2** | `validateQuery` validates but its **write-back is a silent no-op**. Express 4 defines `req.query` as a getter-only accessor on the request prototype, so `req.query = schema.parse(req.query)` does nothing outside strict mode. 13 call sites use it. The *rejection* path works, so a genuinely invalid query still 400s — but every `.default()`, `.coerce` and `.transform()` in a query schema is discarded, and handlers read the raw string. `req.body` and `req.params` are plain own properties and are fine. | `src/middleware/validate.js:44`, `express/lib/request.js` `defineGetter(req, 'query', …)` |
| 22 | **P2** | `z.coerce.number().catch(undefined).default(1)` silently returns `{}` rather than the default. `.catch(undefined)` swallows the failure, and a `.default()` applied *after* it only fires for input that was already `undefined`, so the key disappears from the parsed object. The correct order is `.default(v).catch(v)`. This cost 15 minutes and is now pinned by a test, because it is the natural way to write it. | `src/core/http/pagination.js` |
| 23 | **P3** | Nine services imported `AppError` from `middleware/errorHandler` — a service importing *upward* into the HTTP layer. Preserved in M01 (re-export) so behaviour is identical; deleting the re-export is a checklist item per module in M03–M06. | `src/middleware/errorHandler.js` exports `AppError` |

## Commands run

> Appended as executed. `cd C:\amaken-fullProject\backend` unless stated.

| # | Command | Result |
|---|---|---|
| 1 | `pnpm test` (baseline before touching anything) | **106/106 pass**, 62.2s — the number M01 had to hold |
| 2 | `pnpm add pino pino-http prom-client` | ok — the plan's package |
| 3 | `pnpm remove prom-client && pnpm add @prometheus-io/client` | ok — `prom-client` is deprecated in favour of it |
| 4 | *(wrote `src/config/env.schema.js`, `src/config/index.js`)* | 31 keys, deep-frozen, `node -e` smoke test confirms port/cors/paths/mail/rate-limit resolve |
| 5 | *(wrote `src/core/errors/{AppError,codes,factories,prisma,index}.js`)* | ok |
| 6 | *(wrote `src/core/http/{response,asyncHandler,pagination,notFound,index}.js`)* | ok |
| 7 | *(wrote `src/core/logger/{logger,requestId,index}.js`)* | ok — pino 10.3.1, pino-http 11.0.0 |
| 8 | *(wrote `src/core/observability/{metrics,routes,index}.js`)* | first draft mounted a `Router` at `/metrics`, which made the route table read `GET /metrics/` |
| 9 | *(replaced it with a single `metricsHandler`)* | route table now reads `GET /metrics`, matching `/health` |
| 10 | *(wrote `src/platform/db/prisma.js`; repointed 11 services; `rm src/lib/prisma.js`)* | ok — import-path change only |
| 11 | *(wrote `src/app.js`, `src/server.js`; `src/index.js` → shim)* | ok |
| 12 | *(repointed `jwt.service`, `email.service`, `admin.service`, `errorHandler` at config)* | ok |
| 13 | `node -e "createApp()"` + `collectRoutes` | **98 routes** — 97 plus `/metrics`, nothing else moved |
| 14 | *(rewrote `test/helpers/app.js` to delegate to `createApp()`)* | ok — the 60-line mirror is deleted |
| 15 | *(added `/metrics` to `EXPECTED_ROUTES`)* | ok |
| 16 | `node --test --test-concurrency=1 "test/**/*.test.js"` | **106/106 pass**, 77.4s — baseline held |
| 17 | *(wrote `test/unit/kernel.test.js`, 14 tests)* | first run **11 pass, 3 failed** |
| 18 | *(fixed: `createApp` legitimately adds one `exit` listener — pino's `on-exit-leak-free` log flush)* | assertion narrowed to lifecycle events plus an explicit allowlist |
| 19 | *(fixed: shim assertion had dropped the trailing semicolon)* | ok |
| 20 | *(fixed: `.catch(undefined).default(1)` returns `{}` — finding 22)* | reordered to `.default(v).catch(v)` |
| 21 | `node --test test/unit/kernel.test.js` | **14/14 pass** |
| 22 | `pnpm check` | ok — **51 files parsed cleanly** |
| 23 | `node --test --test-concurrency=1 "test/**/*.test.js"` | **120/120 pass**, 92.7s |
| 24 | *(wrote `docs/adr/0004-typecheck-ratchet.md`)* | ok |
| 25 | link check over `docs/` (node script, every `](…)` target resolved against disk) | **0 broken** — the one hit is the literal `` `](…)` `` inside the M00 command log, not a link |

### `pnpm lint` is still dead — untouched

M01 adds files; it does not resurrect the linter. `pnpm check` (31 → 51 files) is the static gate and
`test/unit/kernel.test.js` now enforces the two rules `pnpm lint` would have enforced here: no
`process.env` outside `config/`, and no `try/catch`-in-routes… the second half of which is M03's job.
The real ESLint fix is [M08](M08-delivery-ops.md).

## Verification

```bash
pnpm check                     # 51 files parsed cleanly
pnpm test                      # 120/120, serial (106 M00 baseline + 14 M01 kernel)
node src/index.js              # GET /health, GET /api, GET /metrics
curl localhost:5000/metrics
```

## Definition of done

- [x] `require("./app")` returns an app and binds nothing — `test/unit/kernel.test.js` proves it
      three ways: the module exports only `createApp`, no lifecycle handler is installed, and TCP
      5000 still refuses connections afterwards
- [x] No file outside `src/config/` reads `process.env` (except `NODE_ENV` in the logger) — asserted
      by a test that walks `src/`, strips comments, and diffs against a three-entry allowlist
- [x] M00 contract tests green with `src/routes` untouched — **106/106**
- [x] `pnpm dev` and `pnpm start` unchanged from the outside — both still `node … src/index.js`
- [x] `pnpm db:push` and `pnpm db:generate` still work — the Prisma client is the same object, only
      the file it lives in changed
- [x] ADR 0004 recorded for the `checkJs` / tsconfig ratchet —
      [`adr/0004-typecheck-ratchet.md`](../adr/0004-typecheck-ratchet.md)
- [x] `src/lib/` is gone; 11 services point at `platform/db/prisma`

## Open items carried forward

| Item | Owner | Note |
|---|---|---|
| `"dev-secret-fallback-only"` still reachable on a clone with no `.env` | [M00.4](M00-safety-net.md) | M01 guarantees the *real* secret is loaded whenever `.env` has one. Deleting the literal needs a boot assertion, which is a behaviour change. |
| `morgan` replacement is only half done | [M00.9](M00-safety-net.md) | Transport-level access logging lands. `email.service` still `console.error`s its failures, which is finding #7. |
| `validateQuery` write-back (finding 21) | [M05](M05-property-domain.md) | Fixing it changes what 13 list endpoints receive. |
| Prisma codes `P2003` / `P2014` / `P2034` unmapped | M03+ | Need per-module messages; see `src/core/errors/prisma.js`. |
| Typecheck ratchet not yet executable | [M08](M08-delivery-ops.md) | ADR 0004 fixes the design; the two `tsconfig*.json` files and the stubs land there. |
| `boot now fails without MySQL` | deliberate | `DB_CONNECT_RETRIES` tunes it; `docs/runbook.md` records it. |

## Rollback

The structural part reverts cleanly: `git checkout src/`, and the M00 mirror in `test/helpers/app.js`
is one `git show M00:test/helpers/app.js`. Two things do not revert with it and are called out
deliberately:

- `pino`, `pino-http` and `@prometheus-io/client` in `package.json` — harmless if unused.
- `test/unit/kernel.test.js` and the `/metrics` entry in `EXPECTED_ROUTES` — a revert that leaves
  the former behind fails the latter, and vice versa. Take both or neither.