# ADR 0001 — Modular monolith over microservices

- **Status:** Accepted
- **Date:** 2026-09-29
- **Deciders:** Backend team

## Context

The API is a single Express process: 12 route files, 14 service files, ~5,200 lines, one MySQL
database. It has outgrown its structure but not its scale. Three forces are pushing at once:

1. **Correctness.** Cross-domain coupling has grown in the data layer, not the import graph.
   `admin.service` reaches into `property`, `feedback`, `delAccount` and `registerEmail` while
   administering a user. `user.service` writes `prisma.property`. `property.service` deletes
   `prisma.propertyLead`; `lead.service` reads `prisma.property`. Five models are mutually
   entangled, and there are **zero tests** to catch a mistake.
2. **Operability.** The app boots without a real config (`dotenv.config()` runs *after* the
   `require` graph loads, so `jwt.service` always sees an empty `process.env` and falls back to a
   committed secret). There is no readiness probe, no graceful drain, no request correlation, and
   in-memory rate limiting that resets on every deploy.
3. **Scale ceiling.** `public/uploads` is on local disk, so the system is structurally single-replica.
   The queue, the cache and the durable credential store all live in MySQL ([M02](../milestones/M02-scale-infrastructure.md)),
   so they add no shared infrastructure — but the in-memory rate limiter is still per-replica.

Microservices do not fix any of these three. Splitting a system with entangled data models and no
tests produces distributed transactions and faster outages.

## Decision

**Stay a monolith. Restructure it as a modular monolith.**

The process stays one deployable unit talking to one database, but the code is split into bounded
contexts with enforced boundaries:

- `src/modules/<domain>/` — each owns its routes, service, repository, validation schema, and policy.
- `src/core/` — framework-agnostic primitives. Knows nothing about any module.
- `src/platform/` — infrastructure adapters. The only code permitted to touch MySQL, SMTP, disk, and
  the queue/cache tables.
- `src/shared/` — pure functions with no I/O.

Each module publishes exactly one entry point, its `index.js`, exporting a manifest declaring its
mount paths and guards. `src/app.js` iterates the registry and mounts them.

### Dependency direction, enforced by lint

```
routes → service → repository → platform → core
```

- Routes never touch Prisma.
- Services never touch `req` / `res`.
- Modules never import another module's internals — only its `index.js`.
- Nothing in `core/` or `platform/` imports a module.

### Consequences

**Accepted costs**

- We do not get independent deployment or per-module scaling from this work. We get the *option*.
- Enforcing boundaries needs a working ESLint, which does not exist today. Fixed in M08.
- 9 modules must be migrated. The template is proven once, on `auth`, in M03.

**Gains**

- Every module is independently testable and independently extractable.
- A module that outgrows the monolith lifts out with its `platform/` ports re-pointed, and the rest
  is unaffected — that is the exit door, and it only exists if the boundaries are real.
- Cross-domain changes become findable: "who writes `prisma.propertyLead`?" has exactly one answer.

**Rejected alternatives**

| Option | Why not |
|---|---|
| Microservices now | Distributed transactions across 5 entangled models, no tests to catch it. Strictly worse. |
| Layered (`routes/ services/ repositories/`) | Preserves the cross-domain entanglement that is the actual problem. A layer is a horizontal cut; the problem is vertical. |
| Folder reshuffle, no contract | Moves files without enforcing anything; the next three features will re-couple them. |
| TypeScript migration first | A large separate project. M00/M01 deliver more risk reduction per hour. Revisit after M02 if the team wants it — see the typecheck ratchet in
[M01](../milestones/M01-core-kernel.md). |

## Revisit when

- `modules/properties` is a sustained hotspot and needs independent scaling → extract it.
- A second bounded context genuinely needs a different release cadence → extract it.
- The team grows past ~8 engineers and cross-module PRs become the bottleneck.
