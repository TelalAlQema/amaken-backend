/**
 * Authenticated user contract baseline.
 *
 * Covers /api/users/me* and the self-service block/unblock pair. Passes on
 * unmodified src/ — including the IDOR assertion at the bottom, which documents
 * the current (vulnerable) behaviour so M00.6 has something to invert.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { getApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, createProperty, PASSWORD } = require("../helpers/fixtures");
const { userAccessToken } = require("../helpers/auth");

/** Authenticated request helper. */
function as(user) {
  return {
    get: (p) => request(getApp()).get(p).set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`),
    put: (p) => request(getApp()).put(p).set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`),
    post: (p) => request(getApp()).post(p).set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`),
    del: (p) => request(getApp()).delete(p).set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`),
  };
}

test.beforeEach(resetDatabase);
test.after(closeDatabase);

// ── GET /api/users/me ───────────────────────────────────────────────────────

test("GET /api/users/me returns the full user row", async () => {
  const user = await createUser();

  const res = await as(user).get("/api/users/me").expect(200);

  assert.equal(res.body.success, true);
  // Raw Prisma row — the frontend expects uid/uname/lname/uemail/uimage.
  assert.equal(res.body.data.uid, user.uid);
  assert.equal(res.body.data.uemail, user.uemail);
  assert.ok("uname" in res.body.data);
  assert.ok("uimage" in res.body.data);
});

test("GET /api/users/me returns 401 without a token", async () => {
  const res = await request(getApp()).get("/api/users/me").expect(401);
  assert.equal(res.body.error.code, "AUTH_REQUIRED");
});

test("GET /api/users/me returns 401 for a malformed Authorization header", async () => {
  const res = await request(getApp())
    .get("/api/users/me")
    .set("Authorization", "Basic abc123")
    .expect(401);

  assert.equal(res.body.error.code, "AUTH_REQUIRED");
});

test("GET /api/users/me returns 401 for a garbage bearer token", async () => {
  const res = await request(getApp())
    .get("/api/users/me")
    .set("Authorization", "Bearer not.a.jwt")
    .expect(401);

  assert.equal(res.body.error.code, "TOKEN_INVALID");
});

// ── PUT /api/users/me ───────────────────────────────────────────────────────

test("PUT /api/users/me updates the profile", async () => {
  const user = await createUser();

  const res = await as(user)
    .put("/api/users/me")
    .send({ uname: "Updated", lname: "Name", company: "Amaken Realty" })
    .expect(200);

  assert.equal(res.body.success, true);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.uname, "Updated");
  assert.equal(row.company, "Amaken Realty");
});

test("PUT /api/users/me rejects an invalid body with 400", async () => {
  const user = await createUser();

  const res = await as(user)
    .put("/api/users/me")
    .send({ uname: "" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

// ── password ────────────────────────────────────────────────────────────────

test("PUT /api/users/me/password enforces the strong-password policy", async () => {
  const user = await createUser();

  const res = await as(user)
    .put("/api/users/me/password")
    .send({ currentPassword: PASSWORD, newPassword: "weak" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

test("PUT /api/users/me/password rejects a wrong current password with 400", async () => {
  const user = await createUser();

  // Pinned: a wrong CURRENT password is a validation problem, not an auth
  // failure, so it is 400 PASSWORD_INCORRECT (user.service.js:237) — not 401.
  const res = await as(user)
    .put("/api/users/me/password")
    .send({ currentPassword: "Wrong@12345", newPassword: "New@12345" })
    .expect(400);

  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "PASSWORD_INCORRECT");
});

test("PUT /api/users/me/password changes the password, and the old one stops working", async () => {
  const user = await createUser();
  const NEW_PASSWORD = "New@12345";

  await as(user)
    .put("/api/users/me/password")
    .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
    .expect(200);

  // Old password rejected.
  await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: PASSWORD })
    .expect(401);

  // New password accepted.
  const login = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: NEW_PASSWORD })
    .expect(200);

  assert.ok(login.body.data.accessToken);
});

// ── links ───────────────────────────────────────────────────────────────────

test("PUT /api/users/me/links persists social links", async () => {
  const user = await createUser();

  await as(user)
    .put("/api/users/me/links")
    .send({ fb: "https://fb.com/x", linkedin: "https://li.com/x" })
    .expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.fb, "https://fb.com/x");
  assert.equal(row.linkedin, "https://li.com/x");
});

// ── deactivate / activate / delete ──────────────────────────────────────────

test("POST /api/users/me/deactivate sets deactivate=0", async () => {
  const user = await createUser();

  await as(user).post("/api/users/me/deactivate").expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.deactivate, 0);
});

test("POST /api/users/me/activate reverses deactivation", async () => {
  const user = await createUser({ deactivate: 0 });

  await as(user).post("/api/users/me/activate").expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.deactivate, 1);
});

