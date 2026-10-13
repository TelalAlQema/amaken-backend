/**
 * The twenty `/api/admin` endpoints.
 *
 * ## Route order, and why it is the pre-M04 order exactly
 *
 * The pre-M04 file declared `/pin` and `/login`, then a single
 * `router.use(authenticate, requireRole("admin"))`, then fifteen more routes. That
 * split worked because the two anonymous routes came first.
 *
 * This file declares all twenty with per-operation guards instead, in the same
 * order. The order matters in three places, all of them because Express matches
 * literally and a parameter route will happily swallow a sibling:
 *
 *   - `GET /users/agents` and `GET /users/builders` **before** `PUT /users/:id/status`
 *     and `DELETE /users/:id`. Different methods, so no actual collision — but the
 *     `GET /users/admins` sibling *does* sit under the same `GET /users` prefix and
 *     would be read as an `:id` if a parameterised `GET` were ever added.
 *   - `GET /accounts/registered|deleted|blocked` before `DELETE /accounts/:id`.
 *   - `/profile/avatar` and `/profile/logo` before nothing in particular; they are
 *     literal paths with no parameter sibling.
 *
 * `test/modules/admins.test.js` asserts the router's table equals
 * `admins.policy.POLICIES` **in order**, so a future route added in the wrong place
 * fails a test rather than shadowing a sibling.
 *
 * ## The two guards are always both or neither
 *
 * `policy.guardsFor(guards, op)` returns `[]` or `[authenticate, requireRole("admin")]`
 * together. There is no operation that is "any authenticated user" — the pre-M04
 * `router.use` did not allow it either, and allowing it now would be a new hole
 * rather than a preserved behaviour.
 */
const { Router } = require("express");

const { asyncHandler, validateBody, validateQuery } = require("../../core/http");
const { AppError } = require("../../core/errors");
const { authenticate, requireRole } = require("../../middleware/auth");
// The multer middlewares only. The storage calls go through the
// `platform/storage` port in `admins.service`, not through these re-exports.
const { uploadProfileImage, uploadLogo } = require("../../services/upload.service");

const service = require("./admins.service");
const schemas = require("./admins.schema");
const policy = require("./admins.policy");
const { Operation } = policy;

const router = Router();

/** The two shared guards, passed into the policy so it stays HTTP-free. */
const GUARDS = { authenticate, requireRole };

/**
 * The guard list for an operation, followed by any route middleware.
 *
 * @param {string} operation
 * @param {...import("express").RequestHandler} middleware
 * @returns {import("express").RequestHandler[]}
 */
function forOperation(operation, ...middleware) {
  return [...policy.guardsFor(GUARDS, operation), ...middleware];
}

/**
 * Runs a multer middleware and turns its error into a 400.
 *
 * Multer signals a rejected file through its own callback, not by throwing into the
 * route, so without this a `LIMIT_FILE_SIZE` exceedance reaches the error handler as
 * a bare `Error` with no status and becomes a 500. The pre-M04 routes had this
 * wrapper four times, and the users module has two more.
 *
 * @param {import("express").RequestHandler} middleware
 * @returns {import("express").RequestHandler}
 */
function upload(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (err) return next(new AppError(err.message || "Upload failed", 400, "UPLOAD_FAILED"));
      next();
    });
  };
}

/**
 * @param {string} field
 * @returns {import("express").RequestHandler}
 */
function requireFile(field) {
  return (req, _res, next) => {
    if (!req.file) return next(new AppError(`No ${field} file provided`, 400, "NO_FILE"));
    next();
  };
}

// ─── step 1: the PIN ────────────────────────────────────────────────────────

router.post(
  "/pin",
  ...forOperation(Operation.VERIFY_PIN, validateBody(schemas.pinSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.verifyAdminPin(req.body.pin));
  })
);

// ─── step 2: email + password ───────────────────────────────────────────────

router.post(
  "/login",
  ...forOperation(Operation.LOGIN, validateBody(schemas.adminLoginSchema)),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    res.ok(await service.adminLogin(email, password));
  })
);

// ─── own profile ────────────────────────────────────────────────────────────

router.get(
  "/profile",
  ...forOperation(Operation.GET_PROFILE),
  asyncHandler(async (req, res) => {
    res.ok(await service.getAdminProfile(req.user.id));
  })
);

router.put(
  "/profile",
  ...forOperation(Operation.UPDATE_PROFILE, validateBody(schemas.updateAdminProfileSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.updateAdminProfile(req.user.id, req.body));
  })
);

router.post(
  "/profile/avatar",
  ...forOperation(Operation.UPLOAD_AVATAR, upload(uploadProfileImage), requireFile("image")),
  asyncHandler(async (req, res) => {
    res.ok(await service.uploadAdminImage(req.user.id, req.file));
  })
);

router.delete(
  "/profile/avatar",
  ...forOperation(Operation.DELETE_AVATAR),
  asyncHandler(async (req, res) => {
    res.ok(await service.removeAdminImage(req.user.id));
  })
);

