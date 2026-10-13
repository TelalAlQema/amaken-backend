/**
 * `GET /metrics` — the Prometheus scrape endpoint.
 *
 * Deliberately **not** enveloped. A scraper parses the Prometheus text format;
 * wrapping it in `{ success: true, data: … }` would make it unparseable, exactly
 * as `envelope.md` records for `/health` and the leads TSV export.
 *
 * Unauthenticated, like every other monitoring endpoint in the ecosystem, which
 * means it must not sit on a public hostname without a network policy in front
 * of it. What it exposes is route patterns and status counts — no user data, no
 * query strings, no auth headers — so the exposure is a traffic-shape
 * disclosure, not a data leak. `METRICS_ENABLED=false` removes the route
 * entirely; it is not a runtime toggle.
 */
const { registry, contentType, refreshGauges } = require("./metrics");

/**
 * A single handler rather than a `Router`: `/metrics` is one path, and mounting
 * a router under `/metrics` makes it appear in the route table as `/metrics/`
 * with a trailing slash — a needless difference from `/health` for anything
 * diffing the two, including `test/contract/route-parity.test.js`.
 *
 * @param {{ prefix?: string }} [options]
 * @returns {import("express").RequestHandler}
 */
function metricsHandler(options = {}) {
  return async function scrape(_req, res) {
    // Refresh before serialising, not after: a scrape that reports the previous
    // interval's queue depth is worse than one that takes 20ms longer, because
    // the timestamp on the sample looks current either way.
    try {
      await refreshGauges(options);
    } catch {
      // A gauge refresh must never fail the scrape — see refreshGauges.
    }

    res.set("Content-Type", contentType);
    res.send(await registry.metrics());
  };
}

module.exports = { metricsHandler };
