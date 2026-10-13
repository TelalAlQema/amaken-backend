/**
 * M01 kernel tests.
 *
 * The M00 contract suite pins the *HTTP* surface. This file pins the properties
 * that made the rest of the plan possible, which no request can observe:
 *
 *   1. `createApp()` is pure — it returns an app and binds nothing.
 *   2. `process.env` is reachable from exactly two files.
 *   3. The new primitives behave as documented.
 *
 * Deliberately not a contract test and deliberately database-free: it must fail
 * for a kernel defect, not because MySQL is down.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const request = require("supertest");

// Repoint at the isolated test database before any `src/` module is required:
// `src/config` freezes DATABASE_URL at load time, and a mistyped helper order
// here would aim the app at a developer's real database.
const { useTestDatabase } = require("../helpers/env");
useTestDatabase();

const SRC = path.join(__dirname, "..", "..", "src");

// ── 1. the app factory is pure ──────────────────────────────────────────────

test("src/app exports createApp and nothing that could be a bound server", () => {
  const appModule = require("../../src/app");

  assert.deepEqual(Object.keys(appModule), ["createApp"], "only createApp is exported");
  assert.equal(typeof appModule.createApp, "function");
  // A default export would let `require("./app")` return something that looks
  // like an app to a caller who skips the factory, which is the trap the
  // migration method explicitly calls out.
  assert.equal(appModule.default, undefined);
});

/**
 * The events that mean "this process owns its own lifecycle". If `createApp()`
 * registered any of them, a test could never exit and a deploy would never
 * drain.
 */
const LIFECYCLE_EVENTS = [
  "SIGTERM",
  "SIGINT",
  "SIGUSR2",
  "beforeExit",
  "uncaughtException",
  "unhandledRejection",
];

/** Handlers the Node test runner itself installs. Not ours, not a regression. */
const BASELINE_EVENTS = new Set(["newListener", "removeListener", "warning", "exit"]);

test("createApp() owns no process lifecycle", () => {
  const { createApp } = require("../../src/app");

  const before = LIFECYCLE_EVENTS.map((e) => process.listenerCount(e));
  createApp();
  const after = LIFECYCLE_EVENTS.map((e) => process.listenerCount(e));

  assert.deepEqual(after, before, "createApp must not install signal or crash handlers");

  // `exit` is allowed because pino registers it through `on-exit-leak-free` to
  // flush the log stream. Listed explicitly rather than wildcarded, so if a
  // future dependency starts registering something more interesting this test
  // fails instead of going quietly green.
  const known = new Set([...LIFECYCLE_EVENTS, ...BASELINE_EVENTS]);
  assert.deepEqual(process.eventNames().filter((e) => !known.has(e)), []);
});

test("createApp() binds no port", async () => {
  // The probe port is chosen by this test and matched to the app's own config.
  //
  // It used to hardcode 5000 and assert nothing was listening there, which is a claim
  // about the whole machine rather than about `createApp()` — so it passed on a clean
  // checkout and went red on any developer running `npm run dev`. `config` is frozen
  // at first require, and this file loads `src/app` above, so the only way to test the
  // real property is to reload the module against a port we know is free.
  const freePort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const reloadApp = () => {
    for (const key of Object.keys(require.cache)) {
      if (/[\\/]src[\\/](app\.js|config[\\/])/.test(key)) delete require.cache[key];
    }
  };

  const originalPort = process.env.PORT;
  process.env.PORT = String(freePort);
  reloadApp();

  try {
    const { createApp } = require("../../src/app");
    const app = createApp();

    assert.equal(typeof app.listen, "function", "returns an Express app");
    assert.equal(
      app.locals.config.http.port,
      freePort,
      "the app under test is configured for the port being probed"
    );
    assert.ok(app.locals.logger, "logger is attached for the error handler");

    // The direct test. `src/index.js` used to bind here at require time, so if
    // anything re-introduces a `listen` the port answers and this fails.
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const socket = net.connect(freePort, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }),
      /ECONNREFUSED/,
      "nothing may be listening on the configured port after createApp()"
    );

    // …and the app is still fully usable in-process.
    await request(app).get("/health").expect(200);
  } finally {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    // Restore a normally-configured module for every test that follows.
    reloadApp();
    require("../../src/app");
  }
});

