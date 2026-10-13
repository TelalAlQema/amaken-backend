# M02 — Scale infrastructure

- **Status:** pending
- **Depends on:** M01
- **Blocks:** M05 (queue-based export), M06 (dashboard cache)

## Goal

Remove the structural single-replica ceiling and make the process observable and drainable.

## Deliverables

> **This table is the original plan**, written when Redis was assumed available. It is left as-is so
> the milestone's intent stays legible, but three rows were not delivered that way: rate limiting,
> caching and the queue all run on MySQL instead. See
> [As built](#as-built-redis-removed).

| Area | Work | Why |
|---|---|---|
| **Rate limiting** | `express-rate-limit` with a Redis store, fail-open on Redis outage | In-memory counters are per-replica and reset on every deploy. Under N replicas the effective limit is N× the configured value. |
| **Cache** | Redis client + a small `get`/`set`/`invalidatePrefix` wrapper; in-memory fallback for dev | Needed by M06 dashboard caching and OTP storage. |
| **Queue** | BullMQ + a worker entrypoint; jobs for OTP email, lead notifications, TSV export | Email in the request path couples user-facing latency to SMTP. `lead.service.js:98-115` loads every lead into memory synchronously. |
| **Graceful drain** | On `SIGTERM`/`SIGINT`: stop accepting → let in-flight finish (bounded) → `prisma.$disconnect()` → close Redis → exit | Today `server.close()` is called but the Prisma pool and Redis are never drained, so deploys drop connections. |
| **Timeouts** | `server.keepAliveTimeout`, `server.headersTimeout`, `requestTimeout` | Defaults are wrong behind an ALB. Slowloris exposure otherwise. |
| **Health probes** | `/health/live` (process up), `/health/ready` (DB + Redis reachable), keep `/health` as an alias | Compose healthcheck and any orchestrator rollout depend on this. `/health` today checks nothing. |
| **Metrics** | `prom-client`: request duration histogram, status counters, rate-limit hits, pool gauge | Nothing is measurable today. |
| **Crash policy** | `unhandledRejection` → log + drain + exit non-zero. `uncaughtException` → log + exit immediately | `src/index.js:113-115` currently logs the rejection and continues in an unknown state. |
| **Compression** | `compression` middleware | Property list payloads are JSON-heavy. |
| **Storage port** | Abstract `platform/storage` behind an interface; keep the local-disk adapter | **Do not** add the S3 adapter here — but the port must exist so M05/M06 write against the interface. Local disk is the hard multi-replica blocker; document the ceiling explicitly. |

## Decision recorded

Redis is available from this milestone. S3 is deferred — until the S3 adapter lands, **the API must
run as a single replica**, and `docs/runbook.md` must state why. Uploaded files live in
`backend/public/uploads` and replica B will 404 every image.

## Verification

> **Superseded.** This block is the original plan and assumes Redis. It was not run as written —
> `docker compose up -d redis mysql` cannot work here. See [As built](#as-built-redis-removed) at the
> end of this document for what was actually verified.

```bash
docker compose up -d redis mysql
node --test test/
node src/index.js
curl localhost:5000/health/live
curl localhost:5000/health/ready
curl localhost:5000/metrics
# drain test: send SIGTERM mid-request, confirm the request completes
```

## Definition of done

- [ ] `/health/ready` returns 503 when MySQL or Redis is unreachable
- [ ] SIGTERM drains in-flight requests, closes Prisma and Redis, exits 0
- [ ] Rate limit survives a restart (Redis-backed)
- [ ] `/metrics` exposes request duration and status counters
- [ ] A queued job runs in a worker and survives an API restart
- [ ] `runbook.md` documents the single-replica constraint and the S3 exit path

---

## As built: Redis removed

**Redis is not available in this deployment, and there is no container runtime to start one.** The
milestone above was written assuming Redis; it was delivered against MySQL instead. MySQL is the
one dependency the API already cannot answer a request without, so "reachable for a replica that
can serve traffic" is also "reachable for the queue and the durable cache".

| Was | Is now |
|---|---|
| Redis rate-limit store | per-process `MemoryStore` (`core/http/rateLimit.js`), counted in `/metrics` |
| Redis cache with in-memory fallback | in-memory L1, plus a **durable MySQL tier** for `otp` (`platform/cache/`) |
| BullMQ | `platform/queue/` — a `jobs` table, a polling worker, and three processors |
| `/health/ready` checks MySQL + Redis | checks MySQL + queue + storage |

### What was gained, and what was given up

**Gained.** No new infrastructure to provision, monitor, back up or secure — the queue and the
durable cache are queryable with the same credentials as everything else. Deployment is two
processes on the same host.

**Given up, explicitly:**

- **Rate limiting is still per-replica.** This does *not* solve the N× problem; it makes it
  visible via `amaken_api_rate_limit_store{store="memory"}`. It is a stated ceiling, not a fix.
- **Caching is not shared.** The durable tier exists for `otp` only, precisely because a
  replica-local OTP fails ~50% of registrations in a way that reads as user error. Dashboard
  caching stays replica-local and stale by at most `CACHE_TTL_SECONDS`.
- **Polling instead of blocking pops.** An idle worker costs two indexed `SELECT`s per
  `QUEUE_POLL_INTERVAL_MS`. Cheaper than Redis was not the constraint; a predictable claim
  protocol was.

### Two design notes worth keeping

**The claim protocol is not `LIMIT 1 … FOR UPDATE SKIP LOCKED`.** InnoDB locks every record a
locking read *scans*, so that form is exclusive but monopolises: one worker locks the whole scan
range, returns one job, and every other worker idles. It passes a "no duplicates" test while
failing the only reason that test exists. The shipped version takes an unlocked candidate read,
locks candidate **primary keys** with `SKIP LOCKED`, then updates conditionally — see
`store.reserve` and the tests named *"reserve is exclusive"* and *"work spreads across workers"*.

**`depths()` returns `{ byQueue, total }`, not a flat map with a `total` key.** A map that also
carries a scalar is iterable as if the scalar were a queue, and `depths.total` off a map that has
none reads as `0` — which publishes "the queue is empty" during the exact outage where it is not.
`total` is computed in the store from the rows already fetched, which is what lets
`queueBacklog`'s documentation promise a total derived from the same query as the per-queue
gauges.

**A gauge that cannot be measured is removed from the scrape, and `reset()` does not do that.**
Both `queueBacklog` and `dbPoolConnections` are `Gauge`s, and an unlabeled `Gauge` is *born
holding 0* — so the out-of-the-box behaviour is to publish a confident `0` for a thing nobody
looked at. For the backlog that reads as "the queue is empty", during the outage where nobody can
see the queue. Both now `remove()` their series on the unmeasurable paths.

The distinction is not cosmetic and was not obvious: on prom-client 0.16, `reset()` **keeps** an
unlabeled gauge and sets it to `0`, while `remove()` deletes the series. Using `reset()` here would
have passed a test that only asserted the value was `0`, and shipped a lie. `remove()` is also
idempotent, so it is safe on label values that were never set.

**The pool gauge reads the payload Prisma actually returns, which is not the one that was
documented.** `$metrics()` was being called as a function and its result normalised against a
`{ pool: { connections, active_connections, idle_connections, max } }` shape. In Prisma 5.22
neither is true: `$metrics` is an **object** exposing `.json()`/`.prometheus()`, and `.json()`
returns `{ counters, gauges, histograms }` — arrays of `{ key, labels, value }`. So the call
threw `is not a function`, a `catch` swallowed it into a debug line, and the pool gauges sat at
their birth value of `0` while looking perfectly healthy. The feature also had to be turned on:
the generator block now carries `previewFeatures = ["metrics"]`, and the client must be
regenerated (`pnpm db:generate`) or `$metrics.json()` is unavailable.

Worth flagging as a process point: the test that "verified" this asserted the invented
`{ pool: … }` shape, so it passed indefinitely while the production gauge read zero. **A shape
assertion is only worth something if the shape was captured from the driver.** The replacement
fixture is the real payload, recorded verbatim.

There is deliberately **no `db_pool_max_connections` series**. Prisma reports open/busy/idle and
no ceiling — that comes from `connection_limit` in `DATABASE_URL`. The gauge could never hold a
measured value, and publishing `0` for a pool ceiling is worse than publishing nothing: `0` reads
as a pool that can never grow, which is precisely what an operator would conclude from it. The
name is reserved in a comment explaining how to derive saturation instead.

### Verification, as run

```bash
pnpm test                       # 165 tests, against real MySQL
pnpm check                      # syntax across src/
node src/index.js               # API: /health/live, /health/ready, /metrics
node src/worker.js              # worker: claims, processes, completes
```

Confirmed by hand: readiness reports all three checks green; a scraped backlog gauge counts
`pending + failed` and excludes `completed`; enqueueing a known id twice returns `duplicate:
true`; a job that fails its processor retries with growing backoff and reaches `failed` as a
dead-letter with `last_error` intact; `drain()` closes HTTP → queue → Prisma and exits 0.

**Not verified here:** `SIGTERM` delivery. Git Bash's `kill` and `taskkill` terminate a Windows
process outright without delivering the signal to Node, so the handlers cannot be exercised on
this platform — the drain was verified by calling it in-process. Test signals where you deploy.

### Definition of done, as delivered

- [x] `/health/ready` returns 503 when MySQL or storage is unreachable — Redis no longer exists
- [x] SIGTERM drains in-flight requests, closes the queue and Prisma, exits 0
- [ ] Rate limit survives a restart — **not delivered**, and cannot be without a shared store.
      The `/metrics` series states the limitation instead
- [x] `/metrics` exposes request duration, status counters, queue depths and outcomes
- [x] A queued job runs in a worker and survives an API restart
- [x] `runbook.md` documents the single-replica constraint and the S3 exit path

One box is deliberately unticked. Claiming it would mean claiming something the code does not do.
