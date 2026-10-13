# Module contract

How a module is shaped, what it exposes, and what it may import. If you are adding a module or
changing one, this is the file to read.

## File layout

```
src/modules/<name>/
├── index.js          # the ONLY public surface. Everything else is private.
├── <name>.routes.js  # HTTP: parse, validate, delegate, respond
├── <name>.service.js # domain logic, transactions
├── <name>.repository.js  # the only file in this module that touches prisma
├── <name>.schema.js  # zod schemas
├── <name>.policy.js  # authorization: who may do what
├── <name>.mapper.js  # entity → wire shape
└── <name>.constants.js
```

Every file is optional except `index.js`. A module with no persistence needs no repository. A
read-only module needs no policy.

## The manifest

`index.js` exports a manifest. `src/bootstrap/registerModules.js` collects them;
`src/app.js` mounts them.

```js
const { Router } = require("express");
const { authenticate, requireRole } = require("../../core/auth");

const publicRouter = Router();
// ...
const adminRouter = Router();
// ...

module.exports = {
  name: "properties",
  mounts: [
    { path: "/api/properties", router: publicRouter, guards: [] },
    {
      path: "/api/admin/properties",
      router: adminRouter,
      guards: [authenticate, requireRole("admin")],
    },
  ],
};
```

### Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Module name. Used in logs, error messages, and lint boundary rules. |
| `mounts` | yes | Array of `{ path, router, guards }`. |
| `mounts[].path` | yes | Full mount path, **including the `/api` prefix**. |
| `mounts[].router` | yes | An Express `Router`. |
| `mounts[].guards` | yes | Middleware applied to the whole router. `[]` for public. Use this rather than repeating `authenticate, requireRole(...)` on every route. |

### Rules for paths

1. **Every path is explicit and absolute.** No module composes its prefix from another module's
   mount. `POST /api/properties/:id/lead` is declared by the leads module under its own manifest.
2. **Every admin path lives under `/api/admin/`.** The frontend selects the admin token with a
   literal `url.startsWith("/admin")` test (`frontend/lib/redux/api/baseApi.ts:13`). An admin
   endpoint outside that prefix silently receives the *user* token. M06 places admin feedback at
   `/api/admin/feedback/company` and `/api/admin/feedback/agents`.
3. **Path stability is a promise.** Changing a mount path is a breaking API change. Additive routes
   are fine; renames need an ADR.

## Layering

```
routes → service → repository → platform → core
```

| Layer | Responsibility | Must not |
|---|---|---|
| `*.routes.js` | read `req`, validate, call the service, shape the response | import prisma, hold business logic, write `res.json` directly, use `try/catch` |
| `*.service.js` | business rules, transactions, orchestration | touch `req`/`res`, import prisma, import another module's internals |
| `*.repository.js` | prisma queries for this module's data | hold business rules |
| `*.policy.js` | "may this actor do this?" | mutate state |
| `*.mapper.js` | entity → wire shape | query the database |

### `asyncHandler`

Routes never write `try/catch`. Wrap instead:

```js
const { asyncHandler } = require("../../core/http/asyncHandler");

router.get(
  "/:id",
  authenticate,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const property = await propertyService.getById(Number(req.params.id));
    res.ok(property);
  })
);
```

This removes the `try/catch → next(err)` block currently repeated in ~70 handlers. The wrapper is
already in place and tested; the call sites convert as each module is migrated.

### Responses

Routes never write `res.json`. Use `core/http/response.js` — see [envelope.md](envelope.md):

```js
res.ok(data);                    // 200 { success, data }
res.created(data);               // 201 { success, data }
res.paginated({ items, pagination });
res.noContent();
```

`envelope()` installs these on `res` in `src/app.js`, so nothing needs wiring per module.

## Cross-module imports

**A module imports another module only through its `index.js`.**

```js
// legal
const { mounts } = require("../../users");

// illegal — reaches into internals
const userService = require("../../users/user.service");
```

`index.js` may also export a small set of named capabilities for legitimate cross-module calls:

