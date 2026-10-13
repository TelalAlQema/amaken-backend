/**
 * Prometheus metrics.
 *
 * The process emits nothing measurable today — there is no request duration, no
 * status counter, and no way to tell a slow endpoint from a fast one under
 * load. M02 adds the pool gauge and the rate-limit counter; the three metrics
 * below are the ones that make the rest interpretable, because a latency
 * histogram with no route label is a single number describing every endpoint at
 * once.
 *
 * Cardinality is the hazard. `method`, `route` (the *path pattern*, not the
 * concrete URL) and `status` are bounded. `req.url` is not — a `?id=…` query
 * would mint a new time series per request and OOM the process. So the route
 * label comes from the matched Express pattern, never from the URL.
 *
 * Note: this is `@prometheus-io/client`, the maintained package. The
 * `prom-client` name in the M01 plan is deprecated in favour of it and has no
 * published replacement under the old name.
 */
const { Counter, Gauge, Histogram, Registry, collectDefaultMetrics, contentType } =
  require("@prometheus-io/client");

const config = require("../../config");

/** @type {Registry} */
const registry = new Registry();

/**
 * Rate-limit stores this build can report, one-hot in
 * `{prefix}_rate_limit_store_info`.
 *
 * `redis` stays in the list even though nothing constructs it any more. The gauge is
 * a one-hot encoding: a Prometheus dashboard built against a build that still had
 * `redis` as a series keeps working (it reads 0) instead of going blank the moment
 * the code is deployed, which is when someone is looking at the dashboard.
 */
const RATE_LIMIT_STORES = Object.freeze(["memory", "redis"]);

/**
 * Process and GC metrics. `prefix` keeps them from colliding with another
 * service's series in a shared Prometheus.
 */
let defaultMetricsStarted = false;

/**
 * Buckets chosen for a JSON API behind an ALB: the interesting boundary is
 * "did the user see a spinner", which is around a second, not around ten.
 */
const DURATION_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

/**
 * Lazily built on first `getMetrics()` call, so a process that never serves a
 * request (a migration script, a one-shot CLI) does not register series it will
 * never write.
 *
 * @param {{ prefix?: string }} [options]
 */
