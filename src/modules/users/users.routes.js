/**
 * The fourteen `/api/users` endpoints.
 *
 * ## What M04 changed
 *
 * **One: `GET /:id` is public.** It was behind the file-wide `router.use(authenticate)`
 * and returned 401 without a token; M00 finding 4 says a property listing has to
 * render its owner's name and avatar for an anonymous visitor, and M04's Definition
 * of Done requires it. `test/contract/public.test.js` previously asserted the 401
 * and has been inverted.
 *
 * Making one route public meant the mount-level guard had to go, because there was
 * no way to exempt a single route from a `router.use`. Every endpoint now declares
 * its own principal in `users.policy.js`.
 *
 * **Two: the `try/catch` blocks are gone.** All fourteen handlers are the same
 * validate-delegate-respond shape, and each one was nine chances to write
 * `catch (err) { next(new Error(err.message)) }` and flatten the status code.
 * `asyncHandler` does it once. Pinned by `test/contract/user.test.js`, which was
 * not edited.
 *
 * ## The IDOR that is still here
 *
 * `POST /block/:id` and `POST /unblock/:id` take the id from the **path**, not from
 * the token, so any authenticated user can freeze or un-freeze any account. M04's
 * note claims this was fixed in M00 step 0.6. It was not: `user.routes.js:227`
 * passed `targetId` through unchanged, and `test/contract/user.test.js` asserts the
 * vulnerable outcome — 200, and the *victim's* `adminblock` flipped.
 *
 * It is preserved here deliberately. M04's Definition of Done does not list the
 * fix, the change makes a frozen response a 404 for existing callers, and M00.6
 * owns it. The test stays as the tripwire: when 0.6 lands, that test is the thing
 * that has to change, and it will fail loudly if the fix is forgotten.
 *
 * ## Route order
 *
 * `/:id` is declared **last**. Express matches in declaration order, so `/me` would
 * otherwise be swallowed by `/:id` — and `parseInt("me")` is `NaN`, which would turn
 * every profile read into a 400.
 */
const { Router } = require("express");

const { asyncHandler, validateBody } = require("../../core/http");
const { AppError } = require("../../core/errors");
const { authenticate } = require("../../middleware/auth");
// The multer middlewares only. `services/upload.service.js` also re-exports
// `processAndSaveImage` / `deleteFileIfExists` / `getUserUploadDir` / `getFilePath`,
// which this module deliberately does **not** use — `users.service` calls the
// `platform/storage` port directly, which is what those four existed to be replaced
// by. Only the HTTP concern (parsing a multipart body) comes from here.
const { uploadProfileImage, uploadLogo } = require("../../services/upload.service");

const service = require("./users.service");
const schemas = require("./users.schema");
const policy = require("./users.policy");
const { Operation } = policy;

const router = Router();

/**
 * Runs a multer middleware and turns its error into a 400.
 *
 * Multer reports a rejected file through its own callback — a `LIMIT_FILE_SIZE`
 * exceedance is not an exception thrown into the route — so without this the
 * failure reaches the error handler as a bare `Error` with no status and becomes a
 * 500. The pre-M04 routes had this exact wrapper four times.
 *
 * The field name is `"image"` in both `.single()` calls, and it must match the
 * FormData key the client sends. The avatar page and the logo page both post
 * `image`; changing either without the other is a silent "No image file provided".
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
 * Rejects an empty multipart body with the endpoint's own wording.
 *
 * @param {string} field the human name, for the message
 * @returns {import("express").RequestHandler}
 */
function requireFile(field) {
  return (req, _res, next) => {
    if (!req.file) return next(new AppError(`No ${field} file provided`, 400, "NO_FILE"));
    next();
  };
}

/**
 * `policy.forOperation` + `policy.guardsFor` in one call, so a route cannot be
 * declared without its guard.
 *
 * The guard list comes first, then the body validator — an unauthenticated request
 * with an invalid body is a 401, not a 400, and does not reach the validator.
 */
