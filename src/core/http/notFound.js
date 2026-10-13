/**
 * The terminal 404.
 *
 * Mounted after every router and before `errorHandler`. Without it Express
 * replies with its own HTML error page, which is not the envelope, and
 * `test/contract/route-parity.test.js` asserts the shape.
 *
 *     { success: false, error: { message: "Route not found" } }
 *
 * No `code` on purpose: an unmatched path is not a domain error, and the
 * frontend's reauth logic does not branch on it.
 *
 * @type {import("express").RequestHandler}
 */
function notFound(_req, res) {
  res.status(404).json({
    success: false,
    error: { message: "Route not found" },
  });
}

module.exports = { notFound };
