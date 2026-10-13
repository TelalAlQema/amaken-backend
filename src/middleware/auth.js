const { AppError } = require("./errorHandler");
// M03. Through the module manifest, not `modules/auth/token.service`: the
// implementation is the module's, and this is the one import path a consumer is
// allowed. `verifyAccessToken` stays synchronous because `authenticate` is
// synchronous — see the note on `verifyAccess` in modules/auth/token.service.js for
// why a per-token denylist could not be a Redis round-trip here.
const { capabilities } = require("../modules/auth");

const verifyAccessToken = capabilities.verifyAccessToken;

/**
 * Turns a verification failure into a 401.
 *
 * M03 split the old single `null` into two reasons, so the code the client sees now
 * says something: an expired token and a forged one want different behaviour from
 * the frontend — refresh, versus sign in again. `TOKEN_INVALID` is what a malformed
 * token has always returned and is pinned by `test/contract/user.test.js`.
 *
 * @param {{ ok: boolean, reason?: string }} result
 * @returns {AppError}
 */
function rejection(result) {
  return result.reason === "expired"
    ? new AppError("Token expired", 401, "TOKEN_EXPIRED")
    : new AppError("Invalid or expired token", 401, "TOKEN_INVALID");
}

function authenticate(req, _res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError("Authentication required", 401, "AUTH_REQUIRED"));
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const result = verifyAccessToken(token);

  if (!result.ok) {
    return next(rejection(result));
  }

  req.user = {
    id: result.payload.userId,
    email: result.payload.email,
    role: result.payload.role,
    name: "",
  };

  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError("Authentication required", 401, "AUTH_REQUIRED"));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError("Insufficient permissions", 403, "FORBIDDEN"));
    }

    next();
  };
}

function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const result = verifyAccessToken(token);

  if (result.ok) {
    req.user = {
      id: result.payload.userId,
      email: result.payload.email,
      role: result.payload.role,
      name: "",
    };
  }

  next();
}

module.exports = { authenticate, requireRole, optionalAuth };
