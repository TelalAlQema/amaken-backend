/**
 * Auth contract baseline.
 *
 * Pins the status code, envelope keys and payload shape of all 9 /api/auth
 * endpoints against the current implementation. These pass on unmodified src/.
 *
 * Deliberately excludes OTP-delivery flows that require a live SMTP server —
 * see test/contract/divergences.test.js for those, which are documented instead
 * of asserted.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { getApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, PASSWORD } = require("../helpers/fixtures");
const { userTokens } = require("../helpers/auth");

test.beforeEach(resetDatabase);
test.after(closeDatabase);

test("POST /api/auth/login returns a token pair and a user summary", async () => {
  const user = await createUser();

  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: PASSWORD })
    .expect(200);

  assert.equal(res.body.success, true);
  assert.ok(res.body.data.accessToken, "accessToken");
  assert.ok(res.body.data.refreshToken, "refreshToken");

  // Exact key set — the frontend reads user.id / .email / .name / .type / .image
  assert.deepEqual(Object.keys(res.body.data).sort(), [
    "accessToken",
    "refreshToken",
    "user",
  ]);
  assert.deepEqual(Object.keys(res.body.data.user).sort(), [
    "email",
    "id",
    "image",
    "name",
    "type",
  ]);
  assert.equal(res.body.data.user.id, user.uid);
  assert.equal(res.body.data.user.email, user.uemail);
  assert.equal(res.body.data.user.name, "Test User");
  assert.equal(res.body.data.user.type, "User");
});

test("POST /api/auth/login rejects a wrong password with 401 AUTH_FAILED", async () => {
  const user = await createUser();

  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: "Wrong@12345" })
    .expect(401);

  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "AUTH_FAILED");
});

test("POST /api/auth/login returns 401 for an unknown email, without leaking which", async () => {
  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: "nobody@example.com", password: PASSWORD })
    .expect(401);

  assert.equal(res.body.error.code, "AUTH_FAILED");
  assert.equal(res.body.error.message, "Email or password does not match");
});

test("POST /api/auth/login returns 403 for a deleted account", async () => {
  const user = await createUser();
  await prisma.delAccount.create({
    data: { email: user.uemail, type: "deleted", utype: "User" },
  });

  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: PASSWORD })
    .expect(403);

  assert.equal(res.body.error.code, "ACCOUNT_BLOCKED");
});

test("POST /api/auth/login rejects a malformed body with 400 VALIDATION_ERROR", async () => {
  const res = await request(getApp())
    .post("/api/auth/login")
    .send({ email: "not-an-email", password: "x" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
  assert.match(res.body.error.message, /email/);
});

test("POST /api/auth/refresh returns a NEW pair for a valid user refresh token", async () => {
  const user = await createUser();
  const { refreshToken } = userTokens(user.uid, user.uemail);

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken })
    .expect(200);

  assert.equal(res.body.success, true);
  assert.ok(res.body.data.accessToken);
  assert.ok(res.body.data.refreshToken);
  // The frontend writes both straight back to localStorage.
  assert.deepEqual(Object.keys(res.body.data).sort(), ["accessToken", "refreshToken"]);
});

test("POST /api/auth/refresh is shared by user and admin (single endpoint)", async () => {
  const admin = await createAdminFixture();
  const { refreshToken } = adminTokensFor(admin);

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken })
    .expect(200);

  assert.ok(res.body.data.accessToken);
  assert.ok(res.body.data.refreshToken);
});

test("POST /api/auth/refresh rejects an access token used as a refresh token", async () => {
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: accessToken })
    .expect(401);

  assert.equal(res.body.success, false);
});

test("POST /api/auth/register creates a user and returns a token pair", async () => {
  const res = await request(getApp())
    .post("/api/auth/register")
    .send({
      email: "New.User@Example.com",
      uname: "New",
      lname: "User",
      phone: "+971500000010",
      password: "Test@12345",
      utype: "Agent",
    })
    .expect(201);

  assert.equal(res.body.success, true);
  assert.ok(res.body.data.accessToken);
  assert.ok(res.body.data.refreshToken);
  assert.equal(res.body.data.user.type, "Agent");

  // Email is normalised to lower case.
  const created = await prisma.user.findFirst({ where: { uemail: "new.user@example.com" } });
  assert.ok(created, "user was persisted with a lower-cased email");

  // A ledger row is written as a side effect.
  const ledger = await prisma.registerEmail.findFirst({
    where: { email: "new.user@example.com" },
  });
  assert.ok(ledger, "registerEmail ledger row written");
});

test("POST /api/auth/register rejects a duplicate email with 409 EMAIL_EXISTS", async () => {
  const user = await createUser();

  const res = await request(getApp())
    .post("/api/auth/register")
    .send({
      email: user.uemail,
      uname: "Dup",
      lname: "Licate",
      phone: "+971500000011",
      password: "Test@12345",
      utype: "User",
    })
    .expect(409);

  assert.equal(res.body.error.code, "EMAIL_EXISTS");
});

test("POST /api/auth/register enforces the strong-password policy", async () => {
  const res = await request(getApp())
    .post("/api/auth/register")
    .send({
      email: "weak@example.com",
      uname: "Weak",
      lname: "Password",
      phone: "+971500000012",
      password: "weakpassword",
      utype: "User",
    })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
  assert.match(res.body.error.message, /uppercase|special|number/i);
});

test("POST /api/auth/forgot-password returns 404 EMAIL_NOT_FOUND for an unknown email", async () => {
  const res = await request(getApp())
    .post("/api/auth/forgot-password")
    .send({ email: "nobody@example.com" })
    .expect(404);

  assert.equal(res.body.error.code, "EMAIL_NOT_FOUND");
});

test("POST /api/auth/verify-otp rejects a wrong code with 400 OTP_INVALID", async () => {
  const res = await request(getApp())
    .post("/api/auth/verify-otp")
    .send({ email: "test.user@example.com", code: "000000" })
    .expect(400);

  assert.equal(res.body.error.code, "OTP_INVALID");
});

test("POST /api/auth/verify-forgot-otp rejects a wrong code with 400 OTP_INVALID", async () => {
  const res = await request(getApp())
    .post("/api/auth/verify-forgot-otp")
    .send({ email: "test.user@example.com", code: "000000" })
    .expect(400);

  assert.equal(res.body.error.code, "OTP_INVALID");
});

test("POST /api/auth/reset-password validates the body before touching state", async () => {
  const res = await request(getApp())
    .post("/api/auth/reset-password")
    .send({ email: "test.user@example.com", resetToken: "x", password: "short" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

test("POST /api/auth/logout returns 200 with a message", async () => {
  const res = await request(getApp()).post("/api/auth/logout").expect(200);

  assert.equal(res.body.success, true);
  assert.ok(res.body.data.message || res.body.data);
});

// ── local helpers ──────────────────────────────────────────────────────────

async function createAdminFixture() {
  const { createAdmin } = require("../helpers/fixtures");
  return createAdmin();
}

function adminTokensFor(admin) {
  const { adminTokens } = require("../helpers/auth");
  return adminTokens(admin.aid, admin.aemail);
}
