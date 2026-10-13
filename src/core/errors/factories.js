/**
 * Error factories.
 *
 * `new AppError("...", 404, "PROPERTY_NOT_FOUND")` puts a status and a code
 * at every throw site, and both get transposed sooner or later. A factory makes
 * the pair impossible to get wrong and gives a grep-able name for the common
 * cases.
 *
 *     throw notFound("Property not found", "PROPERTY_NOT_FOUND");
 *
 * The optional second argument is a *domain* code, so a client can still
 * distinguish two different 404s without parsing prose.
 */
const { AppError } = require("./AppError");
const { ErrorCode, STATUS_BY_CODE } = require("./codes");

/**
 * @param {string} code
 * @param {number} [statusOverride]
 * @returns {(message: string, domainCode?: string, details?: Record<string, unknown>) => AppError}
 */
function factory(code, statusOverride) {
  const status = statusOverride ?? STATUS_BY_CODE[code] ?? 500;
  return (message, domainCode, details) =>
    new AppError(message, status, domainCode || code, details);
}

const badRequest = factory(ErrorCode.BAD_REQUEST);
const validationError = factory(ErrorCode.VALIDATION_ERROR);
const unauthorized = factory(ErrorCode.AUTH_REQUIRED);
const tokenInvalid = factory(ErrorCode.TOKEN_INVALID);
const forbidden = factory(ErrorCode.FORBIDDEN);
const notFound = factory(ErrorCode.NOT_FOUND);
const conflict = factory(ErrorCode.CONFLICT);
const rateLimited = factory(ErrorCode.RATE_LIMITED);
const serviceUnavailable = factory(ErrorCode.SERVICE_UNAVAILABLE);

/**
 * A 5xx the caller is not meant to read. The message is kept for the log; the
 * errorHandler substitutes a generic one on the wire.
 */
function internal(message, details) {
  return new AppError(message || "Internal Server Error", 500, ErrorCode.INTERNAL_ERROR, details);
}

module.exports = {
  badRequest,
  validationError,
  unauthorized,
  tokenInvalid,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  serviceUnavailable,
  internal,
};
