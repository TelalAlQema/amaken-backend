/**
 * Request correlation.
 *
 * One id per request, from the first line of the log to the last, plus the
 * `X-Request-Id` response header so a browser network panel or a support ticket
 * can be matched to server lines.
 *
 * An inbound `X-Request-Id` is honoured: behind a load balancer or an API
 * gateway the id is minted upstream, and re-minting it would break the chain
 * across the whole estate. It is still length-capped and character-filtered,
 * because an unvalidated header reflected into a log line is a log-injection
 * vector (`\n` in a header would forge a line).
 */
const { randomUUID } = require("node:crypto");

const MAX_ID_LENGTH = 200;
const SAFE_ID = /^[A-Za-z0-9._:@+/=-]+$/;

/**
 * @param {unknown} candidate
 * @returns {string | null} the id to reuse, or `null` to mint a new one.
 */
function acceptInboundId(candidate) {
  if (typeof candidate !== "string") return null;
  const id = candidate.trim();
  if (id === "" || id.length > MAX_ID_LENGTH) return null;
  return SAFE_ID.test(id) ? id : null;
}

/**
 * Generates (or adopts) the id, then stores it where the rest of the stack can
 * find it: `req.id` for handlers, `res.locals.id` for the error handler, and the
 * response header for the client.
 *
 * `pino-http` is configured with `genReqId: (req) => req.id`, so it picks this
 * up rather than minting a second one — that is the only reason the two
 * middlewares can coexist.
 *
 * @param {{ header?: string }} [options]
 * @returns {import("express").RequestHandler}
 */
function requestId(options = {}) {
  const header = (options.header || "x-request-id").toLowerCase();

  return function attachRequestId(req, res, next) {
    const inbound = req.headers ? req.headers[header] : undefined;
    const id = acceptInboundId(inbound) || randomUUID();

    req.id = id;
    res.locals = res.locals || {};
    res.locals.id = id;
    res.setHeader("X-Request-Id", id);

    next();
  };
}

module.exports = { requestId, acceptInboundId, MAX_ID_LENGTH };
