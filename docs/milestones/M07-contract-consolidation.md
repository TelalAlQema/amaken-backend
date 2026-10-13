# M07 — Contract consolidation + OpenAPI

- **Status:** complete
- **Depends on:** M06
- **Blocks:** M08 (CI runs the contract test)

## Goal

Collapse the three competing list conventions into one, and make the API self-describing. This is
the only milestone that touches `frontend/`.

Governed by [ADR 0003](../adr/0003-canonical-envelope.md).

## Canonical shape

```json
{ "success": true, "data": { "items": [ ... ], "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } } }
```

## Two steps, one release

### Step 1 — backend

`core/http/response.js` provides `paginated()`:

```js
paginated(res, { items, pagination })
```

It emits only `items` and `pagination`. Services return `{ items, pagination }` and list
routes use this helper.

**Gate:** contract tests assert the canonical shape, and backend/frontend changes ship together.

### Step 2 — frontend

1. `lib/redux/api/propertyApi.ts` — `normalizeList` reads `items`.
2. `app/admin/{users,users/agents,users/builders}/page.tsx` — read `data.items`.
3. `app/admin/accounts/{registered,deleted,blocked}/page.tsx` — read `data.items` (currently reads
   `data` as an array + **top-level** `pagination`).
4. `app/admin/{leads,contacts}/page.tsx` — read `data.items` directly.
5. `app/admin/properties/page.tsx`, `properties/approval/page.tsx` — read `data.items`.
6. All feedback list pages — read `data.items`.
7. Ship the canonical reader and close ADR 0003.

## What must NOT change

| Contract | Why | Read at |
|---|---|---|
| `POST /auth/refresh` stays one shared endpoint for user and admin | The backend dispatches on the `role` claim. Splitting it breaks both reauth chains. | `baseApi.ts:38-52` |
| `data.accessToken` / `data.refreshToken` on every auth mutation | | `AuthProvider.tsx:39-40` |
| **401** exactly, for the reauth chain to fire | 403 or 419 silently never triggers a refresh. | `baseApi.ts:78` |
| `error: { message, code? }` | | `AuthProvider.tsx:45` |
| `data.image` is a **bare filename**, not a path | The frontend re-prefixes it. | `profile/picture/page.tsx:54` |
| `GET /admin/leads/export` → raw BOM-prefixed TSV | Consumed as a `Blob`. | `adminApi.ts:210` |
| `GET /properties/:id` → bare object under `data`, **not** wrapped in `items` | Six call sites unwrap it directly. | `properties/detail/page.tsx:31` |
| `/api` prefix, and `/uploads/**` at the API host root | `getAssetUrl` strips `/api` off `NEXT_PUBLIC_API_URL` to build asset URLs. | `lib/utils.ts:8,19` |
| Every admin path under `/api/admin/*` | `url.startsWith("/admin")` selects the admin token. | `baseApi.ts:13` |

## OpenAPI

`GET /api` advertises `docs: "/api/docs"`. `/api/docs` serves OpenAPI 3.1 generated with
`@asteasolutions/zod-to-openapi`, the registered module route table, and shared Zod schemas.

## Definition of done

- [x] Every paginated endpoint emits `items` + `pagination`
- [x] Frontend list pages read `items`; defensive dual-shape readers removed
- [x] Legacy-key flag and branch deleted
- [x] ADR 0003 closed
- [x] `/api/docs` serves an OpenAPI 3.1 document for API, module, and operational routes
- [x] `GET /properties/:id` and `/admin/leads/export` unchanged
- [x] `npx tsc --noEmit` clean in `frontend/`
