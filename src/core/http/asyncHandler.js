/**
 * Wraps an async route handler so a rejected promise reaches the error handler.
 *
 * Express 4 does not await route handlers: an `async` handler that throws
 * produces an unhandled rejection and the request hangs until the client times
 * out. That is why every one of the ~70 handlers today carries the same five
 * lines:
 *
 *     try { … } catch (err) { next(err) }
 *
 * This removes the boilerplate without changing what happens on failure —
 * `next(err)` is exactly what the `catch` did, so the global `errorHandler`
 * still sees the same error object.
 *
 *     router.get(
 *       "/:id",
 *       authenticate,
 *       asyncHandler(async (req, res) => {
 *         res.ok(await propertyService.getById(Number(req.params.id)));
 *       })
 *     );
 *
 * Synchronous throws are covered too: they happen while `fn` is being invoked,
 * inside the same `try`.
 *
 * @param {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => unknown} fn
 * @returns {import("express").RequestHandler}
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === "function") {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { asyncHandler };
