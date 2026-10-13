# Runbook

Operational procedures. Sections marked **[planned]** do not apply yet — they describe the target
state after the milestone named.

## Environment

**Every key is declared in `src/config/env.schema.js` and validated at boot.** `src/config/` is the
only place in `src/` permitted to read `process.env`, and it reads it after `dotenv` — see
[Load order](#load-order). An undeclared key is ignored, which is the failure mode to look for when
a setting "does nothing".

### Required in production

`src/config` refuses to boot without these. Outside production it warns and starts, because a fresh
clone with no `.env` still has to run the contract tests.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | MySQL 8. `mysql://user:pass@host:3306/db` |
| `JWT_SECRET` | [M00.4](milestones/M00-safety-net.md) additionally rejects the historical `"dev-secret-fallback-only"` literal at boot. |
| `JWT_REFRESH_SECRET` | Same. Must differ from `JWT_SECRET`. |

### Everything else, with its default

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Any string. Only `production` is branched on. |
| `HOST` / `PORT` | `0.0.0.0` / `5000` | |
| `CORS_ORIGIN` | `http://localhost:3000` | **Comma-separated** list, whitespace tolerated. Matched exactly — never a prefix, so `https://site.com` does not admit `https://site.com.evil.example` |
| `BODY_LIMIT` | `10mb` | json and urlencoded |
| `TRUST_PROXY` | `false` | **Leave false unless there is a proxy in front.** Trusting `X-Forwarded-For` without one lets a client forge its address and walk around the rate limit |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` | `900000` / `100` / `20` | Per-process counters. See [single replica](#deployment-constraint-single-replica) |
| `QUEUE_ENABLED` | `true` | `false` makes `enqueue()` a no-op that returns `null` |
| `QUEUE_PREFIX` | `amaken` | Prefixes every job id and every queue row, so two environments can share one database |
| `QUEUE_CONCURRENCY` | `5` | In-flight jobs per worker process |
| `QUEUE_POLL_INTERVAL_MS` | `1000` | Idle poll cadence. Replaces BullMQ's blocking `BRPOP` |
| `QUEUE_LEASE_MS` | `60000` | Claim lease. A crashed worker's jobs are reclaimable once this expires |
| `QUEUE_ATTEMPTS` / `QUEUE_BACKOFF_MS` | `3` / `5000` | Attempts before a job is dead-lettered, and the first retry delay. Exponential thereafter |
| `QUEUE_MAX_DEAD_JOBS` | `500` | Dead rows tolerated before the oldest are pruned. Bounds the table without deleting the poison job you need to see |
| `CACHE_TTL_SECONDS` | `300` | Default TTL for the in-memory tier |
| `CACHE_DURABLE_NAMESPACES` | `otp` | Namespaces written to MySQL. Durable namespaces bypass the in-memory tier |
| `CACHE_PREFIX` | `amaken` | Prefix for every `kv_entries` key |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` | |
| `LOG_LEVEL` | `debug` dev, `info` prod, `silent` test | `silent` in the test suite — stdout is assertion noise there |
| `REQUEST_ID_HEADER` | `x-request-id` | Also always emitted as `X-Request-Id` on the response |
| `LOG_REDACT` | authorization, cookies, passwords, OTPs, tokens | Passing a value **replaces** the default list, it does not extend it |
| `METRICS_ENABLED` / `METRICS_DEFAULT_PREFIX` | `true` / `amaken_api` | |
| `UPLOAD_DIR` | `<repo>/public/uploads` | Absolute. See the single-replica constraint below |
| `SMTP_*`, `SITE_NAME` | `smtp.gmail.com`, `587`, … | |
| `ADMIN_MAIN_PHONE` | — | Must match `admin.main` for the super-admin row |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Hard cap on the drain |
| `DB_CONNECT_RETRIES` / `DB_CONNECT_RETRY_DELAY_MS` | `5` / `1000` | Boot retries before giving up on MySQL |
| `TEST_DB_NAME` | `amaken_db_test` | Must end in `_test` — `scripts/test-db.js` refuses otherwise |

### Load order

`dotenv` is loaded **before any application `require`**, and this is enforced by module structure,
not by discipline: `src/config/index.js` calls `dotenv.config()` as its first statement, and
`src/server.js` requires `config` before anything else.

This is not a style preference. The original `src/index.js` called `dotenv.config()` at line 12,
*after* requiring the route graph, so `jwt.service` read an empty `process.env` and signed every
token with a secret committed to the repository. Anyone could forge an admin token
([M00 finding #1](milestones/M00-safety-net.md)). If you add a module, require `config` — never
`process.env` — so the question never arises again. `test/unit/kernel.test.js` fails the build if a
third file reaches for `process.env`.

## Local development

Prerequisites: **MySQL 8 running**, Node 22+, pnpm.

```bash
cd backend
pnpm install
cp .env.example .env          # edit DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET
pnpm db:generate              # required after any schema.prisma change
pnpm db:push                  # the schema path — there is no prisma/migrations/ directory
pnpm dev                      # node --watch src/index.js
```

```bash
curl localhost:5000/health
curl localhost:5000/api
curl localhost:5000/metrics
```

The API **will not start if MySQL is unreachable.** It retries `DB_CONNECT_RETRIES` times
(5 × 1s by default) and then exits non-zero. This is deliberate: a replica that answers 500s for
the first seconds of every deploy is worse than one that is not yet accepting connections, and a
load balancer does not wait for a closed port. If you need the old boot-anyway behaviour while
working without a database, raise `DB_CONNECT_RETRIES` — but do not ship that.

> **Do not run `pnpm lint`.** It cannot run: `.eslintrc.json` exists but `eslint` and
> `eslint-config-prettier` are not in `devDependencies`. Being fixed in
> [M08](milestones/M08-delivery-ops.md).
>
> **Do not run `pnpm lint` in `frontend/` either.** There is no ESLint config, so `next lint` drops
> into an interactive setup prompt and will hang a non-interactive shell.
>
> The backend's static gate is **`pnpm check`** (`node --check` over every file in `src/`) plus
> **`pnpm test`**, which includes `test/unit/kernel.test.js` — that is what enforces "no
> `process.env` outside `config/`" and "the app binds nothing". In `frontend/`, the only working
> static check is `npx tsc --noEmit`.

### Property images 404 locally

`getAssetUrl` (`frontend/lib/utils.ts:15-18`) rewrites `/uploads/properties/*` to
`NEXT_PUBLIC_PROPERTY_IMAGE_BASE`, whose default is the **production CDN host**. For local work:

```
NEXT_PUBLIC_PROPERTY_IMAGE_BASE=http://localhost:5000/uploads/properties
```

There is no committed `frontend/.env.local`. `NEXT_PUBLIC_API_URL` defaults in code to
`http://localhost:5000/api`.

## Deployment **[planned, M08]**

Docker + compose. Migrations run as a **separate release step, never on boot** — a replica that
migrates on start races every other replica.

```bash
docker compose build
docker compose run --rm api node prisma migrate deploy   # release step
docker compose up -d
```

The drain depends on the container receiving
`SIGTERM`. Run with `--init` or `dumb-init`, or the process will be killed without draining.

There is **no Redis and no container runtime in this deployment.** MySQL is a managed instance, not
something compose brings up. The compose file above is the shape M08 will produce; until it lands,
deploy by running `pnpm start` and `pnpm worker` against a managed MySQL.

## Health

| Endpoint | Meaning | Now |
|---|---|---|
| `/health` | process is up | returns `{ status, timestamp }` — checks nothing |
| `/health/live` | process is up | returns `{ status, uptimeSeconds }` — checks nothing external |
| `/health/ready` | MySQL, the queue and local storage all reachable; 503 otherwise | `checks[]` reports each one with its own latency |

Point the orchestrator's readiness probe at `/health/ready` and the liveness probe at
`/health/live`. Pointing liveness at readiness causes a traffic spike to be killed during a
transient database blip.

Because the process already refuses to start without MySQL (see
[Local development](#local-development)), a *running* process always has a reachable database at
boot. `/health/ready` is what detects the database going away **after** boot.

## Deployment constraint: single replica

**The API must run as exactly one replica until the S3 storage adapter lands.**

`backend/public/uploads` is on local disk. Replica B serves no uploaded images — every avatar,
logo, team photo, about image and property image written to replica A 404s on replica B. Rate
limiting is also in-memory, so a second replica doubles the effective limit.

**The queue worker is not affected by this constraint.** `pnpm worker` holds no local disk state
and no counters, so it scales out freely — and that is the intended way to absorb queue backlog
while the API stays a single replica.

The storage abstraction (`platform/storage`) has a local-disk adapter; the S3 adapter is the exit
path for the API. Until then, scale **up** (vertical) for the API, and **out** for the worker.

## Graceful shutdown

`SIGTERM` / `SIGINT` → stop accepting connections → let in-flight requests finish →
`closeQueues()` → `prisma.$disconnect()` → exit. The drain is bounded by `SHUTDOWN_TIMEOUT_MS`
(10s); if it expires the process exits non-zero rather than being killed mid-request by the
orchestrator. `uncaughtException` and `unhandledRejection` run the same drain and then exit
non-zero.

**The queue is closed before Prisma, deliberately.** A request still in flight may be about to
enqueue a background email, and that enqueue is a database insert. Disconnecting Prisma first
turns it into a failed enqueue — survivable, because `enqueue()` fails open, but it is a mail that
never gets sent on every single deploy.

**The worker drains separately.** `pnpm worker` installs the same signal handlers, stops claiming,
and waits for in-flight jobs before closing Prisma. Give it at least `SHUTDOWN_TIMEOUT_MS` of
grace, or its jobs are killed mid-flight and recovered later via the lease — which duplicates the
work but does not lose it.

**The container must deliver `SIGTERM`.** Without an init process (`docker --init`, or
`dumb-init`) PID 1 is Node, and a default `docker stop` sends the signal to the shell wrapper
instead. The deploy will look clean and drop every connection.

Note for local verification on Windows: Git Bash's `kill`/`taskkill` terminates the process
outright and never delivers `SIGTERM` to Node, so the handlers above will not run. Exercise
`drain()` in-process, or test the signals on the platform you deploy to.

## Observability

**Logging.** `pino` + `pino-http`, one JSON line per request. Every response carries an
`X-Request-Id` header; an inbound one is honoured, so a gateway-minted id survives the whole hop
chain. `/health` and `/metrics` are excluded from the access log — an orchestrator probing every
two seconds would bury every real request. Level is `LOG_LEVEL`, defaulting by environment.

```
{"reqId":"1f0c…","requestId":"1f0c…","method":"GET","url":"/api/properties","statusCode":200,"responseTime":42,"msg":"request completed"}
```

To follow one request across every line it produces, take the `X-Request-Id` from the response and
grep for it. `email.service` still logs with `console.error` — [M00.9](milestones/M00-safety-net.md)
completes that half.

**Metrics.** `GET /metrics`, Prometheus text format, unauthenticated.

| Series | Labels |
|---|---|
| `amaken_api_http_request_duration_seconds` | `method`, `route`, `status` |
| `amaken_api_http_requests_total` | `method`, `route`, `status` |
| `amaken_api_http_errors_total` | `code` |
| `amaken_api_up` | — |
| `amaken_api_queue_jobs` | `queue`, `status` (`pending`/`active`/`completed`/`failed`) |
| `amaken_api_queue_backlog_total` | — |
| `amaken_api_queue_jobs_total` | `queue`, `result` (`completed`/`failed`/`pending`) |
| `amaken_api_queue_enqueue_errors_total` | `queue` |
| `amaken_api_rate_limit_hits_total` | — |
| `amaken_api_rate_limit_store` | `store` (`memory`/`redis`) |
| `amaken_api_db_pool_connections` | `state` (`open`/`in_use`/`idle`) |

`route` is the matched **pattern** (`/api/properties/:id`), never the URL — unbounded labels are
the fastest way to OOM a process. Unmatched paths collapse to `route="unmatched"`, which is worth
an alert on its own.

`amaken_api_queue_backlog_total` counts `pending + active + failed` and **excludes** `completed`,
so it does not ratchet upward over the life of a deployment. It is only refreshed on scrape, and
only by a process that has opened the queue — an API replica that never enqueues reports nothing
rather than issuing a database round-trip per scrape.

**An unmeasurable gauge is absent, not zero.** Both `queue_backlog_total` and `db_pool_connections`
are removed from the scrape rather than left holding their initial `0` when the thing they describe
cannot be read. This matters because `0` is a *confident* reading: `queue_backlog_total 0` says
"the queue is empty", which is exactly the wrong thing to conclude while the queue is unreachable.
So if an alert on either series goes silent, treat **silence as the outage**, not as good news —
confirm with `/health/ready`, which reports `queue` and `database` explicitly. Prometheus alert
rules need `absent()` or a `max_over_time` guard to notice the difference; a bare
`queue_backlog_total > 100` will never fire when the series vanishes.

**There is no `db_pool_max_connections` series.** Prisma exposes open/busy/idle but *not* a
ceiling — the limit comes from `connection_limit` in `DATABASE_URL`. Rather than publish a `0` that
would read as "the pool can never grow", the gauge is omitted. To alert on saturation, derive the
ceiling from the connection URL and compare it with `state="open"`, or alert on `state="idle"`
reaching `0`, which is the point at which the pool is genuinely full.

`db_pool_connections` requires the Prisma **`metrics` preview feature**, enabled in the generator
block of `schema.prisma`. If it is ever removed, or the client is regenerated from a schema without
it, `prisma.$metrics.json()` is unavailable and the pool series go **absent** — which, per the
paragraph above, is the honest failure mode. Regenerate with `pnpm db:generate` after any change
to the generator block, and note that regenerating requires no other `node` process holding the
query-engine DLL.

Two series to alert on: `amaken_api_queue_jobs{status="failed"}` rising (a poison job or a dead
dependency), and `amaken_api_queue_enqueue_errors_total` rising (the enqueue path is failing, and
because `enqueue()` fails open, **nothing in the request path reports it** — emails are simply
not being sent).

## The queue worker

The queue is MySQL tables, not Redis. `pnpm worker` runs `src/worker.js`, which polls, claims,
processes and completes. Run it as its own process: the API only enqueues.

```bash
pnpm worker          # one worker process
pnpm worker:dev      # same, restarting on file changes
```

Adding a second worker process is safe and is how you add throughput — claims are exclusive
(`FOR UPDATE SKIP LOCKED` plus a conditional update), so two workers never run one job. Each
process gets `QUEUE_CONCURRENCY` in-flight jobs, so **total concurrency is the sum across
workers**, not a global cap.

**Delivery is at-least-once.** A worker that dies mid-job leaves the row `active`; once
`QUEUE_LEASE_MS` expires another worker reclaims it and runs it again. Processors must therefore
be idempotent. The ones here are: OTP sends an already-issued code, and lead export rewrites a
file.

`SIGTERM` stops claiming and waits for in-flight jobs before exiting. Give it at least
`SHUTDOWN_TIMEOUT_MS` or the process is killed mid-job — which is survivable (the lease recovers
it) but shows up as a duplicate attempt.

**A job stuck `active` with a live `locked_at`** means its worker is still running it. Wait for the
lease rather than resetting the row; forcing it to `pending` runs the job a second time while the
first attempt may still finish.

## Incident triage

### Queue backlog is growing

Read the per-status breakdown first. `pending` climbing with `active` at `QUEUE_CONCURRENCY` is
normal throughput — add workers, or raise concurrency. `pending` climbing with `active` at zero
means **no worker is running**; check the worker process, not the queue. `failed` climbing is a
different problem entirely: one job is failing repeatedly, and its `last_error` is the diagnosis.

```bash
# What is actually queued, and why it is not moving
mysql "$DATABASE_URL" -e "
  SELECT queue, status, COUNT(*) AS n, MIN(run_at) AS oldest
  FROM jobs WHERE status IN ('pending','active') GROUP BY queue, status;"

# One job's history, including who last held it and why it failed
mysql "$DATABASE_URL" -e "
  SELECT id, queue, status, attempts, max_attempts, locked_by, locked_at, last_error
  FROM jobs WHERE id = '<job-id>'\G"
```

Jobs reach `failed` (the dead-letter) after `max_attempts`, with exponential backoff between them.
`last_error` is truncated to 2000 characters, so it holds the cause and not the full stack.

### An OTP or password-reset code is not accepted

The `otp` namespace is durable, so the code lives in `kv_entries` rather than process memory —
but a **failed durable write leaves the code unstored**, and verification then reports
`OTP_INVALID`. That is deliberate: serving from a per-process copy would fail silently on one
replica and loudly on the others. Look for a database error in the logs at the moment the code
was requested, and check `kv_entries` for the key.

`/metrics` exposes traffic shape, not data: no query strings, no headers, no bodies. It is still
unauthenticated, so keep it off a public hostname or put a network policy in front of it.

## Incident triage

### JWT rejected but the secret is set

Check the value is not the historical fallback. Before M00.4 the fallback was silent in every
environment, so tokens signed before the fix and after it can be mutually invalid — expect a
mass re-login, which is the correct outcome.

### Emails never arrive

`email.service` historically caught every send failure and returned `false`; callers ignored the
return value. The API returned success while no mail was sent, and OTP / password-reset / admin
notification mail failed silently. **[M00.8](milestones/M00-safety-net.md)** surfaces the failure.

Check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — all four now come from `config.mail.*`,
so a typo in `.env` shows up as a config validation warning at boot rather than a silent default.
Gmail requires an App Password, not the account password. There is no fallback transport — an
invalid SMTP config fails the flow.

### An env var "does nothing"

Check it is declared in `src/config/env.schema.js`. Undeclared keys are silently dropped at
validation. The schema is the contract, and adding a key to `.env` without adding it there is the
single most likely cause of a setting that has no effect.

### Price filter or sort returns wrong results

Known, documented, unfixed. `Property.price` is `VarChar(100)` and is range-filtered and sorted as
a **string**, so `"9000000" < "950000"`. Fix and data migration land in
[M05](milestones/M05-property-domain.md). Until then, do not trust price ordering.

### A user's uploads 400 with "No image file provided"

The multer field name must match the client's FormData key. They were inconsistent:
`about`/`team` use `image`; the profile avatar and company-logo pages append `avatar`/`logo` while
`uploadProfileImage`/`uploadLogo` were `.single("image")`. Fixed in
[M00.7](milestones/M00-safety-net.md). **Verify the field name against the multer config whenever
you touch an upload path.**

### Authenticated user redirected to `/login` in a loop

`frontend/middleware.ts` guards routes by reading an `access_token` **cookie**, but tokens are
stored in `localStorage`. The middleware never sees a logged-in user. Do not assume `middleware.ts`
enforces anything; real enforcement is `requireRole("admin")` on the backend. `/admin/*` has no
server-side protection either — the redirect is a client-side `useEffect` in
`frontend/app/admin/layout.tsx`.

### A new admin endpoint 401s even with a valid admin token

The frontend picks the admin token with a literal `url.startsWith("/admin")` test
(`baseApi.ts:13`). An admin endpoint outside that prefix silently gets the **user** token. `/api`
prefixing is not enough — it must be `/api/admin/...`.

## Secret rotation

**[planned]** No procedure exists while the fallback-secret bug is live. After M00.4:

1. Rotate `JWT_SECRET` and `JWT_REFRESH_SECRET` in the secret store.
2. Restart all instances.
3. All sessions invalidate; users and admins re-authenticate. There is no `kid` support and no
   overlap window.
4. For a zero-downtime rotation, add a `kid` header and support two active keys. Not scheduled.

## Backup

**[planned, M08]** MySQL is the only stateful component. `backend/public/uploads` is **not** backed
up by a database dump and is lost on container replacement. This is another reason to move to S3.