test("src/index.js is a shim that delegates to server.js", () => {
  const source = fs.readFileSync(path.join(SRC, "index.js"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .trim();

  // Exactly one statement. Anything here is boot logic that has escaped into a
  // file whose whole job is to not have any.
  assert.deepEqual(
    code.split("\n").map((l) => l.trim()).filter(Boolean),
    ['require("./server");']
  );
});

// ── 2. process.env is confined to config/ (and the logger's NODE_ENV) ───────

/** Files permitted to touch `process.env`, with the reason each one is exempt. */
const ENV_ALLOWLIST = new Map([
  [path.join("config", "index.js"), "it is the only place that reads process.env"],
  [path.join("config", "env.schema.js"), "it declares the schema, it does not read"],
  [path.join("core", "logger", "logger.js"), "NODE_ENV chooses the default log level"],
]);

test("no file outside src/config/ reads process.env", () => {
  /** @param {string} dir */
  function collect(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full, out);
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  }

  /** Comments explain the rule; they must not count as reads. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const offenders = [];
  for (const file of collect(SRC)) {
    const rel = path.relative(SRC, file);
    if (!stripComments(fs.readFileSync(file, "utf8")).includes("process.env")) continue;
    if (!ENV_ALLOWLIST.has(rel)) offenders.push(rel);
  }

  assert.deepEqual(offenders, [], "process.env must be reached through src/config");
});

test("src/config is frozen and validated", () => {
  const config = require("../../src/config");

  assert.ok(Object.isFrozen(config), "top level frozen");
  assert.ok(Object.isFrozen(config.http), "nested frozen");
  // `Reflect.set` rather than a bare assignment: this file is sloppy-mode, where
  // writing to a frozen object fails silently instead of throwing.
  assert.equal(Reflect.set(config.http, "port", 9999), false, "frozen objects reject writes");
  assert.equal(config.http.port, 5000);

  // Declared in src/config/env.schema.js, not defaulted in a service.
  assert.equal(typeof config.http.port, "number");
  assert.equal(typeof config.jwt.secret, "string");
  assert.ok(Array.isArray(config.log.redact));
  assert.ok(config.log.redact.includes("req.headers.authorization"));
  assert.ok(config.log.redact.includes("req.body.password"));
  assert.ok(path.isAbsolute(config.paths.uploads));
});

// ── 3. the primitives ───────────────────────────────────────────────────────

test("ErrorCode is a closed, frozen set and every code has a status", () => {
  const { ErrorCode, STATUS_BY_CODE, AppError, notFound, conflict } = require("../../src/core/errors");

  assert.ok(Object.isFrozen(ErrorCode));
  for (const code of Object.values(ErrorCode)) {
    assert.equal(typeof STATUS_BY_CODE[code], "number", `${code} has no status`);
  }

  const err = notFound("Property not found", "PROPERTY_NOT_FOUND");
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 404);
  assert.equal(err.code, "PROPERTY_NOT_FOUND", "a domain code overrides the generic one");
  assert.equal(err.isClientError, true);
  assert.equal(conflict("duplicate email").statusCode, 409);
  assert.equal(notFound("x").code, "NOT_FOUND", "falls back to the generic code");
});

test("fromPrisma maps P2002 to 409 and P2025 to 404, and nothing else", () => {
  const { fromPrisma, isPrismaError } = require("../../src/core/errors");

  const unique = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const missing = Object.assign(new Error("Record not found"), { code: "P2025" });
  const fk = Object.assign(new Error("FK constraint failed"), { code: "P2003" });

  assert.equal(isPrismaError(unique), true);
  assert.equal(isPrismaError(new Error("nope")), false);
  assert.equal(isPrismaError({ code: "ENOENT", message: "x" }), false, "not a Prisma P-code");

  assert.equal(fromPrisma(unique).statusCode, 409);
  assert.equal(fromPrisma(unique).code, "CONFLICT");
  assert.equal(fromPrisma(missing).statusCode, 404);
  assert.equal(fromPrisma(missing).code, "NOT_FOUND");
  // P2003 needs the constraint name to write a useful message; unmapped is
  // deliberate, see src/core/errors/prisma.js.
  assert.equal(fromPrisma(fk), null);
  assert.equal(fromPrisma(new Error("plain")), null);
});

test("paginate emits exactly the four contract keys", () => {
  const { paginate, toPrismaArgs, paginationQuery, pagedResult, MAX_LIMIT } =
    require("../../src/core/http/pagination");

  const page = paginate({ page: 2, limit: 20, total: 137 });
  assert.deepEqual(page, { page: 2, limit: 20, total: 137, totalPages: 7 });
  assert.deepEqual(Object.keys(page).sort(), ["limit", "page", "total", "totalPages"]);

  assert.equal(paginate({ total: 0 }).totalPages, 0, "no rows means no pages, not NaN");
  assert.equal(paginate({ limit: 5000 }).limit, MAX_LIMIT, "limit is capped unconditionally");
  assert.equal(paginate({ page: -3 }).page, 1, "page is 1-based and floored");
  assert.equal(paginate().page, 1);

  assert.deepEqual(toPrismaArgs({ page: 3, limit: 20 }), { skip: 40, take: 20 });
  assert.deepEqual(pagedResult([1, 2], 5, { page: 1, limit: 2 }).pagination.totalPages, 3);

  // Junk query params degrade to the default rather than 400ing: a page hint is
  // not a resource.
  assert.deepEqual(paginationQuery.parse({ page: "abc", limit: "9999" }), { page: 1, limit: 20 });
  assert.deepEqual(paginationQuery.parse({}), { page: 1, limit: 20 });
  assert.deepEqual(paginationQuery.parse({ page: "4", limit: "50" }), { page: 4, limit: 50 });
});

test("the envelope helpers produce ADR 0003's shapes", () => {
  const response = require("../../src/core/http/response");
  const pagination = { page: 1, limit: 20, total: 0, totalPages: 0 };

  /** Minimal Express response double. */
  const res = () => {
    const r = {
      statusCode: null,
      body: undefined,
      ended: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
      end() {
        this.ended = true;
      },
    };
    response.envelope()({}, r, () => {});
    return r;
  };

  const okRes = res();
  okRes.ok({ id: 1 });
  assert.equal(okRes.statusCode, 200);
  assert.deepEqual(okRes.body, { success: true, data: { id: 1 } });

  const createdRes = res();
  createdRes.created({ id: 1 });
  assert.equal(createdRes.statusCode, 201);

  const empty = res();
  empty.noContent();
  assert.equal(empty.statusCode, 204);
  assert.equal(empty.ended, true);

  // Lists expose only the canonical `items` key after M07.
  const paged = res();
  paged.paginated({ items: [1, 2], pagination });
  assert.deepEqual(paged.body, {
    success: true,
    data: { items: [1, 2], pagination },
  });

  const failed = res();
  failed.fail(409, "Duplicate", "CONFLICT");
  assert.equal(failed.statusCode, 409);
  assert.deepEqual(failed.body, { success: false, error: { message: "Duplicate", code: "CONFLICT" } });
});

test("asyncHandler forwards rejections to next, and does not double-call it", async () => {
  const { asyncHandler } = require("../../src/core/http/asyncHandler");

  const boom = new Error("boom");
  const passed = [];
  const next = (err) => passed.push(err);

  asyncHandler(async () => {
    throw boom;
  })({}, {}, next);
  await new Promise(setImmediate);
  assert.deepEqual(passed, [boom], "an async throw reaches next");

  // A synchronous throw is caught too.
  const syncBoom = new Error("sync");
  asyncHandler(() => {
    throw syncBoom;
  })({}, {}, next);
  assert.deepEqual(passed, [boom, syncBoom]);

  // A handler that handles the error itself must not also call next.
  const quiet = [];
  asyncHandler(async (_req, res) => {
    res.ok("done");
  })({}, { ok: () => {} }, (err) => quiet.push(err));
  await new Promise(setImmediate);
  assert.deepEqual(quiet, []);

  // A non-promise return value is not treated as a thenable.
  const sync = [];
  asyncHandler(() => 42)({}, {}, (err) => sync.push(err));
  assert.deepEqual(sync, []);
});

test("requestId adopts a safe inbound id and rejects a forged one", () => {
  const { requestId, acceptInboundId } = require("../../src/core/logger");

  assert.equal(acceptInboundId("abc-123"), "abc-123");
  assert.equal(acceptInboundId("  abc-123  "), "abc-123");
  assert.equal(acceptInboundId("a\nb"), null, "a newline in a header is log injection");
  assert.equal(acceptInboundId("a b"), null);
  assert.equal(acceptInboundId(""), null);
  assert.equal(acceptInboundId("x".repeat(201)), null);

  const run = (headers) => {
    const req = { headers };
    const set = [];
    const res = { locals: {}, setHeader: (k, v) => set.push([k, v]) };
    const middleware = requestId();
    middleware(req, res, () => {});
    return { req, set };
  };

  const adopted = run({ "x-request-id": "trace-7" });
  assert.equal(adopted.req.id, "trace-7");
  assert.deepEqual(adopted.set, [["X-Request-Id", "trace-7"]]);

  const minted = run({});
  assert.match(minted.req.id, /^[0-9a-f-]{36}$/, "a UUID is minted when none is supplied");
  assert.equal(minted.set[0][1], minted.req.id, "the id on the wire is the id in the log");
});

test("routeLabel collapses unmatched paths so cardinality stays bounded", () => {
  const { routeLabel } = require("../../src/core/observability");

  assert.equal(routeLabel({ baseUrl: "/api", route: { path: "/:id" } }), "/api/:id");
  assert.equal(routeLabel({ baseUrl: "/api/properties", route: { path: "/" } }), "/api/properties");
  assert.equal(routeLabel({ baseUrl: "", route: { path: "/health" } }), "/health");
  // An unmatched path has no pattern; the raw URL would mint a series per
  // request id and OOM the process.
  assert.equal(routeLabel({ url: "/api/x/1/2/3", route: undefined }), "unmatched");
});

// ── M02: the scale primitives ───────────────────────────────────────────────

/**
 * These are deliberately **database-free**. Every one of them asserts behaviour
 * that must hold with no shared dependency in the picture, because that is the
 * state a fresh clone and most CI runs are in — and because "fails open" is a
 * property only a test can prove.
 *
 * The one thing this group no longer covers is the *absence* of Redis: there is no
 * Redis to be absent, so the tests that used to stub a dead connection server and
 * assert graceful degradation have no subject. They were replaced by tests of the
 * system that exists — see "the rate limiter is in-process, and says so" and
 * `queue.test.js`, whose durable-cache group exercises the MySQL tier against a real
 * database rather than mocking one.
 */
test("the storage port rejects traversal and builds safe keys", () => {
  const { isSafeKey, buildKey, assertAdapter, REQUIRED_METHODS, StorageDir } =
    require("../../src/platform/storage/port");

  assert.equal(isSafeKey("properties/a.webp"), true);
  assert.equal(isSafeKey("properties/../secret"), true, "normalises to a path inside the root");

  assert.equal(isSafeKey("../etc/passwd"), false);
  assert.equal(isSafeKey("a/../../etc/passwd"), false);
  assert.equal(isSafeKey("/etc/passwd"), false, "absolute paths are not keys");
  assert.equal(isSafeKey("a\0b"), false, "a NUL truncates the path at the syscall boundary");
  assert.equal(isSafeKey(""), false);
  assert.equal(isSafeKey(null), false);

  // `basename` on the filename is what stops `buildKey` being a traversal helper
  // even when the caller passes an absolute or dotted path.
  assert.equal(buildKey(StorageDir.PROPERTIES, "a.webp"), "properties/a.webp");
  assert.equal(buildKey(StorageDir.PROPERTIES, "../../etc/passwd"), "properties/passwd");
  assert.throws(() => buildKey("", "a.webp"), /could not be built/);
  assert.throws(() => buildKey(StorageDir.PROPERTIES, ".."), /could not be built/);

  // An adapter missing a method must fail at construction, not on first upload.
  assert.throws(() => assertAdapter({}, "broken"), /missing/);

  for (const method of REQUIRED_METHODS) {
    const complete = Object.fromEntries(REQUIRED_METHODS.map((m) => [m, () => {}]));
    delete complete[method];
    assert.throws(
      () => assertAdapter(complete, "partial"),
      new RegExp(`missing: ${method}`),
      `a missing ${method} must be named in the error`
    );
  }
});

test("the local-disk adapter round-trips through a temp root", async () => {
  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const os = require("node:os");

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "amaken-storage-"));
  const { createLocalDiskStorage, StorageDir } = require("../../src/platform/storage/local-disk");

  try {
    const store = createLocalDiskStorage({ root });

    const put = await store.put("photo.webp", Buffer.from("hello"), {
      dir: StorageDir.PROPERTIES,
      contentType: "image/webp",
    });
    assert.equal(put.key, "properties/photo.webp");
    assert.equal(put.size, 5);

    assert.equal((await store.get("properties/photo.webp")).toString(), "hello");
    assert.equal(await store.exists("properties/photo.webp"), true);
    assert.equal(await store.get("properties/absent.webp"), null, "an absent file is not an error");
    assert.equal(await store.exists("properties/absent.webp"), false);

    // The URL is what `express.static` serves and what is persisted beside a row.
    assert.equal(store.url("properties/photo.webp"), "/uploads/properties/photo.webp");
    assert.equal(
      store.url("properties/photo.webp", { absolute: true, publicBase: "https://cdn.example" }),
      "https://cdn.example/uploads/properties/photo.webp"
    );

    const listed = await store.list(StorageDir.PROPERTIES);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, "properties/photo.webp");
    assert.equal(listed[0].size, 5);
    assert.deepEqual(await store.list("nope"), [], "a missing directory lists empty");

    // The traversal guard is the whole reason the adapter resolves keys itself.
    await assert.rejects(() => store.get("../../package.json"), /escapes root/);

    // A real stream, for the TSV export path that pipes a file to a response.
    const chunks = [];
    for await (const chunk of await store.readStream("properties/photo.webp")) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "hello");

    assert.equal(await store.delete("properties/photo.webp"), true);
    assert.equal(await store.delete("properties/photo.webp"), false, "deleting twice is not an error");
    assert.equal(await store.readStream("properties/photo.webp"), null, "a deleted file streams null");

    const health = await store.health();
    assert.equal(health.ok, true, "the adapter reports the root it wrote to");
    assert.ok(!fs.existsSync(path.join(root, ".healthcheck")), "the probe cleans up after itself");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("the in-memory cache namespaces its keys and survives a database outage", async () => {
  const cache = require("../../src/platform/cache");
  const config = require("../../src/config");

  cache.clear();

  assert.equal(await cache.get("property", "missing"), null, "a miss is null, not undefined");

  await cache.set("property", "one", { id: 1, title: "Marina" });
  assert.deepEqual(await cache.get("property", "one"), { id: 1, title: "Marina" });

  // The app-level prefix is prepended by `qualify`, not by the caller. A caller
  // that passes an absolute-looking key cannot reach outside the namespace.
  const qualified = cache.qualify("property", "one");
  assert.ok(qualified.startsWith(config.cache.prefix), "keys are namespaced by the app prefix");
  assert.ok(qualified.includes("cache:property:"), "and by namespace");

  // Two namespaces holding the same key must not collide.
  await cache.set("dashboard", "one", { total: 9 });
  assert.deepEqual(await cache.get("property", "one"), { id: 1, title: "Marina" });
  assert.deepEqual(await cache.get("dashboard", "one"), { total: 9 });

  // TTL is honoured by the fallback's lazy sweep, not by a timer.
  await cache.set("property", "expiring", { ok: true }, -1);
  assert.equal(await cache.get("property", "expiring"), null, "a negative TTL is already expired");

  assert.equal(await cache.del("property", "one"), true);
  assert.equal(await cache.get("property", "one"), null);

  // Repopulate so the prefix sweep has something to remove.
  await cache.set("property", "a", 1);
  await cache.set("property", "b", 2);

  // `invalidatePrefix` takes the suffix of a qualified key and prepends the app
  // prefix itself, so a caller cannot construct a pattern reaching into another
  // environment's keys.
  const removed = await cache.invalidatePrefix("cache:property:");
  assert.equal(removed, 2, "the whole property namespace is cleared");
  assert.equal(await cache.get("property", "a"), null);
  assert.equal(await cache.get("property", "b"), null);

  assert.deepEqual(await cache.get("dashboard", "one"), { total: 9 }, "a sibling namespace survives");

  // `invalidateNamespace` is the ergonomic form, and the two must agree.
  await cache.set("property", "c", 3);
  await cache.invalidateNamespace("property");
  assert.equal(await cache.get("property", "c"), null);
  assert.deepEqual(await cache.get("dashboard", "one"), { total: 9 });

  cache.clear();
});

