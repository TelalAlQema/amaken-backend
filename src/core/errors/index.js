/**
 * `core/errors` — the error vocabulary of the whole process.
 *
 * Framework-agnostic: this directory knows nothing about HTTP, Express or
 * Prisma, only about "an error with a status and a code". `core/*` may import
 * `core/*` and nothing else; see
 * [`architecture/overview.md`](../../../docs/architecture/overview.md).
 *
 * This barrel is the only import path. `src/middleware/errorHandler.js`
 * re-exports `AppError` from here so the ~10 services that still import it from
 * the HTTP layer keep working unchanged — M03 onward they import this instead,
 * and the re-export is deleted.
 */
const { AppError } = require("./AppError");
const { ErrorCode, STATUS_BY_CODE } = require("./codes");
const factories = require("./factories");
const { isPrismaError, fromPrisma } = require("./prisma");

module.exports = {
  AppError,
  ErrorCode,
  STATUS_BY_CODE,
  isPrismaError,
  fromPrisma,
  ...factories,
};
