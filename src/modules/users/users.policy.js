/**
 * Who may call what in `modules/users`.
 *
 * The interesting declaration here is {@link Operation.PUBLIC_PROFILE}. Thirteen of
 * the fourteen endpoints require an authenticated user; one requires nothing at
 * all, and it was behind `router.use(authenticate)` until M04.
 *
 * ## Why `guards: []` on the mount
 *
 * The pre-M04 file opened with `router.use(authenticate)`, applying the guard to
 * every route beneath it. That is the correct idiom *when every route needs the
 * same thing* — and it is why making one route public meant restructuring the
 * whole file: the guard had to become per-route, and there was no list saying
 * which. Each endpoint now declares its own principal here instead, so "which
 * endpoints are public?" is answerable by reading one object.
 */
const { AppError } = require("../../core/errors");

/** One per HTTP endpoint in the module. */
const Operation = Object.freeze({
  GET_PROFILE: "get-profile",
  UPDATE_PROFILE: "update-profile",
  UPLOAD_AVATAR: "upload-avatar",
  DELETE_AVATAR: "delete-avatar",
  UPLOAD_LOGO: "upload-logo",
  DELETE_LOGO: "delete-logo",
  CHANGE_PASSWORD: "change-password",
  UPDATE_LINKS: "update-links",
  DEACTIVATE: "deactivate",
  ACTIVATE: "activate",
  DELETE_ACCOUNT: "delete-account",
  BLOCK: "block",
  UNBLOCK: "unblock",
  PUBLIC_PROFILE: "public-profile",
});

/**
 * Who the endpoint expects to be calling it.
 *
 * `anonymous` is a claim about the endpoint, not about the caller — a valid token
 * on `GET /users/:id` is ignored.
 */
const Principal = Object.freeze({
  ANONYMOUS: "anonymous",
  AUTHENTICATED: "authenticated",
});

/**
 * `path` is relative to the module's mount (`/api/users`).
 *
 * `/block/:id` and `/unblock/:id` carry a path parameter and are declared
 * `AUTHENTICATED` — the requirement is on the *caller*, not on the target. That
 * distinction is load-bearing and currently unenforced: both handlers pass
 * `req.params.id` straight to the service, so any authenticated user can freeze any
 * other. The M04 note claims this was fixed in M00; it was not, `test/contract/user.test.js`
 * pins the vulnerable behaviour, and the fix is M00.6. Preserved here, deliberately
 * — see the file header in `users.routes.js`.
 */
const POLICIES = Object.freeze({
  [Operation.GET_PROFILE]: { method: "GET", path: "/me", principal: Principal.AUTHENTICATED },
  [Operation.UPDATE_PROFILE]: { method: "PUT", path: "/me", principal: Principal.AUTHENTICATED },
  [Operation.UPLOAD_AVATAR]: { method: "POST", path: "/me/avatar", principal: Principal.AUTHENTICATED },
  [Operation.DELETE_AVATAR]: { method: "DELETE", path: "/me/avatar", principal: Principal.AUTHENTICATED },
  [Operation.UPLOAD_LOGO]: { method: "POST", path: "/me/logo", principal: Principal.AUTHENTICATED },
  [Operation.DELETE_LOGO]: { method: "DELETE", path: "/me/logo", principal: Principal.AUTHENTICATED },
  [Operation.CHANGE_PASSWORD]: {
    method: "PUT",
    path: "/me/password",
    principal: Principal.AUTHENTICATED,
  },
  [Operation.UPDATE_LINKS]: { method: "PUT", path: "/me/links", principal: Principal.AUTHENTICATED },
  [Operation.DEACTIVATE]: { method: "POST", path: "/me/deactivate", principal: Principal.AUTHENTICATED },
  [Operation.ACTIVATE]: { method: "POST", path: "/me/activate", principal: Principal.AUTHENTICATED },
  [Operation.DELETE_ACCOUNT]: { method: "DELETE", path: "/me", principal: Principal.AUTHENTICATED },
  [Operation.BLOCK]: { method: "POST", path: "/block/:id", principal: Principal.AUTHENTICATED },
  [Operation.UNBLOCK]: { method: "POST", path: "/unblock/:id", principal: Principal.AUTHENTICATED },
  // The one public endpoint. M04's Definition of Done requires it: a property
  // listing shows its owner's name and avatar to an unauthenticated visitor.
  [Operation.PUBLIC_PROFILE]: { method: "GET", path: "/:id", principal: Principal.ANONYMOUS },
});

/**
 * The middleware that enforces `principal`, given the shared auth guard.
 *
 * Unlike `auth.policy.forOperation`, which only validates declarations, this one
 * applies a guard. It exists because `modules/users` is the first module with a
 * mixed public/authenticated mount: the guard for an `AUTHENTICATED` operation is
 * the process-wide `authenticate` from `src/middleware/auth.js`, passed in so this
 * file does not import the HTTP layer, and there is nothing to apply for
 * `ANONYMOUS`.
 *
 * @param {import("express").RequestHandler} authenticate
 * @param {string} operation
 * @returns {import("express").RequestHandler[]}
 */
function guardsFor(authenticate, operation) {
  const policy = assertDeclared(operation);
  return policy.principal === Principal.AUTHENTICATED ? [authenticate] : [];
}

/**
 * @param {string} operation
 * @returns {object} the declaration
 * @throws {Error} at load time when undeclared — a defect, not a request
 */
function assertDeclared(operation) {
  const policy = POLICIES[operation];
  if (!policy) {
    throw new Error(
      `modules/users: operation "${operation}" has no entry in users.policy.POLICIES. ` +
        "Declare it before mounting a route for it."
    );
  }
  return policy;
}

/**
 * The numeric `:id` from a path, or a 400.
 *
 * `parseInt` on its own is lenient: `parseInt("1abc")` is `1`, and `parseInt("1.9")`
 * is `1`. The legacy handlers accepted both, so a request for `/users/1abc`
 * returned user 1. Kept for compatibility; `Number()` plus an integer check is the
 * stricter form and belongs to the milestone that is allowed to change a response.
 *
 * @param {Record<string, string>} params
 * @returns {number}
 * @throws {AppError} 400 `INVALID_USER_ID`
 */
function parseUserId(params) {
  const id = parseInt(params.id);
  if (Number.isNaN(id)) throw new AppError("Invalid user ID", 400, "INVALID_USER_ID");
  return id;
}

/**
 * @returns {{ operation: string, method: string, path: string, principal: string }[]}
 */
function declaredRoutes() {
  return Object.entries(POLICIES).map(([operation, policy]) => ({ operation, ...policy }));
}

module.exports = { Operation, Principal, POLICIES, guardsFor, assertDeclared, parseUserId, declaredRoutes };