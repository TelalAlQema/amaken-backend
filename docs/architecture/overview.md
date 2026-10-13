# Architecture overview

## What this is

A modular monolith. One Express process, one MySQL database, one deployable unit — with the code
split into bounded contexts that have enforced boundaries. See
[ADR 0001](../adr/0001-modular-monolith.md) for why not microservices.

## Current → target

### Today (M01)

```
src/
├── index.js          1 line: require("./server"). The shim that keeps `pnpm dev`,
│                      `pnpm start` and Playwright's webServer working unchanged.
├── server.js         process lifecycle ONLY: dotenv → config → ping DB → createApp()
│                      → listen → bounded drain → $disconnect → signals
├── app.js            createApp(deps): pure Express factory. No listen, no dotenv,
│                      no process events. API routes mount from module manifests.
│                      config/ logger/ envelope/ helmet cors rate-limit body static
│                      /health /metrics /api → /api → 404 → errorHandler
├── config/           the ONLY place permitted to read process.env. 31 keys, zod,
│                      deeply frozen.
├── core/             framework-agnostic primitives; knows nothing about modules
│   ├── errors/       AppError, ErrorCode, factories, Prisma P2002/P2025 translation
│   ├── http/         response.js, asyncHandler.js, pagination.js, notFound.js
│   ├── logger/       pino + pino-http + request-id + redaction
│   └── observability/ @prometheus-io/client registry, /metrics
├── platform/
│   └── db/prisma.js  the only code permitted to talk to MySQL. ping, disconnect,
│                      withTransaction
├── middleware/       auth.js, errorHandler.js, validate.js   (legacy, M04-M06)
├── routes/           empty migration seam; API routes are in module manifests
└── services/         remaining infrastructure-era services; domain services live in modules
```

`packages/shared/` is no longer dead code. As of M03, `modules/auth/auth.schema.js` imports
`strongPasswordSchema`, `USER_TYPES` and `GENDERS` from it. The other shared schemas are
still unused, and `auth.schema.js` documents field by field why — several of them disagree
with the frozen HTTP contract, so they cannot be adopted as-is.

### Target (M06)

```
src/
├── server.js              process lifecycle ONLY: dotenv → config → deps → listen → signals → drain
├── app.js                 createApp(deps): pure Express factory. No listen, no dotenv, no events.
├── index.js               3-line shim → require('./server')   [M01]
│
├── config/                the ONLY place permitted to read process.env
│   ├── env.schema.js
│   └── index.js
│
├── bootstrap/
│   ├── container.js       lazy singletons: prisma, mailer, storage, cache, queue, logger
│   └── registerModules.js mounts module manifests into app.js
│
├── core/                  framework-agnostic primitives; knows nothing about modules
│   ├── errors/            AppError, ErrorCode, factories, Prisma error translation
│   ├── http/              response.js, asyncHandler.js, pagination.js, notFound.js
│   ├── logger/            pino + request-id middleware + redaction
│   ├── auth/              authenticate, requireRole, optionalAuth
│   └── observability/     prom-client, /metrics
│
├── platform/              infrastructure adapters — the only code that touches the outside world
│   ├── db/                prisma client, withTransaction, ping, disconnect
│   ├── mail/              nodemailer behind a Mailer port
│   ├── storage/           LocalDisk adapter (+ S3 later) behind a Storage port
│   ├── cache/             in-memory L1 + MySQL durable tier (otp)
│   ├── queue/             MySQL-backed queue: store, worker, processors
│   └── serialize.js       BigInt-safe JSON for the two tables above
│
├── modules/               bounded contexts
│   ├── auth/  users/  admins/  accounts/  properties/  leads/
│   └── feedback/  contacts/  cms/  locations/  dashboard/
│
└── shared/                pure functions, no I/O
```

## The dependency rule

```
routes → service → repository → platform → core
```

Enforced by ESLint `no-restricted-imports` in [M08](../milestones/M08-delivery-ops.md). Until then,
by review.

| Layer | May import | Must never |
|---|---|---|
| `*.routes.js` | its module's service, `core/*` | `prisma`, another module |
| `*.service.js` | its repository, `platform/*`, `core/*`, other modules' `index.js` | `req`, `res`, another module's internals |
| `*.repository.js` | `platform/db` | anything domain-shaped |
| `core/*` | `core/*` | any module, `platform/*` |
| `platform/*` | `platform/*`, `core/*` | any module |

A module's public surface is its `index.js` and nothing else. See
[module-contract.md](module-contract.md).

## Cross-module data access

The model graph is entangled: `admin` writes `property`/`feedback`/`delAccount`/`registerEmail`;
`user` writes `property`; `property` deletes `propertyLead`; `lead` reads `property`. Several of
these are already in one `$transaction`.

Per [ADR 0002](../adr/0002-single-prisma-client-split-schema.md): **one Prisma client, schema split
by module, cross-module `$transaction` allowed.** A module may write another module's table; it may
not import another module's code. That is the pragmatic line.

## Cross-cutting concerns extracted from services

