/**
 * Who may call what in `modules/admins`.
 *
 * ## The two-step login, and what the second step guarantees
 *
 * `POST /pin` and `POST /login` are anonymous; everything else needs an **admin**
 * token. Unlike `modules/users`, this module *can* carry a mount-level guard for
 * most of its surface — but not for its first two routes, which have to precede it
 * or the login page could never be reached. So the split is the same as `users`:
 * per-operation principals, and the mount takes no guards.
 *
 * `requireRole("admin")` is part of the guard for every non-anonymous operation,
 * not a separate rule, because "authenticated" and "authenticated as an admin" are
 * not two states this module ever wants. The pre-M04 file had
 * `router.use(authenticate, requireRole("admin"))` after the two login routes,
 * which is exactly equivalent — see the ordering note in `admins.routes.js`.
 *
 * ## The owner exemption is a service rule, not a policy rule
 *
 * The owner admin (`admin.main === config.admin.mainPhone`) is exempt from the
 * `adminblock` check in `adminLogin`. That is a rule about a row's data, so it
 * cannot be declared here — a policy says who may call, not what a row is allowed
 * to be. See `admins.service.adminLogin`.
 */
const { AppError } = require("../../core/errors");

/** One per HTTP endpoint in the module. */
const Operation = Object.freeze({
  VERIFY_PIN: "verify-pin",
  LOGIN: "login",
  GET_PROFILE: "get-profile",
  UPDATE_PROFILE: "update-profile",
  UPLOAD_AVATAR: "upload-avatar",
  DELETE_AVATAR: "delete-avatar",
  UPLOAD_LOGO: "upload-logo",
  DELETE_LOGO: "delete-logo",
  UPDATE_LINKS: "update-links",
  CHANGE_PASSWORD: "change-password",
  LIST_USERS: "list-users",
  LIST_AGENTS: "list-agents",
  LIST_BUILDERS: "list-builders",
  LIST_ADMINS: "list-admins",
  SET_USER_STATUS: "set-user-status",
  DELETE_USER: "delete-user",
  LIST_REGISTERED: "list-registered",
  LIST_DELETED: "list-deleted",
  LIST_BLOCKED: "list-blocked",
  DELETE_ACCOUNT_RECORD: "delete-account-record",
});

const Principal = Object.freeze({
  ANONYMOUS: "anonymous",
  /** A valid access token whose role claim is `admin`. */
  ADMIN: "admin",
});

/**
 * `path` is relative to the module's mount (`/api/admin`).
 *
 * Declaration order matches the pre-M04 router exactly, because `/users/agents`
 * must be reachable before `/users/:id/status` and `/users/:id` are considered —
 * `GET /users/admins` and `GET /users/builders` would otherwise be read as a `:id`
 * and fail `parseInt`.
 *
 * There is no `GET /users/:id` on its own; the only `:id` routes are the `PUT`
 * status route and the `DELETE`.
 */