function forOperation(operation, ...middleware) {
  return [...policy.guardsFor(authenticate, operation), ...middleware];
}

// ─── own profile ────────────────────────────────────────────────────────────

router.get(
  "/me",
  ...forOperation(Operation.GET_PROFILE),
  asyncHandler(async (req, res) => {
    res.ok(await service.getProfile(req.user.id));
  })
);

router.put(
  "/me",
  ...forOperation(Operation.UPDATE_PROFILE, validateBody(schemas.updateProfileSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.updateProfile(req.user.id, req.body));
  })
);

// ─── avatar ─────────────────────────────────────────────────────────────────
//
// 2MB in, stored at 400×400.

router.post(
  "/me/avatar",
  ...forOperation(Operation.UPLOAD_AVATAR, upload(uploadProfileImage), requireFile("image")),
  asyncHandler(async (req, res) => {
    res.ok(await service.uploadProfileImage(req.user.id, req.file));
  })
);

router.delete(
  "/me/avatar",
  ...forOperation(Operation.DELETE_AVATAR),
  asyncHandler(async (req, res) => {
    res.ok(await service.removeProfileImage(req.user.id));
  })
);

// ─── company logo ───────────────────────────────────────────────────────────
//
// 5MB in, stored at 500×500.

router.post(
  "/me/logo",
  ...forOperation(Operation.UPLOAD_LOGO, upload(uploadLogo), requireFile("logo")),
  asyncHandler(async (req, res) => {
    res.ok(await service.uploadCompanyLogo(req.user.id, req.file));
  })
);

router.delete(
  "/me/logo",
  ...forOperation(Operation.DELETE_LOGO),
  asyncHandler(async (req, res) => {
    res.ok(await service.removeCompanyLogo(req.user.id));
  })
);

// ─── password ───────────────────────────────────────────────────────────────

router.put(
  "/me/password",
  ...forOperation(Operation.CHANGE_PASSWORD, validateBody(schemas.changePasswordSchema)),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    res.ok(await service.changePassword(req.user.id, currentPassword, newPassword));
  })
);

// ─── social links ───────────────────────────────────────────────────────────

router.put(
  "/me/links",
  ...forOperation(Operation.UPDATE_LINKS, validateBody(schemas.socialLinksSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.updateSocialLinks(req.user.id, req.body));
  })
);

// ─── activation ─────────────────────────────────────────────────────────────

router.post(
  "/me/deactivate",
  ...forOperation(Operation.DEACTIVATE),
  asyncHandler(async (req, res) => {
    res.ok(await service.deactivateAccount(req.user.id));
  })
);

router.post(
  "/me/activate",
  ...forOperation(Operation.ACTIVATE),
  asyncHandler(async (req, res) => {
    res.ok(await service.activateAccount(req.user.id));
  })
);

router.delete(
  "/me",
  ...forOperation(Operation.DELETE_ACCOUNT),
  asyncHandler(async (req, res) => {
    res.ok(await service.deleteAccount(req.user.id));
  })
);

// ─── freeze ─────────────────────────────────────────────────────────────────
//
// `targetId` from the path. The IDOR described in the file header, preserved on
// purpose — M00.6.

router.post(
  "/block/:id",
  ...forOperation(Operation.BLOCK),
  asyncHandler(async (req, res) => {
    res.ok(await service.blockSelf(policy.parseUserId(req.params)));
  })
);

router.post(
  "/unblock/:id",
  ...forOperation(Operation.UNBLOCK),
  asyncHandler(async (req, res) => {
    res.ok(await service.unblockSelf(policy.parseUserId(req.params)));
  })
);

// ─── public profile ─────────────────────────────────────────────────────────
//
// Last, so `/me` and `/block/:id` are matched before the wildcard. No `authenticate`
// — see the file header.

router.get(
  "/:id",
  ...forOperation(Operation.PUBLIC_PROFILE),
  asyncHandler(async (req, res) => {
    res.ok(await service.getPublicProfile(policy.parseUserId(req.params)));
  })
);

module.exports = router;