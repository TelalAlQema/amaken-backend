/**
 * Harness smoke test.
 *
 * Proves the M00.2 plumbing works end to end: in-process app, isolated test
 * database, fixtures, tokens, cleanup. If this fails, nothing else in the suite
 * is trustworthy.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { getApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, createAdmin, PASSWORD } = require("../helpers/fixtures");
const { userAccessToken, adminAccessToken } = require("../helpers/auth");

test.after(async () => {
  await closeDatabase();
});

test("harness: app builds without binding a port", async () => {
  const app = getApp();
  assert.ok(typeof app === "function", "express app is a request handler");
  assert.equal(app.get("env"), "test");
});

test("harness: GET /health responds", async () => {
  const res = await request(getApp()).get("/health").expect(200);
  assert.equal(res.body.status, "ok");
  assert.ok(res.body.timestamp);
});

test("harness: test database is isolated from the source database", () => {
  const { TEST_DB_NAME, baseDbName } = require("../helpers/env");
  assert.notEqual(TEST_DB_NAME, baseDbName, "test DB must differ from DATABASE_URL's DB");
  assert.ok(process.env.DATABASE_URL.includes(TEST_DB_NAME));
});

test("harness: fixtures persist and resetDatabase empties them", async () => {
  await resetDatabase();

  const user = await createUser();
  assert.ok(user.uid > 0);
  assert.equal(user.uemail, "test.user@example.com");

  await resetDatabase();
  assert.equal(await prisma.user.count(), 0);
});

test("harness: tokens authenticate against a protected route", async () => {
  await resetDatabase();
  const user = await createUser();
  const admin = await createAdmin();

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`)
    .expect(200);

  await request(getApp())
    .get("/api/admin/profile")
    .set("Authorization", `Bearer ${adminAccessToken(admin.aid, admin.aemail)}`)
    .expect(200);

  await resetDatabase();
});

test("harness: the seeded password verifies against bcrypt", async () => {
  await resetDatabase();
  const user = await createUser();

  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: PASSWORD })
    .expect(200);

  assert.ok(res.body.data.accessToken);
  assert.ok(res.body.data.refreshToken);

  await resetDatabase();
});