test("DELETE /api/users/me hard-deletes the row and writes NO ledger", async () => {
  const user = await createUser();

  const res = await as(user).del("/api/users/me").expect(200);

  assert.equal(res.body.success, true);

  // deleteAccount (user.service.js:290) prunes images then issues a hard
  // prisma.user.delete. Unlike the admin delete path, it writes no DelAccount
  // row, so the address is immediately re-registerable and the deletion leaves
  // no audit trail. Pinned here; M00.6 introduces the ledger.
  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row, null, "user row is hard-deleted");

  const ledger = await prisma.delAccount.findFirst({ where: { email: user.uemail } });
  assert.equal(ledger, null, "self-delete writes no DelAccount ledger row");
});

// ── own properties ──────────────────────────────────────────────────────────

test("GET /api/properties/my lists the caller's own properties", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, title: "Mine" });

  const res = await as(user).get("/api/properties/my").expect(200);

  assert.ok(Array.isArray(res.body.data.items));
  assert.equal(res.body.data.items.length, 1);
});

test("GET /api/properties/my returns 403 for an admin token (requireRole user)", async () => {
  const { createAdmin } = require("../helpers/fixtures");
  const { adminAccessToken } = require("../helpers/auth");
  const admin = await createAdmin();

  const res = await request(getApp())
    .get("/api/properties/my")
    .set("Authorization", `Bearer ${adminAccessToken(admin.aid, admin.aemail)}`)
    .expect(403);

  assert.equal(res.body.error.code, "FORBIDDEN");
});

// ── block / unblock: the IDOR ───────────────────────────────────────────────

test("POST /api/users/block/:id blocks the user named in the path", async () => {
  const user = await createUser();

  const res = await as(user).post(`/api/users/block/${user.uid}`).expect(200);

  assert.equal(res.body.success, true);
  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.adminblock, 1, "adminblock set to 1");
});

test("SECURITY: any authenticated user can block a DIFFERENT user (IDOR)", async () => {
  // FIXME(M00.6): user.routes.js:227 passes the path id straight to blockSelf
  // with no check that it matches req.user.id. Any logged-in user can block any
  // other account. The fixed test asserts the target is left untouched.
  const attacker = await createUser({ uemail: "attacker@example.com" });
  const victim = await createUser({ uemail: "victim@example.com" });

  const res = await as(attacker).post(`/api/users/block/${victim.uid}`).expect(200);

  assert.equal(res.body.success, true);

  const victimRow = await prisma.user.findFirst({ where: { uid: victim.uid } });
  assert.equal(victimRow.adminblock, 1, "victim was blocked by the attacker");
});

test("POST /api/users/block/:id returns 404 for a nonexistent user", async () => {
  const user = await createUser();

  const res = await as(user).post("/api/users/block/999999").expect(404);

  assert.equal(res.body.error.code, "USER_NOT_FOUND");
});

test("POST /api/users/block/:id returns 400 for a non-numeric id", async () => {
  const user = await createUser();

  const res = await as(user).post("/api/users/block/abc").expect(400);

  assert.equal(res.body.error.message, "Invalid user ID");
});

test("POST /api/users/unblock/:id restores a blocked user", async () => {
  const user = await createUser({ adminblock: 1 });

  await as(user).post(`/api/users/unblock/${user.uid}`).expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.adminblock, 0);
});

test("POST /api/users/block/:id also blocks the user's properties", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid });

  await as(user).post(`/api/users/block/${user.uid}`).expect(200);

  // Scoped by `{ uid, email: uemail }` (user.service.js:304) — a property whose
  // email column drifted from the owner's uemail would stay visible here.
  const prop = await prisma.property.findFirst({ where: { uid: user.uid } });
  assert.equal(prop.blocked_user, 0, "property blocked_user set to 0");
});

test("POST /api/users/unblock/:id restores the user's properties", async () => {
  const user = await createUser({ adminblock: 1 });
  await createProperty({ uid: user.uid, blocked_user: 0 });

  await as(user).post(`/api/users/unblock/${user.uid}`).expect(200);

  const prop = await prisma.property.findFirst({ where: { uid: user.uid } });
  assert.equal(prop.blocked_user, 1);
});