test("remember() runs the producer once and then serves from cache", async () => {
  const cache = require("../../src/platform/cache");
  cache.clear();

  let calls = 0;
  const produce = async () => {
    calls += 1;
    return { value: calls };
  };

  assert.deepEqual(await cache.remember("t", "k", produce), { value: 1 });
  assert.deepEqual(await cache.remember("t", "k", produce), { value: 1 });
  assert.equal(calls, 1, "the producer is not re-run on a hit");

  // A cached `null` is a real value, not a miss marker — otherwise a legitimately
  // empty result would re-query on every request.
  cache.clear();
  let nulls = 0;
  const produceNull = async () => {
    nulls += 1;
    return null;
  };
  await cache.remember("t", "n", produceNull);
  await cache.remember("t", "n", produceNull);
  assert.equal(nulls, 1, "a cached null is a hit");

  cache.clear();
});

/**
 * The rate limiter is in-process, and this asserts the whole of its configuration
 * surface, because in this build there is no second store to fall back to.
 *
 * There used to be a `FailOpenStore` here wrapping a Redis client, with tests for
 * "degrades when Redis is absent" and "recovers when Redis returns". Both are gone
 * with the store itself. What replaced them is not a shorter test but a different
 * claim: the constraint is *documented* rather than *handled*, so the test is that
 * the deployment says so out loud — see the runbook, and the second replica claim
 * in "the two limiters are configured independently".
 */
