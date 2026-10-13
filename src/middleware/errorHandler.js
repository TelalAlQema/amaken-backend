/**
 * The global error handler and the process's error type.
 *
 * `AppError` now lives in `core/errors` and is re-exported from here, because
 * ten services import it from this file and the M00 contract baseline pins their
 * behaviour. Those imports are the layering violation this milestone's `core/`
 * split exists to end; they are repointed at `core/errors` as each module is
 * migrated in M03-M06, and this re-export is deleted when the last one goes.
 *
 * Order of interpretation matters and is unchanged:
 *   1. `AppError`             → its own status and code
 *   2. multer                 → 400 with the multer code
 *   3. Prisma `P2002`/`P2025` → 409 / 404
 *   4. anything else          → 500, generic message
 *
 * Step 3 is new in M01. Before it, a unique-constraint violation surfaced as a
 * 500 with a message naming the database column, in development.
 */
const config = require("../config");
const { AppError, ErrorCode, fromPrisma, isPrismaError } = require("../core/errors");
const { getLogger } = require("../core/logger");
const { countError } = require("../core/observability");

/** multer's own error codes mean something specific to a client. */
const MULTER_MESSAGES = Object.freeze({
  LIMIT_FILE_SIZE: "File size exceeds the limit",
  LIMIT_UNEXPECTED_FILE: "Unexpected file field",
  LIMIT_FILE_COUNT: "Too many files",
});

/**
 * @param {Error & { statusCode?: number, code?: string, status?: number }} err
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} _next
 */
function errorHandler(err, req, res, _next) {
  const logger = req.app?.locals?.logger || getLogger();
  const requestId = res.locals?.id || req.id;

  // ── an authored error ─────────────────────────────────────────────────────
  if (err instanceof AppError) {
    countError(err.code || ErrorCode.INTERNAL_ERROR, { prefix: config.metrics.prefix });

    logger.warn(
      { requestId, code: err.code, status: err.statusCode, err: { message: err.message } },
      "request rejected"
    );

    res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        ...(err.code && { code: err.code }),
        ...(err.details !== undefined && { details: err.details }),
      },
    });
    return;
  }

  // ── a file upload ─────────────────────────────────────────────────────────
  if (err && err.name === "MulterError") {
    const message = MULTER_MESSAGES[err.code] || "File upload error";
    countError(err.code, { prefix: config.metrics.prefix });
    logger.warn({ requestId, code: err.code }, "upload rejected");

    res.status(400).json({ success: false, error: { message, code: err.code } });
    return;
  }

  // ── a database constraint ─────────────────────────────────────────────────
  // Only P2002 and P2025 are mapped. The rest return null and fall through to
  // the generic 500, which is deliberate: see core/errors/prisma.js.
  const translated = fromPrisma(err);
  if (translated) {
    countError(translated.code, { prefix: config.metrics.prefix });
    logger.warn(
      { requestId, prismaCode: err.code, code: translated.code, err: { message: err.message } },
      "database constraint"
    );

    res.status(translated.statusCode).json({
      success: false,
      error: { message: translated.message, code: translated.code },
    });
    return;
  }

  // ── anything else is a bug ────────────────────────────────────────────────
  // Stack and request context to the log. The client gets nothing it can use to
  // reconstruct the fault.
  countError(ErrorCode.INTERNAL_ERROR, { prefix: config.metrics.prefix });
  logger.error(
    {
      requestId,
      method: req.method,
      url: req.originalUrl,
      prisma: isPrismaError(err),
      err: { message: err.message, name: err.name, stack: err.stack },
    },
    "unhandled error"
  );

  res.status(500).json({
    success: false,
    error: {
      message: config.isDevelopment ? err.message : "Internal Server Error",
    },
  });
}

module.exports = { AppError, errorHandler };
