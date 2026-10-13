/**
 * Zod → the envelope's 400.
 *
 * **Moved here from `src/middleware/validate.js` in M03**, which is what that file's
 * own note said would happen: *"Consolidate it in M03 with the first module that
 * gets a `*.schema.js`."* A module must not import from `middleware/` — that layer
 * is legacy and is emptied module by module — so `modules/auth` needed this to live
 * under `core/`. `src/middleware/validate.js` is now a re-export for the eleven
 * route files that have not been migrated yet, and is deleted with the last of them.
 *
 * The message format is part of the frozen contract: the frontend renders it
 * directly (`frontend/app/(public)/(auth)/login/page.tsx`), so it is unchanged.
 * It is `path: message` pairs joined by `; `.
 *
 * `validateQuery` still cannot write its result back — see the note on it below.
 */
const { ZodError } = require("zod");
const { AppError } = require("../errors");

/**
 * @param {ZodError} err
 * @returns {AppError}
 */
function toValidationError(err) {
  const message = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
  return new AppError(message, 400, "VALIDATION_ERROR");
}

/**
 * @param {import("zod").ZodTypeAny} schema
 * @returns {import("express").RequestHandler}
 */
function validateBody(schema) {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(err instanceof ZodError ? toValidationError(err) : err);
    }
  };
}

/**
 * @param {import("zod").ZodTypeAny} schema
 * @returns {import("express").RequestHandler}
 */
function validateParams(schema) {
  return (req, _res, next) => {
    try {
      req.params = schema.parse(req.params);
      next();
    } catch (err) {
      next(err instanceof ZodError ? toValidationError(err) : err);
    }
  };
}

/**
 * NOTE(M01): the *rejection* works, the *write-back* does not.
 *
 * Express 4 defines `req.query` as a getter-only accessor on the request
 * prototype, so `req.query = parsed` is a silent no-op outside strict mode. A
 * query schema that transforms or defaults therefore validates and then changes
 * nothing — the handler still reads the raw string. `req.body` and `req.params`
 * are plain own properties, so those two are fine.
 *
 * Left exactly as-is: fixing it changes what 8 list endpoints receive, which is
 * M05's price-migration territory, not this file's. `modules/auth` has no query
 * parameters, so it does not depend on this behaviour either way.
 *
 * @param {import("zod").ZodTypeAny} schema
 * @returns {import("express").RequestHandler}
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (err) {
      next(err instanceof ZodError ? toValidationError(err) : err);
    }
  };
}

module.exports = { validateBody, validateParams, validateQuery, toValidationError };