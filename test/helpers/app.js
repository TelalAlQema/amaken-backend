/**
 * In-process test app and database helpers.
 *
 * As of M01 there is no mirror any more. This used to rebuild
 * `src/index.js`'s middleware chain by hand — 60 duplicated lines, held honest
 * by `test/contract/route-parity.test.js` — because the old composition root
 * called `listen()` at require time and there was no way to get an app without a
 * port. `createApp()` is that way, so the app under test is now literally the
 * app that runs in production, and the parity test is free to spend its budget
 * on the route table instead.
 *
 * What remains here is the harness: repoint `DATABASE_URL` at the isolated test
 * database *before* anything reads config, then expose the DB utilities.
 *
 * IMPORTANT — tests must run serially (`--test-concurrency=1`).
 * `node --test` runs each test FILE in its own concurrent process, and all of
 * them share the single `amaken_db_test` database. Every file's beforeEach
 * truncates it, so concurrent files wipe each other's fixtures mid-test. The
 * symptom is tests that pass alone and fail in `pnpm test`. Per-file schema
 * isolation lands in M03; until then serial execution is the contract.
 */

// Must run before `createApp` or the app graph is required. `src/config` loads
// .env and freezes its values at require time, and the Prisma client reads
// DATABASE_URL when it is constructed — so the test database has to be selected
// before either of them is loaded, not patched in afterwards.
const { useTestDatabase } = require("./env");
useTestDatabase();

const { createApp } = require("../../src/app");
const { prisma } = require("../../src/platform/db/prisma");

/**
 * @param {object} [deps] forwarded to `createApp`, e.g. a capturing logger.
 * @returns {import("express").Application}
 */
function buildApp(deps) {
  return createApp(deps);
}

let cachedApp = null;

function getApp() {
  if (!cachedApp) cachedApp = buildApp();
  return cachedApp;
}

// ── database helpers ────────────────────────────────────────────────────────

/**
 * Physical table names, discovered rather than hardcoded.
 *
 * Prisma model names are not table names: `RegisterEmail` is @map("register_email").
 * Querying information_schema keeps this correct when the schema changes.
 */
async function listTables() {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' " +
      "AND table_name <> '_prisma_migrations' " +
      "ORDER BY table_name"
  );
  return rows.map((r) => r.name);
}

/**
 * Empties every table. TRUNCATE is blocked by foreign keys, so FK checks are
 * suspended for the duration. Faster and simpler than deleting row by row.
 */
async function resetDatabase() {
  const tables = await listTables();
  await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of tables) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await prisma.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
  }
}

async function closeDatabase() {
  await prisma.$disconnect();
}

module.exports = { getApp, buildApp, createApp, resetDatabase, closeDatabase, listTables, prisma };
