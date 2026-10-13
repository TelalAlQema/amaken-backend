# API contract

**Status: active contract.** Paginated endpoints use `data.items` and `data.pagination`.

After freezing, any change to this document is a breaking change and requires an ADR. This file is
the specification that `test/` pins and that the contract tests assert against.

Base path: `/api`. Static uploads: `/uploads` at the API host root. Health: `/health`. Metrics:
`/metrics`. 101 routes, pinned by `test/contract/route-parity.test.js`.

> `getAssetUrl` builds asset URLs by stripping a trailing `/api` off `NEXT_PUBLIC_API_URL`
> (`frontend/lib/utils.ts:8`). **Do not change the `/api` prefix or move `/uploads`.**

## Operational (outside `/api`, not enveloped)

| Method | Path | Shape | Notes |
|---|---|---|---|
| GET | `/health` | `{ status, timestamp }` | Checks nothing. Playwright waits on it (`playwright.config.ts:28`) |
| GET | `/metrics` | Prometheus text | Added in [M01](milestones/M01-core-kernel.md). Unauthenticated. `amaken_api_up`, `…_http_request_duration_seconds`, `…_http_requests_total`, `…_http_errors_total`. Disabled with `METRICS_ENABLED=false` |
| GET | `/api` | `{ message, version, docs }` | Service discovery. Not enveloped |
| GET | `/api/docs` | OpenAPI 3.1 JSON | Generated from the registered route table and Zod schemas |

## Public

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | |
| POST | `/api/auth/verify-email` | |
| POST | `/api/auth/verify-otp` | |
| POST | `/api/auth/login` | → `data.accessToken`, `data.refreshToken`, `data.user` |
| POST | `/api/auth/forgot-password` | |
| POST | `/api/auth/verify-forgot-otp` | |
| POST | `/api/auth/reset-password` | |
| POST | `/api/auth/refresh` | **shared by user and admin**, dispatches on the `role` claim |
| POST | `/api/auth/logout` | declared in the frontend, no consumer |
| GET | `/api/properties` | filtered, paginated |
| GET | `/api/properties/state/:stateSlug` | paginated |
| GET | `/api/properties/:id` | **bare object under `data`**, not a list envelope |
| POST | `/api/properties/:id/lead` | property enquiry |
| GET | `/api/about` | |
| GET | `/api/team` | |
| GET | `/api/cities` | |
| GET | `/api/states` | |
| POST | `/api/contact` | → 201 |
| GET | `/api/users/:id` | *intended public; auth-gated today by a router-wide `authenticate` — [M00.5](milestones/M00-safety-net.md) corrects this* |

## User (Bearer `access_token`, `requireRole("user")`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/users/me` | |
| PUT | `/api/users/me` | |
| POST | `/api/users/me/avatar` | multipart; client sends field `avatar` |
| DELETE | `/api/users/me/avatar` | |
| POST | `/api/users/me/logo` | multipart; client sends field `logo` |
| DELETE | `/api/users/me/logo` | |
| PUT | `/api/users/me/password` | |
| PUT | `/api/users/me/links` | |
| POST | `/api/users/me/deactivate` | |
| POST | `/api/users/me/activate` | |
| DELETE | `/api/users/me` | |
| POST | `/api/users/block/:id` | *takes `:id` from the path with no ownership check — [M00.6](milestones/M00-safety-net.md) corrects this* |
| POST | `/api/users/unblock/:id` | same |
| GET | `/api/properties/my` | paginated, **no visibility filter today** |
| POST | `/api/properties` | multipart, 8 named file fields |
| PUT | `/api/properties/:id` | multipart, ownership-checked |
| DELETE | `/api/properties/:id` | ownership-checked |
| GET | `/api/feedback/my` | |
| GET | `/api/feedback/about-me` | |
| GET | `/api/feedback/:id` | **unauthenticated today** — [M00.5](milestones/M00-safety-net.md) requires auth |
| POST | `/api/feedback` | |
| PUT | `/api/feedback/:id` | ownership-checked |
| DELETE | `/api/feedback/:id` | |

## Admin (Bearer `admin_access_token`)

