/**
 * The nine `/api/auth` endpoints.
 *
 * Every handler is the same four lines — validate, delegate, respond — and none of
 * them has a `try/catch`. That is the point of the move: the pre-M03 file wrapped
 * all nine in `try { … } catch (err) { next(err) }`, which is what Express already
 * does for a rejected promise from an `async` handler, so each block was nine
 * chances to write `catch (err) { next(new Error(err.message)) }` and flatten the
 * status code. `asyncHandler` does it once, correctly.
 *
 * Status codes, envelopes and payload shapes are pinned by
 * `test/contract/auth.test.js` and `test/contract/route-parity.test.js`. Neither
 * file was edited.
 */
const { Router } = require("express");

const { asyncHandler, validateBody } = require("../../core/http");

const service = require("./auth.service");
const schemas = require("./auth.schema");
const policy = require("./auth.policy");
const { Operation } = policy;

const router = Router();

/**
 * `/logout` is the only endpoint that reads a credential out of the request, and
 * the only one that tolerates its absence.
 *
 * It does **not** use `authenticate`: the old route had no middleware at all, and
 * requiring a valid access token would turn "log me out" into a 401 for anyone
 * whose access token had already expired — which is most people trying to log out.
 * The token is therefore read opportunistically and passed to the service, which
 * revokes it if it is real.
 */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim() || undefined;
}

// ─── registration ──────────────────────────────────────────────────────────

router.post(
  "/register",
  ...policy.forOperation(Operation.REGISTER, validateBody(schemas.registerSchema)),
  asyncHandler(async (req, res) => {
    res.created(await service.completeRegistration(req.body));
  })
);

// ─── sign in / out ─────────────────────────────────────────────────────────

router.post(
  "/login",
  ...policy.forOperation(Operation.LOGIN, validateBody(schemas.loginSchema)),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    res.ok(await service.loginUser(email, password));
  })
);

router.post(
  "/logout",
  ...policy.forOperation(Operation.LOGOUT),
  (req, res) => {
    res.ok(service.logout(bearerToken(req)));
  }
);

// ─── email verification ────────────────────────────────────────────────────

router.post(
  "/verify-email",
  ...policy.forOperation(Operation.VERIFY_EMAIL, validateBody(schemas.verifyEmailSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.sendVerificationOtp(req.body.email));
  })
);

router.post(
  "/verify-otp",
  ...policy.forOperation(Operation.VERIFY_OTP, validateBody(schemas.verifyOtpSchema)),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    res.ok(await service.verifyRegistrationOtp(email, code));
  })
);

// ─── password reset ────────────────────────────────────────────────────────

router.post(
  "/forgot-password",
  ...policy.forOperation(Operation.FORGOT_PASSWORD, validateBody(schemas.forgotPasswordSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.sendForgotPasswordOtp(req.body.email));
  })
);

router.post(
  "/verify-forgot-otp",
  ...policy.forOperation(Operation.VERIFY_FORGOT_OTP, validateBody(schemas.verifyForgotOtpSchema)),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    res.ok(await service.verifyForgotPasswordOtp(email, code));
  })
);

router.post(
  "/reset-password",
  ...policy.forOperation(Operation.RESET_PASSWORD, validateBody(schemas.resetPasswordSchema)),
  asyncHandler(async (req, res) => {
    const { email, resetToken, password } = req.body;
    res.ok(await service.resetPassword(email, resetToken, password));
  })
);

// ─── session ───────────────────────────────────────────────────────────────

router.post(
  "/refresh",
  ...policy.forOperation(Operation.REFRESH, validateBody(schemas.refreshSchema)),
  asyncHandler(async (req, res) => {
    res.ok(await service.refreshTokens(req.body.refreshToken));
  })
);

module.exports = router;