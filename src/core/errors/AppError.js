/**
 * The one error type the HTTP layer knows about.
 *
 * Services throw `AppError`; the global `errorHandler` renders it. Anything that
 * is *not* an `AppError` reaching the handler is a bug and becomes a 500 with a
 * generic message — the stack goes to the log, never to the client.
 *
 * The three-argument constructor `(message, statusCode, code)` is the signature
 * the existing services already use, and it is unchanged. `details` is a fourth,
 * optional argument for M03 onward.
 */
class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {string} [code]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, statusCode, code, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    // Required: the class is transpiled-free but still subclassed across module
    // boundaries, and `instanceof` must survive that.
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace?.(this, AppError);
  }

  /**
   * Whether this error is safe to show a client. A 4xx is authored for the
   * caller; a 5xx `AppError` usually wraps an infrastructure failure, so its
   * message is logged and replaced.
   */
  get isClientError() {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  toJSON() {
    return {
      message: this.message,
      ...(this.code && { code: this.code }),
      ...(this.details && { details: this.details }),
    };
  }
}

module.exports = { AppError };
