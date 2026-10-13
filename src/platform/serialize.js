/**
 * JSON encoding for the two tables that store structured values as text — the
 * durable cache tier (`kv_entries`) and the job queue (`jobs`).
 *
 * Exists as its own module because both need the same guarantee, and a
 * hand-rolled `JSON.stringify` in each is how they drift: one gains a `bigint`
 * case, the other does not, and the bug appears only under a value shape that
 * one of them happens to produce.
 *
 * The guarantee: **never throw on a value Prisma can return.** `bigint` is the
 * one non-JSON type that shows up in practice — Prisma returns `BigInt` for
 * `COUNT(*)` and for `Int` columns wider than 32 bits, so a cached dashboard
 * total or a queued job carrying a lead count is a plain object containing one.
 */

/** `typeof` result compared against in the replacer, hoisted for readability. */
const BIGINT = "bigint";

/**
 * Encodes a value for a `TEXT` column.
 *
 * `Date` becomes an ISO string, which is lossy: a round-tripped value is a
 * string where it was a `Date`. Callers that need the type back have to say so
 * in their own payload. That is acceptable for this codebase's two consumers
 * (OTP payloads, which are `{ code, purpose }`, and job payloads, which are
 * flat scalars) and is stated rather than hidden.
 *
 * @param {unknown} value
 * @returns {string}
 */
function encodeJson(value) {
  return JSON.stringify(value, (_key, inner) => (typeof inner === BIGINT ? inner.toString() : inner));
}

/**
 * Decodes a stored value.
 *
 * A row that does not parse is the caller's problem, not this function's: see
 * the callers, which treat an unparseable row as a miss. Keeping `JSON.parse`'s
 * throw means neither caller has to re-implement the distinction between "no
 * row" and "corrupt row", and both already need to make it.
 *
 * `JSON.parse` of a stored `"null"` yields `null`, which callers already treat as
 * "nothing here", so it is passed through rather than remapped.
 *
 * @param {string | null | undefined} raw
 * @returns {unknown}
 * @throws {SyntaxError} when `raw` is not JSON — deliberately, see above.
 */
function decodeJson(raw) {
  if (raw === null || raw === undefined) return null;
  return JSON.parse(raw);
}

module.exports = { encodeJson, decodeJson };