| Concern | Was | Is now | Milestone |
|---|---|---|---|
| Env access | read at module load in `jwt.service:3`, `email.service:4-14`, `admin.service:51` | `config/` — one reader, 31 keys, frozen | **done, M01** |
| Error type | `AppError` lived in `middleware/errorHandler.js`; **10 services imported upward into the HTTP layer** | `core/errors/`, re-exported from the old path until M06 | **done, M01** |
| Response envelope | `res.json({ success: true, data: x })` written ~70 times by hand | `core/http/response.js` — `res.ok` / `created` / `paginated` / `noContent` | **done, M01**; call sites land M03-M06 |
| Pagination | one 13-line block copy-pasted **13 times**; only `property.service:177` clamps `limit` | `core/http/pagination.js` — cap is now unconditional | **done, M01**; call sites land M03-M06 |
| Async errors | `try/catch → next(err)` in every handler | `core/http/asyncHandler.js` | **done, M01**; call sites land M03-M06 |
| Logging | `morgan`; error handler logs `err.message` only | `core/logger/` — pino, one line per request, `X-Request-Id` propagated | **done, M01**; `email.service` still `console.error`s (M00.9) |
| Prisma errors | unhandled → 500 naming a database column | `core/errors/prisma.js`: `P2002`→409, `P2025`→404 | **done, M01**; `P2003`/`P2014`/`P2034` need per-module messages, M03+ |
| Upload middleware | `upload.service.js` exports **6 multer middlewares**, not services; routes import it as middleware | `platform/storage` | **done, M02** (local-disk adapter; S3 still open) |
| Rate limiting | in-memory, per-replica, resets on deploy | per-process `MemoryStore`, counted in `/metrics` | **done, M02** — no Redis available; the per-replica ceiling is accepted, not solved |
| TSV export | `lead.service:96-117` builds the string in a service | queued job, streamed | M05 |

## Module boundaries

| Module | Absorbs | Notes |
|---|---|---|
| `auth` | `auth.service`, `jwt.service` | reference implementation, [M03](../milestones/M03-auth-module.md) |
| `users` | `user.service` | writes `property` on delete/block — legal, but make it explicit |
| `admins` | `admin.service` | separate login impl, SHA-1 fallback — collapses into one `password.service` |
| `accounts` | ledgers from `admin.service:445,461,476` | exists only as a dependency of admin user management |
| `properties` | `property.service` | `VisibilityPolicy`; **price migration** |
| `leads` | `lead.service` | unbounded TSV export → queue |
| `feedback` | `feedback.service` | admin routes use `/api/admin/feedback/*`; mapper exposes frontend field names |
| `contacts` | `contact.service` | public submissions and admin CRUD live in one module |
| `cms` | `about.service`, `team.service` | create/update schemas validate request bodies |
| `locations` | `location.service` | one shared id schema; admin guard is in the manifest |
| `dashboard` | `dashboard.service` | one batched query per read model, cached for 30 seconds |

## Request lifecycle

```
req
  └→ requestId          generate / accept upstream X-Request-Id
  └→ pino-http          structured log, redacted
  └→ metrics timer      duration + status on response `finish`
  └→ helmet, cors
  └→ rate limit         per-process MemoryStore; counts to /metrics
  └→ body parse
  └→ envelope()         installs res.ok / res.created / res.paginated / res.noContent
  └→ /api routes        mounted from src/routes today, the module registry from M03
      └→ authenticate / requireRole
      └→ validate (zod)  → 400 VALIDATION_ERROR
      └→ asyncHandler → service → prisma (via platform/db)
      └→ respond.ok / created / paginated
  └→ notFound           404 { success: false, error: { message } }
  └→ errorHandler       AppError → its status/code
                        zod / multer / prisma P2002·P2025 → translated
                        otherwise 500, stack logged with reqId, body never leaks
```

Everything above the second `└→` is `src/app.js` and is side-effect free. Everything below
`/api routes` is `src/routes` and is frozen until M03.

## Scale posture

| Layer | Ceiling today | After |
|---|---|---|
| Replicas | **1** — `public/uploads` is on local disk | N, once the S3 storage adapter lands ([M02](../milestones/M02-scale-infrastructure.md)) |
| Rate limiting | per-process, lost on restart | per-process, **stated** — `amaken_api_rate_limit_store{store="memory"}` makes the ceiling visible instead of silent. A shared counter needs a shared store, and there is none |
| Caching | none | **done, M02** — in-memory with TTL, plus a MySQL tier for `otp` so credentials are not replica-local. Not a shared cache |
| Async work | email inline; lead export synchronous and unbounded | **done, M02** — MySQL-backed queue, separate worker process, at-least-once with leases. Not horizontally scalable until S3 lands |
| Health | `/health` checks nothing | **done, M02** — `/health/live` + `/health/ready` (DB + queue + storage) |
| Metrics | `/metrics` — request duration, request count, error count, `up`. No pool gauge, no rate-limit hits yet | **done, M02** — pool connections, queue depths, backlog, job outcomes, rate-limit store and hits |
| Shutdown | `server.close()` then `prisma.$disconnect()`, bounded by `SHUTDOWN_TIMEOUT_MS`; Redis and queue added in M02 | **done, M02** — bounded drain: stop accepting → in-flight → close queues → `$disconnect()` → exit 0 |

The single hard blocker to horizontal scaling is local-disk storage. Noted as an accepted ceiling
until the S3 adapter exists.

**What M02 did not change:** the queue worker scales out freely (no local state), but the API
cannot, because of uploads. Two constraints, not one.

## Deliberately not doing

- **Microservices** — [ADR 0001](../adr/0001-modular-monolith.md).
- **A build step or TypeScript runtime** — plain CommonJS. Static safety comes from JSDoc +
  `checkJs` ([M08](../milestones/M08-delivery-ops.md)).
- **ORM per module / database per module** — [ADR 0002](../adr/0002-single-prisma-client-split-schema.md).
- **Versioned API paths (`/api/v2`)** — the frontend hardcodes `/api` and `getAssetUrl` strips the
  `/api` suffix to build asset URLs (`lib/utils.ts:8`). Revisit only with a deliberate migration plan.
- **CQRS / event sourcing** — `dashboard` is a read-model; that is sufficient. Full CQRS is not
  justified by one dashboard endpoint.