```js
module.exports = {
  name: "users",
  mounts: [ /* ... */ ],
  // explicit, narrow capability for other modules to call
  userService: { findById, findByEmail },
};
```

Keep that surface small. Every entry is a dependency edge you now own.

### Legal dependency directions

A module may depend on `core/*` and `platform/*` freely, and on **other modules' `index.js`**.

| Module | May depend on | Must not |
|---|---|---|
| `auth` | `platform/mail`, `platform/db`, `core/*` | — |
| `users` | `auth`, `platform/storage`, `core/*` | — |
| `admins` | `auth`, `users`, `accounts`, `core/*` | — |
| `properties` | `users` (owner lookup), `leads` (cascade delete), `core/*` | — |
| `leads` | `properties` (read-only), `platform/queue` | — |
| `feedback` | `users`, `admins`, `core/*` | — |
| `dashboard` | every module's read capability, `platform/cache` | nothing writes through it |
| `contacts`, `cms`, `locations`, `accounts` | `core/*`, `platform/*` | — |

`core/` and `platform/` may never import a module. That rule is what keeps them reusable.

### Cycles

`leads → properties → leads` is a cycle at the data level (`property.service` deletes
`propertyLead`; `lead.service` reads `property`). Break it in the **service**, not the import graph:

- `properties.service` calls `leads.repository` directly (a cascade delete is a data operation, not
  a domain call).
- `leads.service` reads `properties.repository` directly.

If two services genuinely need to call each other, one of them is doing the wrong job. Extract the
shared piece into a third module.

## Data access

One `PrismaClient` for the process ([ADR 0002](../adr/0002-single-prisma-client-split-schema.md)).
A module **may** write another module's table — `admin` writes `property` and `delAccount` today,
and `user` writes `property`. That is allowed. What is not allowed is importing another module's
*code* to do it.

Make cross-module writes explicit and commented so review catches them:

```js
// Cross-module write: deleting a user cascades to their properties.
// Legal under ADR 0002 (single client, shared schema) but must be intentional.
await prisma.property.updateMany({ where: { uid: id }, data: { deactivate: 1 } });
```

## Registering a module

1. Create `src/modules/<name>/`.
2. Export a manifest from `index.js`.
3. Add one line to the registry in `src/bootstrap/registerModules.js`.
4. Nothing else. `app.js` picks it up.

No wiring in `app.js`, no import in `index.js`, no mount list to keep in sync.

## Testing a module

A module's tests import `createApp` and hit real HTTP. They never import a service directly. Since
M01 this is the same factory production boots — there is no test-only mirror of the middleware
chain any more.

```js
const { useTestDatabase } = require("../helpers/env");
useTestDatabase();                    // before anything reads config

const { createApp } = require("../../src/app");

test("GET /api/properties returns a paginated envelope", async () => {
  const res = await request(createApp()).get("/api/properties").expect(200);
  assert.ok(res.body.success);
  assert.ok(Array.isArray(res.body.data.items));
});
```

Testing through HTTP is deliberate: it verifies the manifest, the guards, the validators and the
mapper together. A service-level test would miss a route that was never mounted.

`test/helpers/app.js` exposes `getApp()` (a cached instance), `resetDatabase()`, `closeDatabase()`
and `prisma` for the DB reset. `createApp()` binds no port, which is the whole point — the test
process never listens.

## Checklist for a new module

- [ ] `index.js` exports `{ name, mounts }`
- [ ] Every path is absolute and explicit; admin paths under `/api/admin/`
- [ ] Routes use `asyncHandler`, `validate*`, and `res.ok` / `res.paginated`
- [ ] No `require` of prisma in `*.routes.js`
- [ ] No `try/catch` in `*.routes.js`
- [ ] All prisma access is in `*.repository.js`
- [ ] Business rules live in `*.service.js`, not the route
- [ ] Cross-module imports go through `index.js`
- [ ] Registered in `src/bootstrap/registerModules.js`
- [ ] Contract test in `test/modules/`
- [ ] OpenAPI description added (M07 onward)