function buildMetrics(options = {}) {
  const prefix = options.prefix || "amaken_api";

  return {
    /** Request duration in seconds, labelled by route pattern. */
    requestDuration: new Histogram({
      name: `${prefix}_http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status"],
      buckets: [...DURATION_BUCKETS],
      registers: [registry],
    }),

    /** Request count, labelled by route pattern and status class. */
    requestsTotal: new Counter({
      name: `${prefix}_http_requests_total`,
      help: "Total HTTP requests",
      labelNames: ["method", "route", "status"],
      registers: [registry],
    }),

    /** Unhandled errors that reached the global error handler. */
    errorsTotal: new Counter({
      name: `${prefix}_http_errors_total`,
      help: "Errors that reached the global error handler",
      labelNames: ["code"],
      registers: [registry],
    }),

    /** 1 = up, 0 = down. The metric a `up == 0` alert is built on. */
    up: new Gauge({
      name: `${prefix}_up`,
      help: "1 when the process is serving requests",
      registers: [registry],
    }),

    // ── added in M02 ──────────────────────────────────────────────────────

    /**
     * MySQL connections in use, against the pool's ceiling.
     *
     * The single most useful saturation metric in the process: `max_connections`
     * is a **server-wide** setting, so ten replicas each with a pool of 10 will
     * exhaust a default MySQL 8 install (151) and start refusing connections
     * application-wide. Nothing else in the metrics shows that happening.
     */
    dbPoolConnections: new Gauge({
      name: `${prefix}_db_pool_connections`,
      help: "MySQL connections currently open in the Prisma pool",
      labelNames: ["state"],
      registers: [registry],
    }),

    // There is deliberately no `db_pool_max_connections` gauge.
    //
    // It was here to make saturation legible — a pool at 90% of 10 is an incident,
    // and the same 90% of 100 is not — and that reasoning is sound. But Prisma does
    // not report a ceiling at runtime: `$metrics()` exposes only open/busy/idle, and
    // the limit comes from `connection_limit` in `DATABASE_URL`. So the gauge could
    // never hold a measured value, and an unmeasured ceiling is worse than none —
    // it reads as the safety limit that prevents the pool growing, which is exactly
    // what an operator would assume. Derive saturation from `connection_limit`
    // alongside these gauges, or alert on `state="idle"` hitting 0, which is the
    // point at which the pool is genuinely full.

    /**
     * Rate limit rejections. Labelled by which limiter.
     *
     * Non-zero is not automatically bad — it means the limiter is working. What
     * matters is the *rate of change* and whether it clusters on one IP, which
     * is a credential-stuffing signature rather than a busy day.
     */
    rateLimitHits: new Counter({
      name: `${prefix}_rate_limit_hits_total`,
      help: "Requests rejected by the rate limiter",
      labelNames: ["limiter"],
      registers: [registry],
    }),

    /**
     * Which limiter store is in force, as a 0/1 series per store.
     *
     * A gauge rather than a label because the store is chosen at boot from config
     * and cannot change without a restart — so it is constant information, and a
     * constant *label* would multiply every rate-limit series for no gain. Recorded
     * because "the rate limiter is in-memory" is the constraint most likely to be
     * forgotten once a second replica exists, and it should be visible in the
     * dashboard rather than only in the runbook.
     */
    rateLimitStore: new Gauge({
      name: `${prefix}_rate_limit_store_info`,
      help: "1 for the rate-limit store in force on this replica",
      labelNames: ["store"],
      registers: [registry],
    }),

    /**
     * Jobs waiting to be claimed, by queue and status.
     *
     * `waiting` is the number an operator wants: it is the depth of the backlog the
     * worker is falling behind by. `active` and `delayed` are separate series
     * because they mean different things — `active` is work in progress (bounded by
     * `QUEUE_CONCURRENCY`, so a rising `active` with no rising `waiting` is normal
     * throughput) and `delayed` is the retry schedule.
     *
     * `failed` is the dead-letter count and is the series worth alerting on.
     */
    queueWaiting: new Gauge({
      name: `${prefix}_queue_jobs`,
      help: "Jobs in the MySQL queue by queue and status",
      labelNames: ["queue", "status"],
      registers: [registry],
    }),

    /**
     * Total across all queues and statuses.
     *
     * Derived from the same query as `queueWaiting` rather than summed from it in
     * Prometheus, so a scrape that could not reach the database does not publish a
     * misleading 0 — see `refreshGauges`. This is the series to put on a graph
     * behind an alert when the per-queue breakdown is not needed.
     */
    queueBacklog: new Gauge({
      name: `${prefix}_queue_backlog_total`,
      help: "Total jobs across all queues, excluding completed",
      registers: [registry],
    }),

    /** Job outcomes, labelled by queue and terminal status. */
    queueJobsTotal: new Counter({
      name: `${prefix}_queue_jobs_total`,
      help: "Queue job outcomes by queue and result",
      labelNames: ["queue", "result"],
      registers: [registry],
    }),

    /**
     * Enqueues that could not be written.
     *
     * The metric that makes the queue's fail-open policy observable. A non-zero
     * rate means emails are not being scheduled — the API has returned `200` to
     * users who will never receive them. This is the only signal for that, which is
     * why fail-open without this counter is unacceptable.
     */
    queueEnqueueErrors: new Counter({
      name: `${prefix}_queue_enqueue_errors_total`,
      help: "Enqueues that failed; the queue fails open, so this is the only trace",
      labelNames: ["queue"],
      registers: [registry],
    }),

    /** Dependency reachability. Registered here so `/metrics` and `/health/ready` cannot disagree. */
    dependencyUp: new Gauge({
      name: `${prefix}_dependency_up`,
      help: "1 when a dependency is reachable, 0 otherwise",
      labelNames: ["dependency"],
      registers: [registry],
    }),
  };
}

/** @type {ReturnType<typeof buildMetrics> | null} */
let metrics = null;

/**
 * @param {{ prefix?: string, collectDefaults?: boolean }} [options]
 */
function getMetrics(options = {}) {
  if (!metrics) {
    metrics = buildMetrics(options);
    metrics.up.set(1);
  }

  if (options.collectDefaults && !defaultMetricsStarted) {
    collectDefaultMetrics({ register: registry, prefix: `${options.prefix || "amaken_api"}_` });
    defaultMetricsStarted = true;
  }

  return metrics;
}

/**
 * Records one completed request. Called from the terminal middleware in
 * `src/app.js`, after the route has matched, so `req.route.path` is the pattern
 * (`/api/properties/:id`) rather than the URL.
 *
 * Exported directly so `errorHandler` can count an error without duplicating
 * the label set.
 *
 * @param {object} params
 * @param {string} params.method
 * @param {string} params.route
 * @param {number} params.status
 * @param {number} params.durationSeconds
 * @param {{ prefix?: string }} [params.options]
 */
function observeRequest({ method, route, status, durationSeconds }, options = {}) {
  const m = getMetrics(options);
  const labels = { method, route, status: String(status) };
  m.requestDuration.observe(labels, durationSeconds);
  m.requestsTotal.inc(labels);
}

/**
 * @param {string} code `ErrorCode` value, or `"UNKNOWN"`.
 * @param {{ prefix?: string }} [options]
 */
function countError(code, options = {}) {
  getMetrics(options).errorsTotal.inc({ code: code || "UNKNOWN" });
}

/**
 * Records a rate-limit rejection.
 *
 * @param {{ limiter: string }} params
 * @param {{ prefix?: string }} [options]
 */
function countRateLimitHit({ limiter }, options = {}) {
  getMetrics(options).rateLimitHits.inc({ limiter: limiter || "unknown" });
}

/**
 * Records a dependency transition. Called by the health probes, so `/health/ready`
 * and `/metrics` can never disagree about whether MySQL is up.
 *
 * @param {string} name `"mysql"` or `"storage"`
 * @param {boolean} ok
 * @param {{ prefix?: string }} [options]
 */
function setDependencyUp(name, ok, options = {}) {
  getMetrics(options).dependencyUp.set({ dependency: name }, ok ? 1 : 0);
}

/**
 * Records a terminal queue outcome.
 *
 * `result` is one of `"completed"`, `"failed"` (dead-lettered) or `"retried"`. The
 * `retried` count is worth having separately from `failed`, because a queue that
 * fails everything but keeps retrying looks healthy on a `failed` alert while
 * delivering nothing.
 *
 * @param {{ queue: string, result: "completed" | "failed" | "retried" }} params
 * @param {{ prefix?: string }} [options]
 */
function countQueueJob({ queue, result }, options = {}) {
  getMetrics(options).queueJobsTotal.inc({ queue: queue || "unknown", result: result || "unknown" });
}

/**
 * Records an enqueue that could not be written. The counterpart to the queue's
 * fail-open policy: the request succeeded, the background job does not exist, and
 * this counter is the only evidence.
 *
 * @param {{ queue: string }} params
 * @param {{ prefix?: string }} [options]
 */
function countQueueEnqueueError({ queue }, options = {}) {
  getMetrics(options).queueEnqueueErrors.inc({ queue: queue || "unknown" });
}

/**
 * Publishes the in-force rate-limit store.
 *
 * Sets the new store to 1 and every other known store to 0, so the series stays a
 * one-hot encoding rather than accumulating a 1 per store the process has ever
 * used — which would make a dashboard read as though several were active.
 *
 * @param {string} storeName
 * @param {{ prefix?: string, knownStores?: string[] }} [options]
 */
function setRateLimitStore(storeName, options = {}) {
  const m = getMetrics(options);
  const stores = options.knownStores || RATE_LIMIT_STORES;

  for (const store of stores) {
    m.rateLimitStore.set({ store }, store === storeName ? 1 : 0);
  }
}

/**
 * Records the pool's occupancy. Split by state because the numbers mean different
 * things: `open` is how much of the server's ceiling this replica has claimed, and
 * `in_use` is how much of that is actually busy. A high `open` with a low `in_use`
 * is an over-provisioned pool, not a saturated one.
 *
 * ## Why this normalises instead of reading fields directly
 *
 * Prisma 5 does **not** return `{ open, inUse, idle }`. `$metrics()` returns
 * `{ pool: { connections, active_connections, idle_connections, max }, … }`, and
 * the key names differ per driver and per Prisma version. Reading `pool.open` off
 * that object yields `undefined`, `Number(undefined || 0)` yields `0`, and the
 * gauge reports a healthy, idle, perfectly-sized pool forever — while the real one
 * is exhausted. A metrics bug that reports success is worse than no metric.
 *
 * So the accepted shapes are enumerated, and an unrecognised one is reported once
 * at `warn` rather than being silently rendered as zeros.
 *
 * @param {object} metrics the raw `$metrics()` result, or a pre-normalised
 *   `{ open, inUse, idle }` for tests.
 * @param {{ prefix?: string }} [options]
 */
function setDbPool(metrics = {}, options = {}) {
  const m = getMetrics(options);
  const pool = normalisePoolStats(metrics);

  m.dbPoolConnections.set({ state: "open" }, pool.open);
  m.dbPoolConnections.set({ state: "in_use" }, pool.inUse);
  m.dbPoolConnections.set({ state: "idle" }, pool.idle);

  // `dbPoolMax` is deliberately never set. Prisma does not report a pool ceiling at
  // runtime — it is `connection_limit` in `DATABASE_URL` — so any value here would be
  // invented, and an invented ceiling is worse than none: it looks like the safety
  // limit that stops the pool growing, which is precisely the belief an operator
  // would draw from it. The gauge is not registered at all, so the name is absent
  // from the scrape rather than reading 0.

  return pool;
}

/** @type {boolean} set once a shape warning has been emitted, to avoid log spam. */
let warnedPoolShape = false;

/**
 * Takes the pool gauges out of the scrape.
 *
 * Called when `$metrics()` cannot be read. A Gauge is born holding 0, so a pool
 * gauge that is never set reports `db_pool_connections{state="open"} 0` and
 * `db_pool_max_connections 0` — indistinguishable from an idle pool with a ceiling
 * of zero, and both absurd. Resetting removes the series, so PromQL returns nothing
 * instead of a number nobody measured.
 *
 * The absence is the signal, and it is meant to be noticed: the alternative is a
 * dashboard that looks calm through a total inability to see the pool.
 *
 * @param {object} [options]
 */
function clearDbPool(options = {}) {
  // `remove()` per label value, not `reset()`. Both drop the samples for a labelled
  // Gauge, but `reset()` relies on a prom-client implementation detail that the
  // unlabeled gauges above do not get; `remove()` deletes the series outright and is
  // safe to call on values that were never set.
  const pool = getMetrics(options).dbPoolConnections;
  for (const state of ["open", "in_use", "idle"]) pool.remove(state);
}

/**
 * Flattens `$metrics()` into `{ open, inUse, idle, max }`.
 *
 * @param {object} metrics
 * @returns {{ open: number, inUse: number, idle: number, max: number }}
 */
function normalisePoolStats(metrics) {
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  // Already normalised — `server.js`'s own type, and the shape tests use.
  if (Number.isFinite(Number(metrics.open)) || Number.isFinite(Number(metrics.inUse))) {
    return {
      open: num(metrics.open),
      inUse: num(metrics.inUse),
      idle: num(metrics.idle),
      max: num(metrics.max),
    };
  }

  // Prisma 5: `{ pool: { connections, active_connections, idle_connections, max } }`.
  const pool = metrics && metrics.pool;
  if (pool && typeof pool === "object") {
    return {
      open: num(pool.connections ?? pool.open),
      inUse: num(pool.active_connections ?? pool.in_use ?? pool.inUse),
      idle: num(pool.idle_connections ?? pool.idle),
      max: num(pool.max),
    };
  }

  // A bare `{ connections, active_connections, idle_connections }` — Prisma 4, and
  // what `libraryEngine` returns on some drivers.
  if (metrics && typeof metrics === "object" && metrics.connections !== undefined) {
    return {
      open: num(metrics.connections),
      inUse: num(metrics.active_connections),
      idle: num(metrics.idle_connections),
      max: num(metrics.max),
    };
  }

  // Prisma 5.22 — what `$metrics.json()` actually returns, verified against the
  // driver rather than assumed: `{ counters, gauges, histograms }`, each an array of
  // `{ key, labels, value }`. This is checked against the real output because the
  // branch above it describes a `{ pool: {...} }` shape that **5.22 does not
  // produce**, and a test asserting that shape passes forever while the gauges read
  // zero in production.
  if (metrics && Array.isArray(metrics.gauges)) {
    const gauge = {};
    for (const entry of metrics.gauges) {
      if (entry && typeof entry.key === "string") gauge[entry.key] = num(entry.value);
    }
    return {
      open: num(gauge.prisma_pool_connections_open),
      inUse: num(gauge.prisma_pool_connections_busy),
      idle: num(gauge.prisma_pool_connections_idle),
      // Deliberately 0. There is no `max` in this payload — the pool ceiling comes
      // from `connection_limit` in `DATABASE_URL` and Prisma does not report it at
      // runtime. Returning 0 keeps `dbPoolMax` unset rather than invented; see
      // `setDbPool`.
      max: 0,
    };
  }

  if (!warnedPoolShape) {
    warnedPoolShape = true;
    // eslint-disable-next-line global-require -- avoid a cycle at module load
    require("../logger")
      .getLogger()
      .warn(
        { keys: Object.keys(metrics || {}) },
        "unrecognised prisma $metrics() shape — pool gauges will read zero"
      );
  }

  return { open: 0, inUse: 0, idle: 0, max: 0 };
}

/**
 * The route pattern for a request, as safely as Express will give it.
 *
 * `req.route` is set by the router layer; at the terminal middleware it is
 * undefined for a 404, in which case the raw path would be unbounded
 * cardinality. Anything that is not a recognised pattern collapses to
 * `unmatched`, which is also the only value worth alerting on.
 *
 * @param {import("express").Request} req
 * @returns {string}
 */
function routeLabel(req) {
  const pattern = req.route && req.route.path;
  if (!pattern) return "unmatched";
  const base = (req.baseUrl || "").replace(/\/+$/, "");
  return `${base}${pattern === "/" ? "" : pattern}` || "/";
}

/**
 * Refreshes the gauges whose values live in another module (the queue's depths, the
 * rate limiter's chosen store). Called at scrape time by
 * `core/observability/routes.js` rather than on a timer, so the values are never
 * stale by more than one scrape interval and a quiet process does no work.
 *
 * Every branch is wrapped: a metrics scrape must never fail because a dependency
 * cannot be queried. `@prometheus-io/client` swallows a throwing `collect`
 * callback in some versions and turns the whole scrape into a 500 in others, so
 * the guard is explicit here.
 *
 * ## Why the gauges go to `unavailable` rather than to zero
 *
 * If the queue query fails, the series is labelled `unavailable` rather than being
 * left at its last value or written as 0. "0 jobs waiting" and "cannot see the
 * queue" are different facts, and an alert built on the first is *wrong* during an
 * outage — it would page as "queue drained" at the moment the queue stopped
 * draining. Setting `unavailable=1` keeps the good series' last value visible and
 * makes the blindness explicit on a series an alert can key on.
 */
async function refreshGauges(options = {}) {
  // ── rate-limit store ───────────────────────────────────────────────────
  try {
    // Required lazily: `core/http/rateLimit.js` requires this module for
    // `countRateLimitHit`, so a top-level import would be circular.
    const { storeName } = require("../http/rateLimit");
    setRateLimitStore(storeName, options);
  } catch {
    /* the limiter has not been built yet */
  }

  // ── queue depths ──────────────────────────────────────────────────────
  //
  // `queueBacklog` is the series an alert is built on, so it must never hold a
  // value that was not measured. An unlabeled Gauge *always* has one — prom-client
  // initialises it to 0 — so unlike `queueWaiting`, which simply has no samples
  // until it is set, `queueBacklog` publishes a confident `0` by default. That is
  // the worst possible failure for this gauge: 0 means "the queue is empty", and it
  // is emitted precisely when nobody can see the queue at all. Both unmeasurable
  // paths below therefore `remove()` it, which deletes the series so PromQL returns
  // nothing rather than a wrong number.
  //
  // `remove()`, not `reset()`, and the distinction is not cosmetic: on an unlabeled
  // Gauge prom-client 0.16's `reset()` keeps the series and sets it to 0 — exactly
  // the fabricated number this is guarding against. `remove()` deletes it, and
  // repeats harmlessly. Verified against the installed client rather than assumed.
  try {
    const queue = require("../../platform/queue");

    // Only report on a queue this process has **opened**. A scrape must not be what
    // opens one: on an API replica that never enqueues, a depth query is a database
    // round-trip on the scrape path for a queue that is empty by definition. The
    // worker process, which is the one that drains, always opens.
    if (!queue.isOpen()) {
      getMetrics(options).queueBacklog.remove();
      return;
    }

    const { byQueue, total } = await queue.store.depths();

    for (const [queueName, byStatus] of Object.entries(byQueue)) {
      for (const [status, value] of Object.entries(byStatus)) {
        getMetrics(options).queueWaiting.set({ queue: queueName, status }, Number(value || 0));
      }
    }

    // Read from the same result object, so the two gauges cannot disagree — and a
    // scrape that got this far genuinely saw the database.
    getMetrics(options).queueBacklog.set(Number(total));
  } catch {
    // Record the inability to see. See the note above: 0 would be a lie.
    const m = getMetrics(options);
    for (const name of require("../../platform/queue/queues").ALL_QUEUE_NAMES) {
      m.queueWaiting.set({ queue: name, status: "unavailable" }, 1);
    }
    // …and take the backlog series out entirely, rather than leaving the `0` it was
    // born with. `unavailable` says the blindness is real; an absent total says no
    // number is being claimed.
    getMetrics(options).queueBacklog.remove();
  }
}

module.exports = {
  registry,
  getMetrics,
  observeRequest,
  countError,
  countRateLimitHit,
  countQueueJob,
  countQueueEnqueueError,
  setDependencyUp,
  setDbPool,
  clearDbPool,
  setRateLimitStore,
  normalisePoolStats,
  routeLabel,
  refreshGauges,
  RATE_LIMIT_STORES,
  DURATION_BUCKETS,
  contentType,
};
