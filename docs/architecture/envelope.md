# Response envelope

Every endpoint returns `ApiResponse<T>`. Governed by
[ADR 0003](../adr/0003-canonical-envelope.md).

## Success

```json
{ "success": true, "data": { } }
```

## Paginated

```json
{
  "success": true,
  "data": {
    "items": [ { } ],
    "pagination": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
  }
}
```

## Created

```json
{ "success": true, "data": { } }
```

with HTTP `201`.

## Error

```json
{ "success": false, "error": { "message": "Property not found", "code": "NOT_FOUND" } }
```

`code` is optional but should always be present in production. The frontend reads
`error.message` at `AuthProvider.tsx:45` and `login/page.tsx:35` — the message is part of the
contract; the `code` is for clients that want to branch.

## No content

`204`, no body. Used by the `DELETE /users/me/avatar` and `.../logo` endpoints.

## Non-envelope responses

Four, deliberately. Do not wrap them.

| Endpoint | Shape | Consumed by |
|---|---|---|
| `GET /api/admin/leads/export` | raw text, UTF-8 BOM prefix (`\xEF\xBB\xBF`) + tab-separated rows | frontend as a `Blob` (`lib/redux/api/adminApi.ts:210`) |
| `GET /health*` | `{ status, ... }`, no envelope | probes, Playwright (`playwright.config.ts:28`) |
| `GET /metrics` | Prometheus text format, no envelope | scraper — `{ "success": true }` around it would be unparseable |
| `GET /api` | `{ message, version, docs }`, no envelope | service discovery |

The leads export is the only one that matters. Its `Content-Disposition` filename is `property_leads.xls`
while the body is TSV with an Excel MIME type — wrong extension, but the frontend hardcodes its own
`property_leads.xls` at `app/admin/leads/page.tsx:116` regardless, so changing the header alone
changes nothing. Fix both together or neither.

## Helpers

`core/http/response.js`, installed once by `envelope()` in `src/app.js`. New routes never call
`res.json`.

```js
res.ok(data);
res.created(data);                                // 201, same body
res.paginated({ items, pagination });
res.noContent();                                  // 204
res.fail(status, message, code);                  // only the errorHandler should call this
```

Paginated list routes use `res.paginated()`; detail and mutation routes use `res.ok()` or
`res.created()`. Contract tests pin the response shapes.

## Errors

All errors flow through the global `errorHandler` as an `AppError`. Routes never throw bare `Error`.

```js
const { notFound } = require("../../core/errors");

throw notFound("Property not found", "PROPERTY_NOT_FOUND");
```

Factories exist for the common cases: `notFound`, `unauthorized`, `forbidden`, `conflict`,
`badRequest`, `rateLimited`, `internal`. `core/errors` is the only import path;
`middleware/errorHandler.js` re-exports `AppError` for the ten services that still import it from
there, and that re-export is deleted as each module is migrated.

### Status codes and codes

| Status | `code` | Raised when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | zod schema failed. Message lists `path: message` pairs. |
| 400 | `INVALID_FILE_TYPE` / `LIMIT_FILE_SIZE` / `LIMIT_UNEXPECTED_FILE` | multer |
| 401 | `AUTH_REQUIRED` | no or malformed `Authorization: Bearer` |
| 401 | `TOKEN_INVALID` | signature bad, expired, or wrong `type` claim |
| 403 | `FORBIDDEN` | authenticated, wrong role |
| 404 | `NOT_FOUND` | no matching row; also the catch-all for unknown routes |
| 409 | `CONFLICT` | Prisma `P2002` — unique constraint |
| 404 | `NOT_FOUND` | Prisma `P2025` — required record missing |
| 500 | — | anything unhandled. Message is generic in production; the stack goes to the log, never to the client. |
| 502/503 | `MAIL_DELIVERY_FAILED` | SMTP unreachable or rejected ([M00](../milestones/M00-safety-net.md) finding #7) |

`P2003`, `P2014` and `P2034` are deliberately **unmapped** — they need a message naming the actual
constraint or relation, which only the owning module can supply. See
`src/core/errors/prisma.js`.

### 401 is load-bearing

The frontend reauth chain fires only on exactly `401` (`baseApi.ts:78`, `lib/api.ts:37`). A `403` for
an expired token means the user is never refreshed and is hard-redirected to `/login` instead. Never
return 403 for an authentication failure.

## Paginated lists

Every paginated response uses one shape:

```json
{ "success": true, "data": { "items": [], "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 } } }
```

Backend routes use `res.paginated()` and services return `{ items, pagination }`. Frontend
list pages read `data.items`. Property API adapters may flatten that envelope for their
existing Redux consumers, while retaining the same `items` source contract.

## Pagination semantics

- `page` is 1-based.
- `limit` is capped at 100 and defaults to 20. `core/http/pagination.js` makes the cap
  unconditional — until a service adopts it, `property.service:177` is the only place the cap
  exists and the other twelve pass an unclamped `Number(req.query.limit) || 50` straight into
  `take`, so `?limit=100000` is a full table scan.
- `totalPages` is `ceil(total / limit)`, and `0` when `total` is `0`.
- `skip` is computed by the repository, never by the route — `toPrismaArgs()`.

Use `paginationQuery` for a `?page=&limit=` schema. A junk value (`?page=abc`) degrades to the
default rather than returning 400: a page hint is not a resource.
