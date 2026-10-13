/**
 * `core/observability` — Prometheus registry, request metrics, scrape route.
 *
 * Knows nothing about any module. The route pattern is the only label that
 * identifies a handler, and it comes from Express, so adding an endpoint to a
 * module cannot break the metrics.
 */
const metrics = require("./metrics");
const { metricsHandler } = require("./routes");

module.exports = { ...metrics, metricsHandler };
