/**
 * Test database provisioning.
 *
 * Derives an isolated database from DATABASE_URL (see test/helpers/env.js) so
 * tests can never touch development or production data, then pushes the Prisma
 * schema into it.
 *
 *   node scripts/test-db.js reset   # drop, recreate, push schema
 *   node scripts/test-db.js ensure  # create + push only if missing
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { BASE_URL, TEST_DB_NAME, testDatabaseUrl, assertSafeTestDatabase } = require("../test/helpers/env");

assertSafeTestDatabase(TEST_DB_NAME);

console.log(`[test-db] target : ${TEST_DB_NAME}`);

const command = process.argv[2] || "ensure";

async function withSourceClient(fn) {
  const { PrismaClient } = require("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: BASE_URL } } });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

function pushSchema() {
  // Resolve the local Prisma CLI and run it through this same Node binary.
  // Spawning npx/.bin shims fails with EINVAL on Windows under a non-cmd shell.
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--skip-generate", "--force-reset", "--accept-data-loss"],
    {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
      stdio: "inherit",
    }
  );
}

(async () => {
  try {
    if (command === "reset") {
      await withSourceClient((client) =>
        client.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\``)
      );
      console.log(`[test-db] dropped ${TEST_DB_NAME}`);
    }

    await withSourceClient((client) =>
      client.$executeRawUnsafe(
        `CREATE DATABASE IF NOT EXISTS \`${TEST_DB_NAME}\` ` +
          "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
      )
    );
    console.log(`[test-db] database ready`);

    pushSchema();
    console.log(`[test-db] schema pushed to ${TEST_DB_NAME}`);
  } catch (err) {
    console.error("[test-db] failed:", err.message);
    process.exit(1);
  }
})();
