/**
 * Canonical error codes.
 *
 * `code` is the stable half of an error contract: the message is prose written
 * for a human and is free to change, the code is what a client branches on. The
 * frontend's reauth chain, for example, fires on `401` and *only* `401`
 * (`frontend/lib/redux/api/baseApi.ts:78`) — see
 * [`architecture/envelope.md`](../../../docs/architecture/envelope.md).
 *
 * Domain-specific codes (`PROPERTY_NOT_FOUND`, `STATE_HAS_CITIES`, …) predate
 * this object and are still thrown as string literals from the services. They
 * are deliberately *not* listed here: the list stays a closed set of codes the
 * kernel itself produces, and a domain code remains a domain decision.
 */
const ErrorCode = Object.freeze({
  // 400
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",

  // 401 — never 403. An expired token must return 401 or the client hard-redirects to /login.
  AUTH_REQUIRED: "AUTH_REQUIRED",
  TOKEN_INVALID: "TOKEN_INVALID",

  // 403
  FORBIDDEN: "FORBIDDEN",

  // 404
  NOT_FOUND: "NOT_FOUND",

  // 409
  CONFLICT: "CONFLICT",

  // 413 / 429
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",

  // 5xx
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  MAIL_DELIVERY_FAILED: "MAIL_DELIVERY_FAILED",
});

/** Default HTTP status per code, so a factory can be called with just a message. */
const STATUS_BY_CODE = Object.freeze({
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.AUTH_REQUIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  [ErrorCode.MAIL_DELIVERY_FAILED]: 502,
});

module.exports = { ErrorCode, STATUS_BY_CODE };