test("the rate limiter is in-process, and says so", () => {
  const rateLimitModule = require("../../src/core/http/rateLimit");

  // The one honest answer this build can give. It is what
  // `amaken_api_rate_limit_store_info` publishes, so a dashboard built on it reads
  // correctly instead of assuming a global counter.
  assert.equal(rateLimitModule.storeName, "memory");

  // Nothing exported that a caller could mistake for a shared store. Their absence
  // is the assertion: if a future change reintroduces a pluggable store, these
  // tests fail and force the runbook's single-replica note to be revisited with
  // them, rather than the other way round.
  assert.equal(rateLimitModule.getStore, undefined, "there is no pluggable store any more");
  assert.equal(rateLimitModule.FailOpenStore, undefined, "and no fail-open wrapper to wrap");

  // `express-rate-limit` v7 throws ERR_ERL_STORE_REUSE if one store instance is
  // handed to two limiters, so each limiter must build its own. Leaving `store`
  // undefined is what makes it do that.
  const rateLimit = require("express-rate-limit");
  const sources = [rateLimitModule.apiLimiter, rateLimitModule.authLimiter];
  for (const limiter of sources) {
    assert.ok(limiter, "both limiters exist");
  }
  // eslint-disable-next-line no-unused-vars -- the import documents the constraint
  assert.ok(rateLimit, "express-rate-limit is the limiter implementation");
});
test("the two limiters are configured independently", () => {
  const { apiLimiter, authLimiter } = require("../../src/core/http/rateLimit");
  const config = require("../../src/config");

  // Separate middleware, and — by construction — separate stores.
  // `express-rate-limit` v7 throws `ERR_ERL_STORE_REUSE` if one store instance is
  // handed to two limiters, because each namespaces keys by its own prefix — a
  // shared store would merge the /api and /api/auth budgets and make the stricter
  // auth limit meaningless. Leaving `store` undefined in `createLimiter` is what
  // makes the library build one per limiter.
  assert.notEqual(apiLimiter, authLimiter, "distinct limiter middleware");
  assert.ok(apiLimiter, "the general limiter exists");
  assert.ok(authLimiter, "the auth limiter exists");

  // The auth limit is the stricter one, and that ordering is the whole point of
  // having a second limiter: a credential-stuffing run has to be bounded at the
  // auth limit, not the general one.
  assert.ok(
    config.http.rateLimit.authMax < config.http.rateLimit.max,
    `auth limit (${config.http.rateLimit.authMax}) must be stricter than /api (${config.http.rateLimit.max})`
  );
});

test("every queue has a processor and a deterministic job id", () => {
  const {
    QUEUES,
    QUEUE_DEFAULTS,
    ALL_QUEUE_NAMES,
    otpJobId,
    leadNotificationJobId,
    exportJobId,
  } = require("../../src/platform/queue/queues");
  const { PROCESSORS } = require("../../src/platform/queue/worker");

  // A queue with no processor spins forever with nothing consuming it. Jobs sit in
  // `waiting` looking exactly like jobs that succeeded.
  for (const name of ALL_QUEUE_NAMES) {
    assert.equal(typeof PROCESSORS[name], "function", `${name} has no processor`);
    const defaults = QUEUE_DEFAULTS[name];
    assert.ok(defaults.concurrency >= 1, `${name} concurrency`);
    assert.ok(defaults.attempts >= 2, `${name} retries at least once`);
    assert.ok(defaults.backoffMs > 0, `${name} backs off before retrying`);
  }

  // Every declared queue is claimed and reported on. A name in `ALL_QUEUE_NAMES`
  // that no processor handles is a queue that fills until the table needs pruning.
  assert.deepEqual(
    [...ALL_QUEUE_NAMES].sort(),
    Object.keys(PROCESSORS).sort(),
    "the claim set and the processor set must be the same set"
  );

  // A duplicate `id` is dropped on insert, which is the de-duplication these rely
  // on. Case is folded first: the cache is keyed on a lowercased address, so a
  // differently-cased resend must not produce a second email.
  assert.equal(otpJobId("A@B.com", "register", "111111"), otpJobId("a@b.com", "register", "111111"));
  assert.notEqual(otpJobId("a@b.com", "register", "111111"), otpJobId("a@b.com", "reset", "111111"));

  // The code is part of the digest, so a resend — which overwrites the cached code
  // and invalidates the previous one — is not dropped as a duplicate. Getting this
  // wrong produces a user who clicks "resend", receives nothing, and has no valid
  // code left.
  assert.notEqual(otpJobId("a@b.com", "register", "111111"), otpJobId("a@b.com", "register", "222222"));

  // The notification subject is the thing being announced, not the recipient.
  assert.equal(leadNotificationJobId("lead:7"), leadNotificationJobId("lead:7"));
  assert.notEqual(leadNotificationJobId("lead:7"), leadNotificationJobId("lead:8"));
  assert.equal(leadNotificationJobId("registration:a@b.com"), leadNotificationJobId("registration:a@b.com"));
  assert.notEqual(leadNotificationJobId("registration:a@b.com"), leadNotificationJobId("lead:7"));

  // The export id is scoped by both who asked and what they asked for, so an admin
  // re-running the same filter gets a fresh job while a retried request does not.
  assert.equal(exportJobId("admin:1"), exportJobId("admin:1"));
  assert.notEqual(exportJobId("admin:1"), exportJobId("admin:2"));
  assert.notEqual(exportJobId("admin:1", '{"mode":"new"}'), exportJobId("admin:1", '{"mode":"all"}'));

  // A job id is the primary key of `jobs`, so it must be a fixed width and free of
  // anything that would need quoting in a SQL literal or a log line.
  for (const id of [
    otpJobId("weird:local@example.com", "register", "999999"),
    otpJobId("a@b.com", "register", "999999"),
    leadNotificationJobId("lead:42"),
    exportJobId("admin:1"),
  ]) {
    assert.equal(typeof id, "string", "an id is a string");
    assert.ok(id.startsWith("amaken:"), `job id "${id}" must carry the environment prefix`);
    assert.match(id, /^[a-z0-9]+:[a-z0-9-]+:[0-9a-f]{16}$/, `job id "${id}" must be a stable shape`);
  }
});
test("a disabled queue enqueues nothing and does not throw", async () => {
  const queue = require("../../src/platform/queue");
  const config = require("../../src/config");

  // The suite runs with `QUEUE_ENABLED=false`, so the real enqueue short-circuits
  // before writing a row. Assert that explicitly, because "the test passed" is
  // otherwise ambiguous — it could mean the gate works, or that nothing was ever
  // attempted for some other reason.
  assert.equal(config.queue.enabled, false, "the suite disables the queue by default");

  const disabled = await queue.enqueueOtpEmail({ to: "user@example.com", otp: "123456" });
  assert.equal(disabled, null, "a disabled queue enqueues nothing and does not throw");
  assert.equal(queue.stats().enqueueErrors, 0, "and does not count a real enqueue failure");
  assert.equal(queue.stats().skippedDisabled, 1, "a deliberate skip is counted as a skip");
  assert.equal(queue.QUEUES.OTP_EMAIL, "otp-email");

  // `resetStats` has to zero the skip counter too, or a second call in the same
  // process cannot distinguish "disabled" from "already counted".
  queue.resetStats();
  assert.equal(queue.stats().skippedDisabled, 0, "resetStats clears the skip counter");
});

