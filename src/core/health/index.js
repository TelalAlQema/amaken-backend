/**
 * `core/health` — liveness and readiness probes.
 *
 * @see ./routes.js for why liveness must check nothing and readiness must check
 *   everything.
 */
const routes = require("./routes");

module.exports = routes;
