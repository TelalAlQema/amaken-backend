/**
 * `core/http` — the HTTP primitives every module uses.
 *
 * Framework-agnostic within Express: nothing here touches the database, a
 * module, or `req.user`. The rule this directory exists to enforce is that a
 * route never writes `res.json` or a `try/catch` — see
 * [`architecture/module-contract.md`](../../../docs/architecture/module-contract.md).
 */
const { asyncHandler } = require("./asyncHandler");
const { notFound } = require("./notFound");
const pagination = require("./pagination");
const response = require("./response");
const { validateBody, validateParams, validateQuery } = require("./validate");

module.exports = {
  ...response,
  ...pagination,
  asyncHandler,
  notFound,
  // M03: moved here from `src/middleware/validate.js`, which is now a re-export
  // shim for the route files that have not been migrated yet.
  validateBody,
  validateParams,
  validateQuery,
};