/**
 * The enqueue deadline, tested as a unit rather than only through the child-process
 * outage test below.
 *
 * The subtlety this test exists to pin down: **the deadline's timer is `unref`'d**,
 * so on its own it cannot keep the event loop alive. That is deliberate — see
 * `withDeadline` in `platform/queue/index.js`; a ref'd timer here would hold a
 * process open at the end of a drain, which is the same trap the health probes
 * document in `core/health/routes.js`. It also means the deadline only fires while
 * something *else* keeps the loop turning.
 *
 * In production that something is the request's own socket, so the guarantee holds.
 * Here it has to be supplied explicitly, which is why the test holds a ref'd timer
 * open and why the child-process test below matters: there the enqueue is genuinely
 * racing a live TCP connect, so the loop is busy on its own.
 */
test("the enqueue deadline resolves rather than hanging on a promise that never settles", async () => {
  const { withDeadline, ENQUEUE_DEADLINE_MS } = require("../../src/platform/queue");

  assert.ok(ENQUEUE_DEADLINE_MS > 0 && ENQUEUE_DEADLINE_MS < 10_000, "the deadline is a request-path budget");

  // Stands in for the open socket a real request holds.
  const keepAlive = setInterval(() => {}, 5);

  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => withDeadline(new Promise(() => {}), 50, "test-queue"),
      /enqueue timed out after 50ms \(test-queue\)/
    );
    assert.ok(Date.now() - startedAt < 5_000, "it gave up promptly");

    // A promise that settles in time is passed through untouched, and the timer is
    // cleared — a leaked ref'd timer would hold the event loop open at the end of a
    // drain.
    assert.equal(await withDeadline(Promise.resolve("done"), 10_000, "test-queue"), "done");
    assert.equal(await withDeadline(Promise.resolve(42), 10_000, "test-queue"), 42);

    // A rejection propagates rather than being swallowed, because `enqueue`'s own
    // catch is what decides a rejection means "fail open".
    await assert.rejects(
      () => withDeadline(Promise.reject(new Error("boom")), 10_000, "test-queue"),
      /boom/
    );
  } finally {
    clearInterval(keepAlive);
  }
});
/**
 * The deadline is the part of fail-open that is easy to get wrong in either
 * direction, so it is asserted in a child process pointed at a database that is
 * not there.
 *
 * Run in a child, for three reasons that each matter:
 *
 *   1. `config` is deeply frozen, so `QUEUE_ENABLED` cannot be flipped in-process to
 *      reach the code path that actually writes a row.
 *   2. The thing under test is a *timeout*. Asserting it in the process that owns
 *      the timer machinery proves nothing about whether that process can still
 *      exit — and a queue module that leaves a retry loop behind is a worker that
 *      never dies on SIGTERM.
 *   3. A misconfigured `DATABASE_URL` is process-global, so it would leak into
 *      every test after this one.
 *
 * The old version of this test pointed at a Redis on port 1. There is no Redis any
 * more, and the equivalent fault is a MySQL on port 1 — same shape (a TCP connect
 * that is refused) and it exercises the same code.
 */
