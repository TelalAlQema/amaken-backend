/**
 * `platform/cache` — namespaced, TTL'd cache with `get`/`set`/`invalidatePrefix`.
 *
 * Two tiers: an in-process `Map` for ordinary namespaces and MySQL rows for the
 * credential namespaces listed in `CACHE_DURABLE_NAMESPACES`. Callers require
 * this module and never learn which tier a value lives in.
 *
 * @see ./cache.js for the tier split and why it is by namespace
 * @see ./durable.js for the MySQL tier
 */
const cache = require("./cache");

module.exports = cache;