/**
 * Pagination.
 *
 * One 13-line block is copy-pasted 13 times across the services today:
 *
 *     const page = Number(req.query.page) || 1;
 *     const limit = Number(req.query.limit) || 50;
 *     const [items, total] = await Promise.all([ …, prisma.x.count() ]);
 *     return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
 *
 * Thirteen chances to forget the `count`, disagree on the default `limit`, or
 * skip the cap. `property.service.js:177` is the only one that clamps `limit`
 * at 100; the other twelve pass an unclamped `limit` straight into `take`, so
 * `?limit=100000` is a full table scan today.
 *
 * Two rules, both from
 * [`architecture/envelope.md`](../../../docs/architecture/envelope.md):
 *   - `page` is 1-based, `limit` defaults to 20 and is capped at 100.
 *   - `skip` is computed by the repository, never by the route.
 */
const { z } = require("zod");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Query-string schema for `?page=&limit=`.
 *
 * `.default(v).catch(v)` in that order, deliberately:
 *   - `.default` covers a **missing** key, because a zod object hands a missing
 *     key to the value schema as `undefined`.
 *   - `.catch` covers a **junk** value (`?page=abc`), which `z.coerce.number`
 *     turns into `NaN` and the `.int().min(1)` chain rejects.
 *
 * Reversing them silently returns `{}` — `.catch(undefined)` swallows the
 * failure, and a `.default()` applied *after* it only fires for input that was
 * already undefined, so the key vanishes from the parsed object instead of
 * falling back.
 *
 * A junk value degrades to the default rather than 400ing: pagination is a
 * navigational hint, not a resource, and a client asking for page "abc" should
 * get page 1. The repository layer is where a genuinely invalid parameter
 * belongs.
 */
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).catch(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).catch(DEFAULT_LIMIT),
});

/**
 * The four-key pagination object. The key set is part of the wire contract and
 * is asserted by `test/contract/public.test.js` — adding a key is a breaking
 * change for every frontend reader that destructures it.
 *
 * @param {{ page?: number, limit?: number, total: number }} input
 * @returns {{ page: number, limit: number, total: number, totalPages: number }}
 */
function paginate({ page = 1, limit = DEFAULT_LIMIT, total = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const safePage = Math.max(Number(page) || 1, 1);
  const safeTotal = Math.max(Number(total) || 0, 0);

  return {
    page: safePage,
    limit: safeLimit,
    total: safeTotal,
    totalPages: Math.ceil(safeTotal / safeLimit),
  };
}

/**
 * Prisma `skip`/`take` from a page window. Called by a repository, never by a
 * route: the moment a route computes `skip` the two can disagree and pagination
 * silently skips or repeats rows.
 *
 * @param {{ page?: number, limit?: number }} page
 * @returns {{ skip: number, take: number }}
 */
function toPrismaArgs({ page = 1, limit = DEFAULT_LIMIT } = {}) {
  const { page: safePage, limit: safeLimit } = paginate({ page, limit, total: 0 });
  return { skip: (safePage - 1) * safeLimit, take: safeLimit };
}

/**
 * The shape a repository returns for a list. `paginated(res, …)` takes exactly
 * this, which is why `items` is named `items` and not `rows` or `data`.
 *
 * @template T
 * @param {T[]} items
 * @param {number} total
 * @param {{ page?: number, limit?: number }} [page]
 * @returns {{ items: T[], pagination: { page: number, limit: number, total: number, totalPages: number } }}
 */
function pagedResult(items, total, page) {
  return { items, pagination: paginate({ ...page, total }) };
}

module.exports = {
  paginationQuery,
  paginate,
  toPrismaArgs,
  pagedResult,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
