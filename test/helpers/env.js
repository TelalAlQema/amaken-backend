/**
 * Test environment.
 *
 * Single source of truth for the derived test database URL. Used by both
 * `scripts/test-db.js` and the in-process test app, so they cannot drift.
 *
 * Importing this module loads .env and points DATABASE_URL at the test
 * database. It must therefore be required BEFORE anything that touches prisma.
 */
const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const BASE_URL = process.env.DATABASE_URL;
const TEST_DB_NAME = process.env.TEST_DB_NAME || "amaken_db_test";

if (!BASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

const baseUrl = new URL(BASE_URL);
const baseDbName = baseUrl.pathname.slice(1);

/**
 * Guards against a test run silently wiping a real database.
 * Two independent checks: the name must look like a test database, and it
 * must not be the database DATABASE_URL already points at.
 */
function assertSafeTestDatabase(name) {
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to use "${name}" — the name must end with "_test".`);
  }
  if (name === baseDbName) {
    throw new Error(
      `DATABASE_URL already points at "${name}". Set DATABASE_URL to a non-test database.`
    );
  }
}

function testDatabaseUrl() {
  const url = new URL(BASE_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

/**
 * Point this process at the test database. Must run before prisma is required,
 * because the client reads DATABASE_URL at construction time.
 *
 * It also **disables the queue**, puts the rate-limit store in its in-process
 * mode, and raises the rate-limit *budgets*, which is the whole of the test policy
 * now that there is no second shared dependency to isolate:
 *
 *   - `QUEUE_ENABLED=false` stops every request that would enqueue an OTP email
 *     from writing a row the suite would then have to clean up, and stops
 *     `platform/queue`'s fail-open path from being on the hot path of a test that
 *     is asserting something else. The queue is covered directly, in
 *     `test/unit/queue.test.js`, where enqueueing is the thing under test.
 *
 *   - `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` are raised, not disabled. The
 *     limiter still runs on every request; only the number of requests a single
 *     process may spend is raised. This matters because the counters live in a
 *     per-process `MemoryStore` that no test can reach to reset, and a file that
 *     makes ~45 `/api/auth` calls — `test/modules/auth.test.js` does, testing
 *     rotation and revocation — would otherwise start failing with 429 partway
 *     through, and the failure would look like a security regression.
 *
 * Nothing else is isolated because nothing else is shared: the cache's durable
 * tier and the queue are rows in the same test database this module already points
 * at, so `prisma.job.deleteMany()` / `prisma.kvEntry.deleteMany()` are a complete
 * reset. A test that wants the durable tier live sets `QUEUE_ENABLED=true` itself.
 *
 * There is deliberately no rate-limit-*store* variable. The store is not
 * configurable in this build — `core/http/rateLimit.js` hardcodes `MemoryStore` —
 * so a knob here would be a setting that silently does nothing.
 *
 * ## Testing that the limiter works
 *
 * No test asserts a 429 today, and none of these values prevent one: a test that
 * wants the real behaviour builds its own limiter with a low `max` via the
 * exported `createLimiter` and mounts it, which is why that factory is exported at
 * all. What these values remove is the *incidental* limit, not the mechanism.
 */
function useTestDatabase() {
  assertSafeTestDatabase(TEST_DB_NAME);

  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.NODE_ENV = "test";

  // Explicitly `false`, not left unset: `QUEUE_ENABLED` defaults to true, and
  // "whatever the schema says" is not a test policy.
  process.env.QUEUE_ENABLED = process.env.QUEUE_ENABLED || "false";

  // Explicitly high, not unset: an unset value falls back to the production
  // default of 20 auth requests per window, and the suite shares one IP.
  process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "10000";
  process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || "10000";

  return process.env.DATABASE_URL;
}

module.exports = {
  BASE_URL,
  TEST_DB_NAME,
  baseDbName,
  testDatabaseUrl,
  useTestDatabase,
  assertSafeTestDatabase,
};
