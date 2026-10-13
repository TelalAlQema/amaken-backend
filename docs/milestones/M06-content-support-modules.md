# M06 — Content and support modules

- **Status:** implementation complete; database-backed verification pending
- **Depends on:** M05
- **Blocks:** M07

## Goal

The remaining five modules. Mechanical once M03-M05 set the template. Two route-placement bugs get
fixed here for free.

## Modules

```
src/modules/cms/          # about + team
src/modules/locations/    # state + city
src/modules/feedback/
src/modules/contacts/
src/modules/dashboard/    # read-model
```

## Route placement fixes

### `/api/admin/feedback/*` — 404s today
The frontend calls `/api/admin/feedback/company` and `/api/admin/feedback/agents`
(`lib/redux/api/adminApi.ts:242,246`). The backend mounts them at `/api/feedback/admin/company` and
`/api/feedback/admin/agents` (`feedback.routes.js:129,146`). **Both admin pages are 404.**

Moving them to `/api/admin/feedback/*` fixes two things at once:
1. The 404.
2. The frontend's admin-token selection, which is a literal `url.startsWith("/admin")` test
   (`baseApi.ts:13`). `/feedback/admin/...` fails that test, so the **user** token is sent to an
   admin endpoint. It only worked because nothing reached it.

### Admin contacts
M05 extracted admin contact CRUD to `routes/admin-contact.routes.js`, but it still sat outside its
domain. This milestone moves both public submissions and admin CRUD into `modules/contacts`.

## Work items

### cms
`aboutSchema` (`cms.routes.js:47`) and `teamSchema` (`:124`) are **defined and never passed to
`validateBody`**. Create and update run unvalidated. Wire them up, or delete them — do not leave a
schema that lies about validating.

### locations
`stateIdParam` (`:63`) and `cityIdParam` (`:128`) are identical zod objects declared twice. One
shared `idParam` in the module. Six routes repeat `authenticate, requireRole("admin")`
inline — the module manifest's `guards` field does this once.

### feedback
- `GET /api/feedback/:id` is unauthenticated (fixed in M00; keep the regression test).
- `feedback.service.js:7,11,12` runs three sequential single-row lookups before insert, and the
  `admin` / `receiverUser` checks at `:11-12` are mutually exclusive probes of the same email. One
  query.
- Write a `feedback.mapper.js`. The frontend expects `{ id, send_email, receive_email, rating,
  description, status, created_at }` while the DB uses `fid` / `fdescription` and the shared type
  uses the DB names. This is where the three-way drift is resolved.

### dashboard
A read-model, not a domain. Keep it that way.
- `dashboard.service.js:24-42` fires 17 concurrent `count()` calls and `:107-126` fires 18 more —
  35 round trips per dashboard load.
- `getChartData:72-78` uses three sequential awaits where `Promise.all` would do.
- Batch the queries, then cache in the in-process tier with a short TTL. Invalidate on the relevant
  module's write. **Not** Redis: there is none, and [M02](../milestones/M02-scale-infrastructure.md)
  put only the `otp` namespace in the durable tier. A dashboard aggregate is a dashboard-shaped
  answer — replica-local and stale by at most `CACHE_TTL_SECONDS` is an acceptable property for it,
  which is precisely why it did not earn a durable write.
- The frontend reads flat counters (`availableProperties`, `soldOutProperties`, …) and a **different
  naming set** on the graphs page (`available`, `sold`, `stats.sold`). Resolve in `M07`, not here.

## Deletions

```bash
git rm src/routes/cms.routes.js src/routes/location.routes.js src/routes/feedback.routes.js
git rm src/routes/contact.routes.js src/routes/dashboard.routes.js
git rm src/services/{about,team,location,feedback,contact,dashboard}.service.js
```

## Verification

```bash
node --test test/modules/
node --test test/                    # baseline green
curl -H "Authorization: Bearer $ADMIN" localhost:5000/api/admin/feedback/company   # 200, not 404
```

## Definition of done

- [x] `/api/admin/feedback/company` and `/agents` have admin guarded routes and integration coverage
- [x] CMS schemas are wired to request validators
- [x] Dashboard counts use one SQL statement per cached read model, not 35 count round trips
- [x] Feedback mapper resolves the `fid`/`id` drift
- [ ] M00 baseline green throughout

**Verification note:** `pnpm check` is the available source-only check. The configured MySQL
connection still fails with `Unknown authentication plugin 'sha256_password'`, so the integration
and baseline suites could not be executed in this workspace.
