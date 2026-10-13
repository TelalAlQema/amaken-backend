/**
 * Who may call what.
 *
 * Every module has one of these, and the reason is not ceremony: the guards a route
 * declares and the behaviour its service enforces are two different things, and
 * only the second one survives a copy-paste. This file holds the ones that were
 * previously invisible — `if (user.adminblock === 1) throw …` written inline in a
 * service, the role dispatch inside `/auth/refresh`, and the fact that eight of the
 * nine endpoints are reachable by an anonymous caller.
 *
 * It does not mutate state and it does not query anything.
 */
const { AppError } = require("../../core/errors");

/** One per HTTP endpoint in the module. */
const Operation = Object.freeze({
  REGISTER: "register",
  LOGIN: "login",
  VERIFY_EMAIL: "verify-email",
  VERIFY_OTP: "verify-otp",
  FORGOT_PASSWORD: "forgot-password",
  VERIFY_FORGOT_OTP: "verify-forgot-otp",
  RESET_PASSWORD: "reset-password",
  REFRESH: "refresh",
  LOGOUT: "logout",
});

/**
 * Who the endpoint expects to be calling it.
 *
 * `anonymous` is a claim about the *endpoint*, not about the caller: no credential
 * is required, and supplying one does not change what it does.
 */
const Principal = Object.freeze({
  ANONYMOUS: "anonymous",
  /** A refresh token is the credential, and it is the only thing that is checked. */
  REFRESH_TOKEN: "refresh-token",
  /** A token is accepted if present and ignored if not. */
  OPTIONAL_TOKEN: "optional-token",
});

/**
 * The declaration for each endpoint: where it lives, and who may reach it.
 *
 * `path` is relative to the module's mount (`/api/auth`), because a module does not
 * know, and must not hardcode, the prefix its mount was given.
 */
const POLICIES = Object.freeze({
  [Operation.REGISTER]: { method: "POST", path: "/register", principal: Principal.ANONYMOUS },
  [Operation.LOGIN]: { method: "POST", path: "/login", principal: Principal.ANONYMOUS },
  [Operation.VERIFY_EMAIL]: {
    method: "POST",
    path: "/verify-email",
    principal: Principal.ANONYMOUS,
  },
  [Operation.VERIFY_OTP]: {
    method: "POST",
    path: "/verify-otp",
    principal: Principal.ANONYMOUS,
  },
  [Operation.FORGOT_PASSWORD]: {
    method: "POST",
    path: "/forgot-password",
    principal: Principal.ANONYMOUS,
  },
  [Operation.VERIFY_FORGOT_OTP]: {
    method: "POST",
    path: "/verify-forgot-otp",
    principal: Principal.ANONYMOUS,
  },
  [Operation.RESET_PASSWORD]: {
    method: "POST",
    path: "/reset-password",
    principal: Principal.ANONYMOUS,
  },
  // The only endpoint with a credential of its own. It is also the only one whose
  // service does a database lookup before responding.
  [Operation.REFRESH]: { method: "POST", path: "/refresh", principal: Principal.REFRESH_TOKEN },
  [Operation.LOGOUT]: { method: "POST", path: "/logout", principal: Principal.OPTIONAL_TOKEN },
});

/**
 * The roles `/auth/refresh` will dispatch on.
 *
 * The claim is signed, so it cannot be forged — but it *can* be absent, or carry
 * anything a future code path decides to put there. Dispatching on an unbounded set
 * is how "role: admin" without an admin row becomes a 404 with a database table name
 * in it.
 */
const REFRESH_ROLES = Object.freeze(["user", "admin"]);

/**
 * Throws unless `operation` has a declaration.
 *
 * Called at route-registration time, so a route added without a policy entry is a
 * **boot failure** rather than something a reviewer has to notice. That inversion is
 * the point: the default has to be "refuse to start".
 *
 * @param {string} operation
 * @returns {object} the declaration
 */
function assertDeclared(operation) {
  const policy = POLICIES[operation];
  if (!policy) {
    // Not an AppError: this is a defect in the source, and there is no request to
    // answer. A 500 would bury it behind the error handler's redaction.
    throw new Error(
      `modules/auth: operation "${operation}" has no entry in auth.policy.POLICIES. ` +
        "Declare it before mounting a route for it."
    );
  }
  return policy;
}

/**
 * Binds a route's middleware to an operation, failing at load time if the operation
 * is undeclared.
 *
 *     router.post("/login", ...policy.forOperation(Operation.LOGIN, validateBody(schemas.loginSchema)), handler);
 *
 * @param {string} operation
 * @param {...import("express").RequestHandler} middleware
 * @returns {import("express").RequestHandler[]}
 */
function forOperation(operation, ...middleware) {
  assertDeclared(operation);
  return middleware;
}

/**
 * Every endpoint this module exposes, for the contract test to compare against the
 * router. Returns a copy so a test cannot edit the policy by holding on to it.
 *
 * @returns {{ method: string, path: string, principal: string }[]}
 */
function declaredRoutes() {
  return Object.entries(POLICIES).map(([operation, policy]) => ({ operation, ...policy }));
}

/**
 * A refresh token must name a role this module can resolve to a row.
 *
 * @param {{ role?: string }} payload a verified token payload
 * @throws {AppError} 401, so a caller cannot use the endpoint to probe claims
 */
function assertRefreshPrincipal(payload) {
  if (!payload || !REFRESH_ROLES.includes(payload.role)) {
    throw new AppError("Invalid or expired refresh token", 401, "REFRESH_INVALID");
  }
}

/**
 * A blocked account cannot authenticate, register, or verify an address.
 *
 * `DelAccount` is the delete ledger and `adminblock` is the admin's switch; both
 * meant the same thing to the three call sites that checked them separately, and
 * one of those call sites did not check the admin switch at all until M00.
 *
 * The message and code are parameters because the two uses are not the same event:
 * before an account exists the caller is blocked *at that address*, afterwards the
 * caller is blocked *as an account*, and the frontend words them differently.
 *
 * @param {{ deleted?: boolean, blocked?: boolean }} account
 * @param {{ message: string, code: string }} error
 * @throws {AppError}
 */
function assertNotBlocked(account, error) {
  if (account && (account.deleted || account.blocked)) {
    throw new AppError(error.message, 403, error.code);
  }
}

module.exports = {
  Operation,
  Principal,
  POLICIES,
  REFRESH_ROLES,
  assertDeclared,
  forOperation,
  declaredRoutes,
  assertRefreshPrincipal,
  assertNotBlocked,
};