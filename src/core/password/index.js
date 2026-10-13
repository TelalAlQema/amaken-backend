/**
 * `core/password` — the barrel, and the names callers actually use.
 *
 * `verify` returns a `{ ok, upgrade }` pair rather than a boolean because the two
 * answers are genuinely different decisions. "These do not match" ends the request;
 * "these match but the stored hash is weak" ends the request *and* schedules a
 * rewrite. A caller that wants only the first cannot get it by ignoring a field —
 * it has to look, which is the point. The pre-M04 services each decided this
 * independently and two of the four got it wrong.
 *
 * The names are deliberately short (`hash`, `verify`) rather than
 * `hashPassword` / `verifyPassword`. The import already says where they come from,
 * so `password.verify(plain, stored)` reads better than
 * `password.verifyPassword(plain, stored)` and there is nothing left to disambiguate
 * against.
 */
const service = require("./password.service");

module.exports = {
  hash: service.hash,
  verify: service.verify,
  burn: service.burn,
  isHash: service.isHash,
  BCRYPT_COST: service.BCRYPT_COST,
  HASH_PREFIXES: service.HASH_PREFIXES,
};