Pre-auth: `POST /api/admin/pin`, `POST /api/admin/login`. Everything below is behind
`authenticate, requireRole("admin")`.

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/admin/profile` | |
| POST/DELETE | `/api/admin/profile/avatar` | client sends field `avatar` |
| POST/DELETE | `/api/admin/profile/logo` | client sends field `logo` |
| PUT | `/api/admin/profile/links` | |
| PUT | `/api/admin/profile/password` | |
| GET | `/api/admin/users` | `utype=User` |
| GET | `/api/admin/users/agents` | `utype=Agent` |
| GET | `/api/admin/users/builders` | `utype=Builder` |
| GET | `/api/admin/users/admins` | |
| PUT | `/api/admin/users/:id/status` | dispatches on a 4-way `action` switch **in the route** (`admin.routes.js:301-314`) |
| DELETE | `/api/admin/users/:id` | |
| GET | `/api/admin/accounts/registered` | |
| GET | `/api/admin/accounts/deleted` | |
| GET | `/api/admin/accounts/blocked` | |
| DELETE | `/api/admin/accounts/:id` | |
| GET | `/api/admin/properties` | paginated |
| GET | `/api/admin/properties/approval` | paginated |
| PUT | `/api/admin/properties/:id/approve` | |
| PUT | `/api/admin/properties/:id/disapprove` | byte-identical to `hide` |
| PUT | `/api/admin/properties/:id/hide` | |
| PUT | `/api/admin/properties/:id/display` | byte-identical to `approve` |
| PUT | `/api/admin/properties/:id/freeze` | |
| PUT | `/api/admin/properties/:id/release` | |
| DELETE | `/api/admin/properties/:id` | **bypasses the ownership guard** by design |
| GET | `/api/admin/leads` | paginated |
| GET | `/api/admin/leads/export` | **raw BOM-prefixed TSV**, not an envelope |
| DELETE | `/api/admin/leads/:id` | |
| POST | `/api/admin/leads/bulk-delete` | |
| POST | `/api/admin/leads/delete-all` | no body validation |
| GET | `/api/admin/contacts` | paginated contact submissions |
| DELETE | `/api/admin/contacts/:id` | |
| GET | `/api/admin/stats` | flat counters, no pagination |
| GET | `/api/admin/charts` | |
| GET | `/api/admin/sidebar-counts` | |
| GET | `/api/admin/feedback/company` | mapped to `id` and `description` |
| GET | `/api/admin/feedback/agents` | mapped to `id` and `description` |
| POST/PUT/DELETE | `/api/admin/about[/:id]` | multipart |
| POST/PUT/DELETE | `/api/admin/team[/:id]` | multipart |
| POST/PUT/DELETE | `/api/admin/states[/:id]` | |
| POST/PUT/DELETE | `/api/admin/cities[/:id]` | |

## Known divergences

All rows below are pinned by an executable assertion in `test/contract/`, so they
fail loudly the moment the behaviour changes. A test whose name starts `BUG:`,
`SECURITY:`, `DIVERGENCE:` or `FIXME` asserts the **current, wrong** behaviour on
purpose; M00 flips it.

### Backend endpoints that are outright broken

| Endpoint | Symptom | Cause | Fix |
|---|---|---|---|
| `GET /api/properties/:id` | leaks lead PII | `include: { leads: true }` with no auth guard (`property.service.js:255`) | M00.5 |
| `GET /api/feedback/:id` | unauthenticated | route has no `authenticate` (`feedback.routes.js:71`) | M00.5 |
| `POST /api/admin/login` | PIN gate is client-side only | `adminLogin` (`admin.service.js:39`) never checks that the PIN step happened, and nothing records that it did — a direct API call skips the PIN entirely | M00.6 |
| `POST /api/users/block/:id` | IDOR | path `:id` is passed straight to `blockSelf` with no `req.user.id` check (`user.routes.js:227`) — any user can block any account | M00.6 |
| `DELETE /api/users/me` | no audit trail | hard-deletes the row; writes no `DelAccount` ledger, unlike the admin delete path — the address is immediately re-registerable (`user.service.js:290`) | M00.6 |

### Frontend calls an endpoint the backend does not have

| Frontend calls | Backend actually serves | Source |
|---|---|---|
| `GET /api/admin/dashboard/stats` | `GET /api/admin/stats` | `adminApi.ts:250` |
| `GET /api/admin/dashboard/charts` | `GET /api/admin/charts` | `adminApi.ts:254` |
| `GET /api/admin/dashboard/sidebar-counts` | `GET /api/admin/sidebar-counts` | `adminApi.ts:257` |

All five `/api/admin/dashboard/*` requests 404, which is why every admin dashboard
panel is blank. The comments at `dashboard.routes.js:12,25,46` assert the
`/dashboard` prefix, but `routes/index.js:44` mounts that router at `/admin` and
the inner paths are `/stats`, `/charts`, `/sidebar-counts`. The comments are the
stale artefact, not the mount — the frontend is the side to bring into line, via
an alias so neither caller breaks. M00.10.

M06 moved admin feedback to the frontend's `/api/admin/feedback/*` path, so token
selection now chooses the admin token as intended.

### Canonical list envelope

All paginated endpoints return `data.items` and `data.pagination`. The generated
OpenAPI 3.1 document is served at `GET /api/docs`.

Feedback rows map database `fid`/`fdescription` to frontend `id`/`description` in
`modules/feedback/feedback.mapper.js`.

## Invariants the frontend depends on

| Invariant | Read at |
|---|---|
| `POST /auth/refresh` is one endpoint for both roles | `baseApi.ts:38-52` |
| Auth mutations return `data.accessToken` / `data.refreshToken` | `AuthProvider.tsx:39-40` |
| Expired credentials return **exactly 401** | `baseApi.ts:78` |
| Errors are `{ error: { message, code? } }` | `AuthProvider.tsx:45` |
| Uploads return `data.image` as a **bare filename** | `profile/picture/page.tsx:54` |
| Admin endpoints are selected by a literal `/admin` URL prefix | `baseApi.ts:13` |
| `GET /admin/leads/export` is a `Blob`, not JSON | `adminApi.ts:210` |
| `GET /properties/:id` unwraps to a bare object | `properties/detail/page.tsx:31` |
| `/api` prefix is strippable for asset URLs | `lib/utils.ts:8` |
| `/uploads/**` is served at the API host root | `lib/utils.ts:19` |
| Every response carries an `X-Request-Id` header | new in M01 — safe to ignore, useful in a bug report |
