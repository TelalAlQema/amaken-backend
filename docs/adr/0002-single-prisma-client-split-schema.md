# ADR 0002 — One Prisma client, schema split by module

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

A modular-monolith refactor invites splitting the data layer per module, the way a microservice
design would. This codebase cannot afford that. The model graph is entangled by design:

- `admin.service` writes `property`, `feedback`, `delAccount`, `registerEmail` while administering a
  user.
- `user.service` writes `prisma.property` (on delete/block).
- `property.service` deletes `prisma.propertyLead`.
- `lead.service` reads `prisma.property`.
- `property.adminapproval`, `property.adminblock`, `property.uid` and `property.aemail` are foreign
  keys into `User` and `Admin` written by three different modules.

Several of these writes are already wrapped in `prisma.$transaction` (`admin.service.js:334-360`,
`416-437`).

## Decision

**One `PrismaClient` for the whole process. Split the schema file by module, not the client.**

- `prisma/schema.prisma` keeps the `generator`, `datasource`, and anything global.
- Models move to `prisma/models/<domain>.prisma`. Prisma merges multiple files in the schema
  directory, so `prisma generate` and `prisma migrate` are unaffected.
- Any `$transaction` may span modules.

## Consequences

**Gains**

- Cross-module writes stay atomic. `prisma.$transaction` spanning `users` and `properties` keeps
  working, which is what the existing admin flows need.
- One connection pool, one query engine, one set of credentials, one place to tune `DATABASE_URL`.
- No distributed transaction, no dual-write, no reconciliation job.

**Costs**

- The database is a shared kernel, so a module **cannot** be extracted with its data. Extraction
  later requires a data split. Accepted for now; noted as the cost of not being premature.
- Nothing stops a module from querying another module's tables. The boundary lint rule limits
  *imports* to the module's public surface, but table access is enforced by review, not tooling.
  Mitigated by M05's `VisibilityPolicy` extraction and the repository-per-module convention.

**Rejected**

| Option | Why not |
|---|---|
| Prisma client per module (separate schemas) | Breaks every cross-module `$transaction`. Would force dual-writes and reconciliation. |
| Separate databases per module | Same problem, plus joins become API calls across the network. |
| One monolithic `schema.prisma` forever | Acceptable fallback, but a 307-line file will not stay navigable as it grows. Splitting is free with Prisma, so do it. |

## Revisit when

A module is being extracted from the monolith and needs to own its data — see
[ADR 0001](0001-modular-monolith.md).
