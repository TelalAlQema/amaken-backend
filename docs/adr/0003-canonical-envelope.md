# ADR 0003 — Canonical `items` envelope, legacy key dual-emitted

- **Status:** Closed — implemented in M07
- **Date:** 2026-09-29

## Context

The backend emits a different list shape per service:

| Service | Emits | Consumers expecting it |
|---|---|---|
| `property.service.js:226` | `{ properties, pagination }` | ✅ correct — matches frontend |
| `admin.service.js:296` | `{ users, pagination }` | ❌ frontend reads `data.items` |
| `admin.service.js:453` | `{ accounts, pagination }` | ❌ frontend reads `data` as array + top-level `pagination` |
| `lead.service.js:49` | `{ leads, pagination }` | ❌ frontend reads `data.items` or `data[]` |
| `feedback.service.js:79` | `{ feedbacks, pagination }` | ❌ frontend reads `data` as array |
| `contact.service.js:32` | `{ contacts, pagination }` | ❌ frontend reads `data.items` or `data[]` |

The frontend meanwhile has **three mutually exclusive conventions** for reading a list:
`data.properties` + `data.pagination` (`propertyApi.ts:4-17`), `data.items` + `data.pagination`
(`app/admin/users/page.tsx:130-131`), and `data` as an array + top-level `pagination`
(`app/admin/accounts/registered/page.tsx:71-72`).

Net effect: the admin users, agents, builders, accounts, leads, contacts, admin-properties,
approval and all feedback list pages **currently render empty**. This is pre-existing breakage, not
a contract to preserve.

Adding a tenth convention would be indefensible. But changing the envelope alone would break the
pages that *do* work.

## Decision

**Canonical paginated envelope:**

```json
{ "success": true, "data": { "items": [ ... ], "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } } }
```

**Migration, in M07, in two steps:**

1. `paginated()` in `core/http` emits `items` **and** the legacy named key
   (`properties`, `users`, `leads`, …) under a single flag, `ENVELOPE_LEGACY_KEY` (default `true`).
   Behaviour change in the backend only, additive — no frontend edit, nothing breaks.
2. The frontend's three reader conventions collapse onto `items`. In the same release, the flag
   flips to `false` and the legacy keys are deleted from the codebase.

Single flag, single release to remove. Both steps are individually revertible.

## Consequences

**Gains**

- One list shape, documented once in [`architecture/envelope.md`](../architecture/envelope.md).
- `paginated()` replaces the block that is copy-pasted 13 times across the services.
- The six broken admin list pages get fixed as a side effect, not as separate bug work.

**Costs**

- For one release, paginated responses carry a redundant alias. That is the price of a zero-downtime
  fix. Accept it deliberately, and delete it on schedule.
- The two steps land in different repositories, so release discipline is required. Tracked as a
  milestone gate in [`milestones/M07-contract-consolidation.md`](../milestones/M07-contract-consolidation.md).

**Not decided here**

- The `GET /properties/:id` detail response stays a bare object under `data`, *not* wrapped in
  `items`. Six frontend call sites unwrap it directly.
- The two non-envelope responses stay non-envelope: `GET /admin/leads/export` (raw BOM-prefixed TSV,
  consumed as a `Blob`) and `/health` (unwrapped, consumed by probes and Playwright).

**Rejected**

| Option | Why not |
|---|---|
| Keep `{ key, pagination }`, fix the frontend to match | Leaves the shape non-uniform; every new service picks a name. |
| `items` only, no alias | No zero-downtime path; backend and frontend must deploy atomically. |
| Per-endpoint array vs object (pick one convention, drop the other) | Same problem, and it forces an immediate coordinated release. |

## Closure

M07 removed the legacy named-key alias, migrated backend services and frontend list
consumers to `data.items`, and added the OpenAPI document at `/api/docs`. The canonical
envelope is now the only paginated list contract.
