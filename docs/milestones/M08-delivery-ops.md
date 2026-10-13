# M08 — Delivery and operations

- **Status:** pending
- **Depends on:** M07

## Goal

Turn the architecture into something a team can operate. The boundaries are worthless if nothing
enforces them and nobody can deploy it.

## Work items

### Fix ESLint — it is currently dead
`.eslintrc.json` exists but `eslint` and `eslint-config-prettier` are not in `devDependencies`, so
`pnpm lint` cannot run. Add them, then add the rules that make [ADR 0001](../adr/0001-modular-monolith.md)
real:

- `no-restricted-imports` — forbid a module reaching into another module's internals (e.g.
  `../users/*.service` is banned; `../users` is the only legal form).
- `no-restricted-imports` for `core/` and `platform/` — they may not import from `modules/`.
- `no-restricted-imports` in `*.routes.js` — may not import `prisma`.
- `no-restricted-syntax` — no `res.json` outside `core/http/response.js`, no `try/catch` in routes.
- `no-console` outside `src/config` and `src/server.js`.

### Typecheck ratchet
- `tsconfig.json` — `strict`, `checkJs`, `noEmit`, including only `core/`, `platform/`, `config/`,
  `bootstrap/`, `shared/`, `modules/`, `app.js`, `server.js`. **Blocking gate.**
- `tsconfig.legacy.json` — `checkJs`, `strict: false`, including only `routes/`, `services/`,
  `middleware/`, `lib/`. **Advisory.** Should be empty by end of M06 → delete it.

### Docker
- Multi-stage `Dockerfile`: deps → build Prisma client → slim runtime. Non-root user, `dumb-init` or
  `--init` for signal delivery (the drain in M02 depends on receiving `SIGTERM`).
- `docker-compose.yml` — MySQL 8, API, worker, and the Playwright `webServer` path. **No Redis
  service.** [M02](M02-scale-infrastructure.md) put the queue and the durable cache in MySQL, so
  there is nothing left for Redis to do — a compose file that still brings one up is provisioning a
  dependency nothing connects to. The worker is a second service for the same reason: the API only
  enqueues.
- **Migrations run as a separate `release` step, never on boot.** A replica that migrates on start
  races every other replica. Add a `migrate` target and wire it to compose's ordering, not the
  entrypoint.

### CI
`.github/workflows/ci.yml`, in order: install → `prisma generate` → `prisma validate` → lint →
`node --check` over `src/` → `node --test` → `npx tsc --noEmit` → migration dry-run against a
throwaway MySQL service container. Frontend: `npx tsc --noEmit` + `pnpm build`. **Do not run
`pnpm lint` in `frontend/`** — it has no ESLint config and `next lint` drops into an interactive
setup prompt that hangs CI.

### Observability
- Sentry for unhandled errors. Pass the request id through so a log line and a Sentry event
  correlate.
- Alert on: `/health/ready` failures, 5xx rate, p95 latency, queue depth, connection pool
  saturation.

### Load testing
`k6` against the two hot paths, with a stated budget:

| Scenario | Target |
|---|---|
| `GET /api/properties` (public listing, filtered) | p95 < 300 ms, 200 rps sustained |
| `POST /api/auth/login` | p95 < 500 ms, no 5xx under burst |
| `GET /api/properties/:id` | p95 < 150 ms |

Run it against `priceValue` + the new composite index and record the numbers in this file. If
`GET /api/properties` misses the budget, the read replica is the next lever, not more app instances.

### Docs
- `runbook.md` completed: deploy, rollback, secret rotation, incident triage, the single-replica
  constraint and its S3 exit path.
- ADRs closed: 0003 after M07, 0004 (typecheck ratchet) after this milestone.

## Definition of done

- [ ] `pnpm lint` runs and passes, with the boundary rules enabled
- [ ] A cross-module internal import fails lint
- [ ] `npx tsc --noEmit` is clean and blocking
- [ ] `docker compose up` brings up MySQL + API + worker
- [ ] Migrations run as a `release` step, never on boot
- [ ] CI green on a clean clone
- [ ] k6 results recorded, meeting the p95 budget or the shortfall documented
- [ ] `runbook.md` complete