const POLICIES = Object.freeze({
  [Operation.VERIFY_PIN]: { method: "POST", path: "/pin", principal: Principal.ANONYMOUS },
  [Operation.LOGIN]: { method: "POST", path: "/login", principal: Principal.ANONYMOUS },

  [Operation.GET_PROFILE]: { method: "GET", path: "/profile", principal: Principal.ADMIN },
  [Operation.UPDATE_PROFILE]: { method: "PUT", path: "/profile", principal: Principal.ADMIN },
  [Operation.UPLOAD_AVATAR]: { method: "POST", path: "/profile/avatar", principal: Principal.ADMIN },
  [Operation.DELETE_AVATAR]: { method: "DELETE", path: "/profile/avatar", principal: Principal.ADMIN },
  [Operation.UPLOAD_LOGO]: { method: "POST", path: "/profile/logo", principal: Principal.ADMIN },
  [Operation.DELETE_LOGO]: { method: "DELETE", path: "/profile/logo", principal: Principal.ADMIN },
  [Operation.UPDATE_LINKS]: { method: "PUT", path: "/profile/links", principal: Principal.ADMIN },
  [Operation.CHANGE_PASSWORD]: { method: "PUT", path: "/profile/password", principal: Principal.ADMIN },

  [Operation.LIST_USERS]: { method: "GET", path: "/users", principal: Principal.ADMIN },
  [Operation.LIST_AGENTS]: { method: "GET", path: "/users/agents", principal: Principal.ADMIN },
  [Operation.LIST_BUILDERS]: { method: "GET", path: "/users/builders", principal: Principal.ADMIN },
  [Operation.LIST_ADMINS]: { method: "GET", path: "/users/admins", principal: Principal.ADMIN },
  [Operation.SET_USER_STATUS]: { method: "PUT", path: "/users/:id/status", principal: Principal.ADMIN },
  [Operation.DELETE_USER]: { method: "DELETE", path: "/users/:id", principal: Principal.ADMIN },

  // These four are served by `modules/accounts`; only the URLs live here.
  [Operation.LIST_REGISTERED]: { method: "GET", path: "/accounts/registered", principal: Principal.ADMIN },
  [Operation.LIST_DELETED]: { method: "GET", path: "/accounts/deleted", principal: Principal.ADMIN },
  [Operation.LIST_BLOCKED]: { method: "GET", path: "/accounts/blocked", principal: Principal.ADMIN },
  [Operation.DELETE_ACCOUNT_RECORD]: {
    method: "DELETE",
    path: "/accounts/:id",
    principal: Principal.ADMIN,
  },
});

/**
 * The middleware that enforces `principal`, given the shared auth guards.
 *
 * The two shared guards are passed in rather than imported so this file stays
 * policy-only — it does not mutate state and does not query anything, which is the
 * rule every module's `.policy.js` follows.
 *
 * `ADMIN` maps to `[authenticate, requireRole("admin")]`. `authenticate` populates
 * `req.user` and `requireRole` reads the role from it, so the order is not
 * interchangeable: `requireRole` alone throws 401 for an anonymous caller with a
 * different message, and 403 for a valid user token with the wrong role.
 *
 * @param {{ authenticate: import("express").RequestHandler, requireRole: (role: string) => import("express").RequestHandler }} guards
 * @param {string} operation
 * @returns {import("express").RequestHandler[]}
 */
function guardsFor(guards, operation) {
  const policy = assertDeclared(operation);

  if (policy.principal === Principal.ANONYMOUS) return [];

  return [guards.authenticate, guards.requireRole(Principal.ADMIN)];
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
      `modules/admins: operation "${operation}" has no entry in admins.policy.POLICIES. ` +
        "Declare it before mounting a route for it."
    );
  }
  return policy;
}

/**
 * `parseInt` with a NaN guard, for both `:id` params.
 *
 * The two error messages differ — "Invalid user ID" and "Invalid record ID" — and
 * they have to, because the admin app uses them to tell "you typed a bad user id"
 * from "you typed a bad ledger id" when a bulk action fails.
 *
 * `parseInt` is lenient about trailing junk (`"7abc"` → 7), which is preserved from
 * the pre-M04 routes for the reason given in `users.policy.parseUserId`.
 *
 * @param {Record<string, string>} params
 * @param {string} message
 * @returns {number}
 * @throws {AppError} 400
 */
function parseId(params, message) {
  const id = parseInt(params.id);
  if (Number.isNaN(id)) throw new AppError(message, 400, "INVALID_ID");
  return id;
}

/**
 * @returns {{ operation: string, method: string, path: string, principal: string }[]}
 */
function declaredRoutes() {
  return Object.entries(POLICIES).map(([operation, policy]) => ({ operation, ...policy }));
}

module.exports = { Operation, Principal, POLICIES, guardsFor, assertDeclared, parseId, declaredRoutes };