# Amaken API — Documentation

Backend documentation for `@amaken/api` (Express + Prisma + MySQL, plain CommonJS JavaScript).

## Where to start

| If you want to… | Read |
|---|---|
| Understand the system | [`architecture/overview.md`](architecture/overview.md) |
| Add or change a module | [`architecture/module-contract.md`](architecture/module-contract.md) |
| Know the response shape | [`architecture/envelope.md`](architecture/envelope.md) |
| Know what the API promises | [`api-contract.md`](api-contract.md) |
| Deploy / operate it | [`runbook.md`](runbook.md) |
| See why we made a call | [`adr/`](adr/) |
| See the current work | [`milestones/`](milestones/) |

## Layout

```
docs/
├── README.md
├── architecture/     # how the system is put together
├── adr/              # architecture decision records — why, not what
├── milestones/       # implementation plan + the exact commands run
├── runbook.md        # operational procedures
└── api-contract.md   # the frozen HTTP contract
```

## Ground rules

- `docs/api-contract.md` is **frozen** from the end of M00. Any change to it is a breaking change and needs an ADR.
- Every milestone file records the commands actually run, in order, with verification output. If a command is not recorded, it did not happen.
- The backend is **plain CommonJS JavaScript with no build step**. `src/` is what runs. Do not introduce a transpiler.
- The root git repo is the working repo. Commit from the repository root, never from inside `backend/`.

## Milestone status

| ID | Scope | Status |
|---|---|---|
| M00 | Safety net + P0 security | in progress |
| M01 | Core kernel + `app.js`/`server.js` split | **done** |
| M02 | Scale infrastructure (MySQL queue + durable cache, probes, drain, metrics) | **done** — no Redis: MySQL-backed throughout |
| M03 | `modules/auth` — the reference module | code complete — DB verification blocked |
| M04 | `modules/users` + `modules/admins` + `modules/accounts` | pending |
| M05 | `modules/properties` + `modules/leads` + price migration | pending |
| M06 | `modules/cms` + `locations` + `feedback` + `contacts` + `dashboard` | pending |
| M07 | Contract consolidation + OpenAPI | pending |
| M08 | Delivery + ops (Docker, CI, load tests) | pending |

Order is strict: M00 → M01 → M02 → M03 → M04 → M05 → M06 → M07 → M08.