test("an enqueue against a dead database gives up instead of hanging", () => {
  const { spawnSync } = require("node:child_process");

  const script = `
    const queue = require(${JSON.stringify(require.resolve("../../src/platform/queue"))});
    const startedAt = Date.now();
    queue.enqueueOtpEmail({ to: "user@example.com", otp: "654321" })
      .then((job) => {
        require("node:fs").writeFileSync(process.env.RESULT_FILE, JSON.stringify({
          job,
          elapsedMs: Date.now() - startedAt,
          enqueueErrors: queue.stats().enqueueErrors,
          enqueued: queue.stats().enqueued,
          skippedDisabled: queue.stats().skippedDisabled,
        }));
        // exit() rather than letting the loop drain: if the failed enqueue left a
        // connection attempt or retry timer behind, the natural exit would never
        // come and the parent's own timeout would fire instead of a clean result.
        process.exit(0);
      })
      .catch((err) => {
        require("node:fs").writeFileSync(process.env.RESULT_FILE, JSON.stringify({ threw: err.message }));
        process.exit(3);
      });
  `;

  const resultFile = path.join(os.tmpdir(), `amaken-enqueue-${process.pid}-${Date.now()}.json`);

  // Built from the real URL so the credentials and driver stay valid, with only the
  // port repointed. A port nothing listens on refuses immediately, which keeps the
  // assertion about the deadline from being a test about TCP timeouts.
  const deadUrl = new URL(process.env.DATABASE_URL);
  deadUrl.port = "1";

  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      RESULT_FILE: resultFile,
      QUEUE_ENABLED: "true",
      DATABASE_URL: deadUrl.toString(),
      // Keep the child from reaching for a mail server, SMTP config or a .env
      // file the parent already resolved.
      NODE_ENV: "test",
    },
  });

  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    assert.fail(
      `the child produced no result (status=${child.status}, signal=${child.signal}).\n` +
        `stdout: ${child.stdout}\nstderr: ${child.stderr}`
    );
  } finally {
    fs.rmSync(resultFile, { force: true });
  }

  // A throw here would be the enqueue surfacing the outage to the request path.
  assert.equal(result.threw, undefined, `enqueue threw instead of failing open: ${result.threw}`);
  assert.equal(result.job, null, "a failed enqueue resolves null, not an exception");
  assert.ok(result.enqueueErrors > 0, "and is counted, so the outage is visible on a metric");
  assert.equal(result.enqueued, 0, "and is never counted as enqueued");
  assert.equal(result.skippedDisabled, 0, "and not mistaken for a disabled queue");

  // The deadline is the whole point. Without it an un-deadlined enqueue against an
  // unreachable database can hold a registration open for the length of Prisma's
  // own connect timeout, and the child would hit its 20s timeout instead of writing
  // a result. The bound is generous relative to ENQUEUE_DEADLINE_MS (2000ms)
  // because the connection refusal and the deadline race on a loaded CI box.
  assert.ok(
    result.elapsedMs < 15_000,
    `enqueue took ${result.elapsedMs}ms — it waited on the connect timeout instead of giving up`
  );
  assert.equal(child.status, 0, "the child exits cleanly, with no retry loop left running");
});
test("a readiness probe fails on a falsy result, not only on a throw", async () => {
  const { probe, readiness, liveness } = require("../../src/core/health/routes");

  // The bug this guards: `probe` used to treat "did not throw" as "healthy". A
  // database that resolves `0` rows, a `ping` that resolves `false`, and the
  // storage adapter's `{ ok: false }` all resolved cleanly — so a dead replica
  // reported itself ready and the orchestrator kept sending it traffic.
  const falsy = await probe("database", async () => false);
  assert.equal(falsy.ok, false, "a resolved `false` is not healthy");
  assert.equal(typeof falsy.error, "string", "and the reason is reported, not swallowed");
  assert.match(falsy.error, /resolved false/);

  const zeroRows = await probe("database", async () => 0);
  assert.equal(zeroRows.ok, false, "a zero-row result is not healthy either");

  const nanResult = await probe("database", async () => NaN);
  assert.equal(nanResult.ok, false, "NaN is falsy, and must not read as healthy");

  const storageShape = await probe("storage", async () => ({ ok: false, detail: "EROFS" }));
  assert.equal(storageShape.ok, false, "an { ok: false } result is unwrapped, not read as truthy");

  const storageGood = await probe("storage", async () => ({ ok: true, adapter: "local-disk" }));
  assert.equal(storageGood.ok, true, "{ ok: true } is healthy");

  const bareTrue = await probe("database", async () => true);
  assert.equal(bareTrue.ok, true, "a bare truthy value is still accepted");

  const threw = await probe("database", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(threw.ok, false);
  assert.equal(threw.error, "ECONNREFUSED");

  // A probe that hangs must be cut off, not awaited — a probe that times out is a
  // probe that times out twice.
  const startedAt = Date.now();
  const hung = await probe("database", () => new Promise(() => {}), 50);
  assert.equal(hung.ok, false);
  assert.match(hung.error, /timed out/);
  assert.ok(Date.now() - startedAt < 2000, "the deadline is honoured");

  // Liveness never awaits. If it did, a liveness probe would be a readiness probe,
  // and a 60-second database blip would make the orchestrator restart every replica
  // at once — the outage that restarting causes.
  const live = liveness();
  assert.equal(live.status, "ok");
  assert.equal(typeof live.uptimeSeconds, "number");
  assert.equal(live.uptimeSeconds >= 0, true);
  assert.equal(live instanceof Promise, false, "liveness is synchronous");
});

test("readiness reports every dependency, not just the first failure", async () => {
  const health = require("../../src/core/health/routes");

  // The real probes, against the real test database and the real upload directory.
  // The assertion is a property of `readiness`'s *shape* — that it aggregates rather
  // than short-circuits — and it needs no server: `Promise.all` over three probes
  // either returns three results or throws, and only the first shape is worth
  // testing.
  const result = await health.readiness();

  assert.deepEqual(
    result.checks.map((c) => c.name).sort(),
    ["database", "queue", "storage"],
    "all three are reported, and the queue replaced the Redis probe"
  );

  for (const check of result.checks) {
    assert.equal(typeof check.ok, "boolean");
    assert.equal(typeof check.ms, "number");
    assert.equal(check.ms >= 0, true);
  }

  // `ready` is computed from the checks, never assumed. With a live test database
  // all three should pass, and if one does not the failure belongs in this
  // assertion rather than being papered over — an `ok: false` here is a real
  // problem with the queue tables or the uploads directory.
  assert.equal(
    result.ready,
    result.checks.every((c) => c.ok),
    "ready is derived from the checks"
  );

  if (process.env.TEST_DB_NAME) {
    assert.equal(
      result.checks.find((c) => c.name === "database").ok,
      true,
      "the test database must be reachable for this suite to mean anything"
    );
    assert.equal(
      result.checks.find((c) => c.name === "queue").ok,
      true,
      "the queue must be healthy — it is rows in this same database"
    );
  }
});

test("the pool gauge reads the shape Prisma 5.22 actually returns", async () => {
  const { normalisePoolStats, setDbPool, clearDbPool, registry } = require("../../src/core/observability");

  // Captured verbatim from `await prisma.$metrics.json()` on Prisma 5.22 / MySQL:
  // `{ counters, gauges, histograms }`, each an array of `{ key, labels, value }`.
  //
  // This test used to assert a `{ pool: { connections, ... } }` shape and pass
  // forever, because that is not what 5.22 emits. The gauge was therefore reading
  // zero in production while a green test said otherwise. A shape assertion is only
  // worth anything if the shape was taken from the driver.
  const real = {
    counters: [{ key: "prisma_pool_connections_opened_total", labels: {}, value: 3 }],
    gauges: [
      { key: "prisma_client_queries_active", labels: {}, value: 1 },
      { key: "prisma_client_queries_wait", labels: {}, value: 0 },
      { key: "prisma_pool_connections_busy", labels: {}, value: 4 },
      { key: "prisma_pool_connections_idle", labels: {}, value: 6 },
      { key: "prisma_pool_connections_open", labels: {}, value: 10 },
    ],
    histograms: [],
  };

  const pool = normalisePoolStats(real);
  assert.equal(pool.open, 10, "open comes from prisma_pool_connections_open");
  assert.equal(pool.inUse, 4, "busy is in-use — the names do not match");
  assert.equal(pool.idle, 6);
  assert.equal(pool.max, 0, "and there is no ceiling in this payload, so none is invented");

  setDbPool(real);
  const text = await registry.metrics();
  assert.match(text, /db_pool_connections\{state="open"\} 10/);
  assert.match(text, /db_pool_connections\{state="in_use"\} 4/);
  assert.match(text, /db_pool_connections\{state="idle"\} 6/);
  assert.doesNotMatch(
    text,
    /db_pool_max_connections/,
    "Prisma reports no ceiling; publishing 0 would read as a pool that can never grow"
  );

  // An unmeasurable pool leaves no samples, rather than a confident zero.
  clearDbPool();
  const cleared = await registry.metrics();
  assert.doesNotMatch(
    cleared,
    /^amaken_api_db_pool_connections\{/m,
    "a pool nobody measured must not report idle=0 and look healthy"
  );

  // Older shapes still parse, so a driver bump degrades rather than breaks.
  assert.equal(normalisePoolStats({ open: 3, inUse: 1, idle: 2 }).open, 3, "already-normalised");
  assert.equal(
    normalisePoolStats({ connections: 7, active_connections: 2, idle_connections: 5 }).open,
    7,
    "Prisma 4 flat shape"
  );
  assert.deepEqual(normalisePoolStats({ something: "else" }), { open: 0, inUse: 0, idle: 0, max: 0 });
});

test("the backlog gauge is absent, not zero, when the queue cannot be measured", async () => {
  const { refreshGauges, registry } = require("../../src/core/observability");
  const queue = require("../../src/platform/queue");

  // `createApp()` never calls `queue.open()` — only `server.start()` does — so an app
  // built directly is exactly the process that cannot see the queue. An unlabeled
  // Gauge is born holding 0, so without an explicit reset the series publishes 0 and
  // an alert built on it reports "queue is empty" during the outage that broke it.
  queue.closeQueues();
  await refreshGauges();
  const text = await registry.metrics();

  assert.doesNotMatch(
    text,
    /^amaken_api_queue_backlog_total /m,
    "no backlog number may be published when nothing was measured"
  );

  // Measured, it appears. Same registry, so this also proves `reset()` was what kept
  // the series out, rather than it never having existed.
  queue.open();
  await refreshGauges();
  const after = await registry.metrics();
  assert.match(after, /^amaken_api_queue_backlog_total 0$/m, "and a real measurement does appear");

  queue.closeQueues();
});

test("CORS matches origins exactly, and never by suffix", () => {
  const { resolveCorsOrigin, toList } = require("../../src/core/http/cors");

  // `a, b` and `a,b` are the same configuration, and the runbook's `.env` form.
  assert.deepEqual(toList("https://a.com, https://b.com"), ["https://a.com", "https://b.com"]);
  assert.deepEqual(toList("https://a.com,,  ,https://b.com"), ["https://a.com", "https://b.com"]);
  assert.deepEqual(toList(undefined), []);

  // Single origin → the bare string, which is the cheaper per-request path and the
  // shape every existing deployment already uses.
  assert.equal(resolveCorsOrigin("https://amaken-realestate.com"), "https://amaken-realestate.com");

  // Several → a predicate.
  const many = resolveCorsOrigin("https://a.com, https://b.com");
  assert.equal(typeof many, "function");

  const decide = (origin) =>
    new Promise((resolve) => many(origin, (err, allow) => resolve({ err, allow })));

  return (async () => {
    assert.deepEqual(await decide("https://a.com"), { err: null, allow: true });
    assert.deepEqual(await decide("https://b.com"), { err: null, allow: true });

    // The classic CORS bug. A suffix or substring match would admit all of these,
    // and with `credentials: true` that is a readable copy of every authenticated
    // response — which is what the refresh-token cookie makes possible.
    assert.deepEqual(await decide("https://evil-a.com"), { err: null, allow: false });
    assert.deepEqual(await decide("https://a.com.evil.com"), { err: null, allow: false });
    assert.deepEqual(await decide("https://sub.a.com"), { err: null, allow: false });
    // Scheme and port are part of the origin per the URL spec, not decorations.
    assert.deepEqual(await decide("http://a.com"), { err: null, allow: false });
    assert.deepEqual(await decide("https://a.com:8443"), { err: null, allow: false });
    assert.deepEqual(await decide("https://A.com"), { err: null, allow: false }, "case-sensitive");

    // No Origin header: same-origin, curl, server-to-server. CORS constrains
    // browser reads only, so rejecting it would break every non-browser client
    // against no security benefit.
    assert.deepEqual(await decide(undefined), { err: null, allow: true });

    // A wildcard anywhere in the list is the package's own wildcard, not a literal
    // list entry — otherwise `*` would only match a request whose Origin is the
    // literal string "*", and a misconfiguration would look like a working one.
    assert.equal(resolveCorsOrigin("*"), "*");
    assert.equal(resolveCorsOrigin("https://a.com, *"), "*");
  })();
});

test("the TSV export neutralises formula injection and keeps the BOM", () => {
  const { renderTsv, cell, buildWhere, BOM } = require("../../src/platform/queue/jobs/leads-export");

  // Excel evaluates a leading =, +, - or @ when the file is opened. Lead names are
  // attacker-controlled via a public form, so this is the live version of a stored
  // XSS.
  assert.equal(cell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
  assert.equal(cell("+1+1"), "'+1+1");
  assert.equal(cell("-42"), "'-42");
  assert.equal(cell("@SUM(A1)"), "'@SUM(A1)");
  // Not a formula, and not mangled either.
  assert.equal(cell("Ahmed Al-Farsi"), "Ahmed Al-Farsi");

  // A tab inside a cell would shift every column after it.
  assert.equal(cell("a\tb"), "a b");
  assert.equal(cell("line1\nline2"), "line1 line2");
  assert.equal(cell(null), "");
  assert.equal(cell(undefined), "");
  assert.equal(cell(0), "0", "zero is a value, not an absence");

  const tsv = renderTsv([
    {
      id: 1,
      pid: 2,
      title: "Marina",
      name: "=1+1",
      email: "a@b.com",
      nationality: "AE",
      phone: "0500",
      ip: "127.0.0.1",
      device: "curl",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]);

  const lines = tsv.split("\n");
  assert.equal(lines[0], "ID\tPID\tTitle\tName\tEmail\tNationality\tPhone\tIP\tDevice\tCreated At");
  assert.equal(lines[1].split("\t").length, 10, "every row has the same column count");
  assert.ok(lines[1].includes("'=1+1"), "the formula is neutralised");
  assert.ok(lines[1].endsWith("2026-01-01T00:00:00.000Z"));

  assert.ok(BOM.startsWith("\xEF\xBB\xBF"), "Excel needs the BOM to detect UTF-8");
  assert.equal(BOM.charCodeAt(0), 0xef);

  // A range filter only applies in `range` mode; anything else is unfiltered.
  assert.deepEqual(buildWhere({ mode: "all" }), {});
  assert.deepEqual(buildWhere({ mode: "range", from: "2026-01-01" }), {}, "a range needs both bounds");
  const where = buildWhere({ mode: "range", from: "2026-01-01", to: "2026-01-31" });
  assert.equal(where.created_at.gte.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(where.created_at.lte.toISOString(), "2026-01-31T23:59:59.999Z");
});

test("http timeouts are ordered so Node accepts them", () => {
  const { applyTimeouts } = require("../../src/server");
  const { EventEmitter } = require("node:events");

  const server = new EventEmitter();
  server.setTimeout = (ms) => {
    server.socketTimeout = ms;
  };

  // Node throws if `headersTimeout <= keepAliveTimeout`, so the clamp in
  // applyTimeouts is load-bearing rather than defensive.
  applyTimeouts(server, {
    keepAliveTimeoutMs: 65_000,
    headersTimeoutMs: 1, // deliberately wrong order
    requestTimeoutMs: 120_000,
  });

  assert.equal(server.keepAliveTimeout, 65_000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout, "headersTimeout must exceed keepAlive");
  assert.equal(server.requestTimeout, 120_000, "0 would mean unlimited");
  assert.equal(server.socketTimeout, 0, "the socket timeout is disabled on purpose");
});

// ── observability, end to end ───────────────────────────────────────────────

test("GET /metrics serves the Prometheus text format, not the envelope", async () => {
  const { getApp, closeDatabase } = require("../helpers/app");
  const app = getApp();

  await request(app).get("/api/definitely-not-a-route").expect(404);

  const res = await request(app).get("/metrics").expect(200);

  assert.match(res.headers["content-type"], /text\/plain/);
  assert.doesNotMatch(res.text, /"success"/, "a scraper cannot parse the envelope");
  assert.match(res.text, /^# HELP amaken_api_http_request_duration_seconds/m);
  assert.match(res.text, /^amaken_api_up 1$/m);
  // The 404 above must be counted against the `unmatched` bucket.
  assert.match(res.text, /amaken_api_http_requests_total\{[^}]*route="unmatched"[^}]*status="404"\} 1/);
  // …and the scrape request itself is ignored, or every scrape inflates the count.
  assert.doesNotMatch(res.text, /route="\/metrics"/);

  await closeDatabase();
});

// ── response compression ────────────────────────────────────────────────────

/**
 * A probe route mounted into the **real** middleware chain.
 *
 * `createApp({ routes })` swaps the router but keeps every layer above it, so
 * these assertions are about the middleware `src/app.js` actually installs — not
 * about a hand-built copy that can drift from it.
 */
function probeApp() {
  const { buildApp } = require("../helpers/app");
  const express = require("express");
  const router = express.Router();

  // Over `threshold: 1024`, and compressible rather than random: gzip on
  // incompressible input can legitimately come out *larger*, which would make a
  // size assertion flaky rather than meaningful.
  router.get("/__probe__/big", (_req, res) => {
    res.json({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: "a repeated value" })) });
  });
  // Under the threshold.
  router.get("/__probe__/small", (_req, res) => res.json({ ok: true }));
  router.get("/__probe__/image", (_req, res) => {
    res.type("image/webp").send(Buffer.alloc(4096, 7));
  });

  return buildApp({ routes: router });
}

test("a large JSON body is gzipped when the client accepts it, and left alone when it does not", async () => {
  const { closeDatabase } = require("../helpers/app");
  const app = probeApp();

  const gzipped = await request(app).get("/api/__probe__/big").set("Accept-Encoding", "gzip").expect(200);
  assert.equal(gzipped.headers["content-encoding"], "gzip", "a compressible body over the threshold is gzipped");
  // Compression drops the length hint and streams instead, so `content-length`
  // being absent is the evidence it engaged — asserting on the compressed byte
  // count would mean re-implementing the client.
  assert.equal(gzipped.headers["content-length"], undefined, "and the length hint is dropped");
  assert.equal(gzipped.headers["transfer-encoding"], "chunked");
  assert.match(gzipped.headers.vary, /Accept-Encoding/, "and caches are told the answer varies by encoding");
  assert.ok(gzipped.text.length > 1024, "the uncompressed body really was over the threshold");

  // The other half: a client that does not accept gzip gets the plain body, with a
  // length it can trust. Compressing regardless would break every non-browser client.
  const plain = await request(app).get("/api/__probe__/big").set("Accept-Encoding", "identity").expect(200);
  assert.equal(plain.headers["content-encoding"], undefined, "no encoding header without a matching Accept");
  assert.equal(Number(plain.headers["content-length"]), plain.text.length, "and an accurate length");

  // Below `threshold: 1024`. Compressing a 200-byte 401 costs more CPU than it
  // saves, so the size floor is a deliberate trade, not an oversight.
  const small = await request(app).get("/api/__probe__/small").set("Accept-Encoding", "gzip").expect(200);
  assert.equal(small.headers["content-encoding"], undefined, "a body under the threshold is left alone");

  await closeDatabase();
});

test("compression is skipped for images and on request", async () => {
  const { closeDatabase } = require("../helpers/app");
  const app = probeApp();

  // Sharp emits webp. Re-gzipping an already-compressed image burns CPU and
  // makes the file bigger — the single most common way a compression middleware
  // quietly costs more than it saves.
  const image = await request(app).get("/api/__probe__/image").set("Accept-Encoding", "gzip").expect(200);
  assert.equal(image.headers["content-encoding"], undefined, "an image is not gzipped");

  const optedOut = await request(app)
    .get("/api/__probe__/big")
    .set("Accept-Encoding", "gzip")
    .set("X-No-Compression", "1")
    .expect(200);
  assert.equal(optedOut.headers["content-encoding"], undefined, "X-No-Compression is honoured");

  await closeDatabase();
});

// ── CORS ────────────────────────────────────────────────────────────────────

test("CORS admits exactly the configured origins, not anything containing one", async () => {
  const { buildApp, closeDatabase } = require("../helpers/app");
  const config = require("../../src/config");
  const express = require("express");
  const router = express.Router();
  router.get("/__probe__/cors", (_req, res) => res.json({ ok: true }));

  const app = buildApp({
    routes: router,
    config: Object.assign({}, config, {
      http: Object.assign({}, config.http, {
        corsOrigin: "http://localhost:3000, https://admin.amaken-realestate.com",
      }),
    }),
  });

  const allow = async (origin) => {
    const res = await request(app).get("/api/__probe__/cors").set("Origin", origin).expect(200);
    return res.headers["access-control-allow-origin"];
  };

  // Whitespace after the comma must not become part of the origin.
  assert.equal(await allow("http://localhost:3000"), "http://localhost:3000", "the first origin");
  assert.equal(
    await allow("https://admin.amaken-realestate.com"),
    "https://admin.amaken-realestate.com",
    "the second origin, despite the space after the comma"
  );

  // The security assertion, and the reason a list needs the predicate form at all.
  // An unlisted origin must get **no** header rather than the first entry, or the
  // first entry reflected — either would be a policy that reads as configured and
  // is not.
  assert.equal(await allow("https://evil.example"), undefined, "an unlisted origin is not reflected");
  assert.equal(await allow("http://localhost:3000/"), undefined, "a trailing slash is a different origin");
  assert.equal(await allow("https://admin.amaken-realestate.com.evil.example"), undefined, "nor is a suffix attack");
  assert.equal(await allow("http://localhost:3001"), undefined, "nor a neighbouring port");
  assert.equal(await allow("HTTP://LOCALHOST:3000"), undefined, "nor is matching case-insensitive");

  await closeDatabase();
});

test("a single-origin CORS config answers with a constant, which is not a reflection", async () => {
  const { getApp, closeDatabase } = require("../helpers/app");
  const config = require("../../src/config");
  const app = getApp();

  const origin = config.http.corsOrigin.split(",")[0].trim();
  const res = await request(app).get("/api").set("Origin", origin).expect(200);

  // `resolveCorsOrigin` short-circuits to a literal for a one-entry list, so the
  // `cors` package emits that constant regardless of what was requested. Harmless
  // — a browser rejects a header that does not match its own origin — but it is
  // *not* evidence the origin was checked, so it must not be asserted as such.
  assert.equal(res.headers["access-control-allow-origin"], origin);
  assert.notEqual(res.headers["access-control-allow-origin"], "*", "a wildcard is forbidden with credentials");
  assert.equal(res.headers["access-control-allow-credentials"], "true", "credentials are enabled");

  // The list form is the one that actually enforces, and it is covered above.
  assert.ok(origin.includes(":"), "the default config names an explicit origin, never a bare host");

  await closeDatabase();
});

// ── trust proxy ─────────────────────────────────────────────────────────────

test("with TRUST_PROXY=false, X-Forwarded-For cannot change the client identity", async () => {
  const { buildApp, closeDatabase } = require("../helpers/app");
  const config = require("../../src/config");
  const express = require("express");
  const router = express.Router();

  // Echo `req.ip`, because that value *is* the rate-limit key. Testing the
  // identity directly rather than driving 100 requests through the shared limiter
  // keeps this deterministic: the limiter is a module-level singleton, so its
  // counter is already partly spent by whatever ran before.
  router.get("/__probe__/ip", (req, res) => res.json({ ip: req.ip }));

  const app = buildApp({
    routes: router,
    config: Object.assign({}, config, {
      http: Object.assign({}, config.http, { trustProxy: false }),
    }),
  });

  const forged = "203.0.113.7"; // TEST-NET-3, never routable
  const res = await request(app).get("/api/__probe__/ip").set("X-Forwarded-For", forged).expect(200);

  // The runbook's warning as an assertion: trusting the header with no proxy in
  // front lets a client forge its address, and `req.ip` is what
  // express-rate-limit buckets on. If the forged value came through, every
  // request would get its own bucket and the limit would be meaningless.
  assert.notEqual(res.body.ip, forged, "the forged header is not the client identity");
  assert.match(res.body.ip, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/, "it is the socket address instead");

  await closeDatabase();
});

test("with TRUST_PROXY=true, X-Forwarded-For is believed — which is why it is off by default", async () => {
  const { buildApp, closeDatabase } = require("../helpers/app");
  const config = require("../../src/config");
  const express = require("express");
  const router = express.Router();
  router.get("/__probe__/ip", (req, res) => res.json({ ip: req.ip }));

  const app = buildApp({
    routes: router,
    config: Object.assign({}, config, {
      http: Object.assign({}, config.http, { trustProxy: true }),
    }),
  });

  const res = await request(app)
    .get("/api/__probe__/ip")
    .set("X-Forwarded-For", "203.0.113.7")
    .expect(200);

  // This is the whole reason the default is `false`: with a proxy in front the
  // header is the only way to learn the real client address, and believing it
  // with no proxy in front is the vulnerability.
  assert.equal(res.body.ip, "203.0.113.7", "behind a proxy the header is authoritative");

  await closeDatabase();
});