router.post(
  "/profile/logo",
  ...forOperation(Operation.UPLOAD_LOGO, upload(uploadLogo), requireFile("logo")),
  asyncHandler(async (req, res) => {
    res.ok(await service.uploadAdminLogo(req.user.id, req.file));
  })
);

router.delete(
  "/profile/logo",
  ...forOperation(Operation.DELETE_LOGO),
  asyncHandler(async (req, res) => {
    res.ok(await service.removeAdminLogo(req.user.id));
  })
);

router.put(
  "/profile/links",
  ...forOperation(Operation.UPDATE_LINKS, validateBody(schemas.adminLinksSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.updateAdminSocialLinks(req.user.id, req.body));
  })
);

router.put(
  "/profile/password",
  ...forOperation(Operation.CHANGE_PASSWORD, validateBody(schemas.adminPasswordSchema)),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    res.ok(await service.changeAdminPassword(req.user.id, currentPassword, newPassword));
  })
);

// ─── user lists ─────────────────────────────────────────────────────────────

router.get(
  "/users",
  ...forOperation(Operation.LIST_USERS, validateQuery(schemas.listUsersQuerySchema)),
  asyncHandler(async (req, res) => {
    const { type, page, limit } = req.query;
    res.paginated(await service.listUsers(type, { page: Number(page), limit: Number(limit) }));
  })
);

// The two filtered variants are `listUsers` with the type pinned. The pre-M04 routes
// each re-derived `page` and `limit` by hand with `Number(x) || 1` — no schema, no
// cap — so `?limit=100000` was a full table scan on these two while `/users` was
// capped at 100. They share `listUsersQuerySchema` now, so they are capped too.
router.get(
  "/users/agents",
  ...forOperation(Operation.LIST_AGENTS, validateQuery(schemas.listUsersQuerySchema)),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.paginated(await service.listUsers("Agent", { page: Number(page), limit: Number(limit) }));
  })
);

router.get(
  "/users/builders",
  ...forOperation(Operation.LIST_BUILDERS, validateQuery(schemas.listUsersQuerySchema)),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.paginated(await service.listUsers("Builder", { page: Number(page), limit: Number(limit) }));
  })
);

router.get(
  "/users/admins",
  ...forOperation(Operation.LIST_ADMINS),
  asyncHandler(async (_req, res) => {
    // Not paginated — the legacy response is a bare array with no `pagination` key.
    res.ok(await service.listAdmins());
  })
);

// ─── user status ────────────────────────────────────────────────────────────

router.put(
  "/users/:id/status",
  ...forOperation(Operation.SET_USER_STATUS, validateBody(schemas.statusSchema)),
  asyncHandler(async (req, res) => {
    const userId = policy.parseId(req.params, "Invalid user ID");

    // The four actions are four unrelated operations on four different flags — see
    // `schemas.statusSchema`. The dispatch is a lookup rather than a `switch` so that
    // an unhandled action is impossible: `statusSchema` is a four-value enum, and a
    // default branch would be dead code pretending to be a fallback.
    const ACTIONS = {
      activate: (id) => service.setUserActive(id, true),
      deactivate: (id) => service.setUserActive(id, false),
      freeze: service.adminFreezeUser,
      unfreeze: service.adminUnfreezeUser,
    };

    res.ok(await ACTIONS[req.body.action](userId));
  })
);

router.delete(
  "/users/:id",
  ...forOperation(Operation.DELETE_USER),
  asyncHandler(async (req, res) => {
    res.ok(await service.adminDeleteUser(policy.parseId(req.params, "Invalid user ID")));
  })
);

// ─── account screens ────────────────────────────────────────────────────────
//
// Implemented in `modules/accounts`; the URLs are part of the frozen route table, so
// they live here. `admins.service` re-exports the four capabilities in one block.

router.get(
  "/accounts/registered",
  ...forOperation(Operation.LIST_REGISTERED, validateQuery(schemas.adminPaginationQuery)),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.paginated(await service.listRegisteredAccounts({ page: Number(page), limit: Number(limit) }));
  })
);

router.get(
  "/accounts/deleted",
  ...forOperation(Operation.LIST_DELETED, validateQuery(schemas.adminPaginationQuery)),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.paginated(await service.listDeletedAccounts({ page: Number(page), limit: Number(limit) }));
  })
);

router.get(
  "/accounts/blocked",
  ...forOperation(Operation.LIST_BLOCKED, validateQuery(schemas.adminPaginationQuery)),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query;
    res.paginated(await service.listBlockedAccounts({ page: Number(page), limit: Number(limit) }));
  })
);

router.delete(
  "/accounts/:id",
  ...forOperation(Operation.DELETE_ACCOUNT_RECORD),
  asyncHandler(async (req, res) => {
    res.ok(await service.deleteAccountRecord(policy.parseId(req.params, "Invalid record ID")));
  })
);

module.exports = router;
