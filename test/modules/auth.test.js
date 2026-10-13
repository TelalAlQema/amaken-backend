/**
 * `modules/auth` — module contract and security tests.
 *
 * Two separate things are asserted here, and the split matters:
 *
 *   1. **The contract** — the manifest is the only public surface, the router and
 *      the policy agree, and the layering rules hold. These fail when someone
 *      reaches past the boundary. They are the M03 deliverable that makes M04-M07
 *      copyable.
 *   2. **The security work** — refresh rotation, family revocation on replay,
 *      `tokenVersion` invalidation, and the expired/malformed distinction. These
 *      fail when a real regression ships; the M00 contract baseline in
 *      `test/contract/auth.test.js` pins the *interface*, this pins the behaviour.
 *
 * Reaching into the module's internals is deliberate and allowed **here only**.
 * Several assertions are about `token.service.js` in isolation and cannot be
 * expressed over HTTP. The rule this file must not break is the other direction:
 * nothing in `src/` outside the module may import an internal path, and that is
 * asserted below rather than left to review.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { getApp, buildApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, createAdmin, PASSWORD } = require("../helpers/fixtures");
const { userTokens, adminTokens } = require("../helpers/auth");

const authModule = require("../../src/modules/auth");
const tokens = require("../../src/modules/auth/token.service");
const policy = require("../../src/modules/auth/auth.policy");
const config = require("../../src/config");

const SRC = path.join(__dirname, "..", "..", "src");
const MODULE_DIR = path.join(SRC, "modules", "auth");

test.beforeEach(async () => {
  await resetDatabase();
  // The per-token denylist is process-local, so it survives `resetDatabase()` and
  // would leak a denied `jti` from one test into the next. Cleared here rather than
  // in `after()` so a failing test cannot leave the next one red for the wrong
  // reason.
  tokens.clearDenials();
});

test.after(closeDatabase);

/** Every `.js` file under `dir`, recursively. */
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith(".js") ? [full] : [];
  });
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

// ── 1. the manifest is the public surface ───────────────────────────────────

test("contract: importing index.js gives the manifest and nothing else", () => {
  assert.deepEqual(Object.keys(authModule).sort(), ["capabilities", "mounts", "name", "policy"]);

  assert.equal(authModule.name, "auth");
  assert.equal(authModule.mounts.length, 1);
  assert.equal(authModule.mounts[0].path, "/api/auth", "the frontend path must not move");
  assert.equal(typeof authModule.mounts[0].router, "function");
  assert.deepEqual(authModule.mounts[0].guards, []);

  // The manifest must not hand out the service, the repository or the router
  // factory. Anything reachable from here is something every other module can
  // reach, and `authService.completeRegistration` from a property route would be a
  // layering rule with a working import.
  for (const leak of ["service", "repository", "routes", "router", "prisma", "schema", "mapper"]) {
    assert.equal(authModule[leak], undefined, `index.js must not export "${leak}"`);
  }
});

test("contract: the capability surface is exactly the three named token functions", () => {
  assert.deepEqual(Object.keys(authModule.capabilities).sort(), [
    "issueTokenPair",
    "verifyAccessToken",
    "verifyRefreshToken",
  ]);
  assert.deepEqual(Object.keys(authModule.policy).sort(), ["assertDeclared", "declaredRoutes"]);

  for (const fn of Object.values(authModule.capabilities)) {
    assert.equal(typeof fn, "function");
  }
});

test("contract: the module is mounted by registration, and by nothing else", async () => {
  // With the registry emptied, `/api/auth/*` disappears entirely. That proves the
  // mount comes from `registerModules` and not from a stray `app.use` or a leftover
  // line in `src/routes/index.js` — which is exactly how the pre-M03 route was
  // mounted, and exactly what a second mount would duplicate silently.
  const bare = buildApp({ modules: [] });
  await request(bare).post("/api/auth/login").send({}).expect(404);

  // With it restored, the endpoint is back.
  await request(getApp()).post("/api/auth/login").send({}).expect(400);
});

// ── 2. layering ──────────────────────────────────────────────────────────────

test("contract: nothing in src/ outside the module imports a module internal", () => {
  const offenders = [];

  for (const file of jsFiles(SRC)) {
    if (path.dirname(file) === MODULE_DIR) continue;
    const source = read(file);
    // Any `modules/auth/<something>` import where `<something>` is not `index` is a
    // reach past the manifest.
    for (const match of source.matchAll(/require\(\s*["'][^"']*modules\/auth\/([^"']+)["']\s*\)/g)) {
      const target = match[1];
      if (target !== "index") offenders.push(`${path.relative(SRC, file)} → modules/auth/${target}`);
    }
  }

  assert.deepEqual(offenders, [], `internal imports outside the manifest: ${offenders.join(", ")}`);
});

test("contract: auth.routes.js has no try/catch and writes no envelope by hand", () => {
  const source = read(path.join(MODULE_DIR, "auth.routes.js"));

  // Both of these trip on the module's own doc comments, which quote the code they
  // forbid. Stripping comments first is the difference between a rule and a
  // suggestion.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/\btry\s*\{/.test(code), "asyncHandler covers rejection; a try/catch is redundant");
  assert.ok(!/\bcatch\b/.test(code), "catch blocks are how status codes get flattened");
  assert.ok(!/platform\/db\/prisma|@prisma\/client/.test(code));
  assert.ok(
    !/res\.json\(/.test(code),
    "routes use res.ok / res.created so the envelope has one implementation"
  );
});

test("contract: auth.repository.js is the only module file that touches prisma", () => {
  const files = jsFiles(MODULE_DIR).filter((f) => !f.endsWith(`${path.sep}index.js`));
  const prismaUsers = files.filter((f) => /require\([^)]*platform\/db\/prisma|@prisma\/client/.test(read(f)));

  assert.deepEqual(
    prismaUsers.map((f) => path.basename(f)),
    ["auth.repository.js"]
  );
});

test("contract: auth.service.js never touches req or res", () => {
  const source = read(path.join(MODULE_DIR, "auth.service.js"));
  assert.ok(!/\breq\./.test(source) && !/\bres\./.test(source));
  assert.ok(!/express/.test(source));
});

// ── 3. the policy and the router agree ──────────────────────────────────────

test("contract: the policy declares all nine endpoints", () => {
  const declared = policy.declaredRoutes();

  assert.equal(declared.length, 9);
  assert.deepEqual(
    declared.map((d) => d.path).sort(),
    [
      "/forgot-password",
      "/login",
      "/logout",
      "/refresh",
      "/register",
      "/reset-password",
      "/verify-email",
      "/verify-forgot-otp",
      "/verify-otp",
    ]
  );

  for (const route of declared) {
    assert.equal(route.method, "POST");
  }
});

test("contract: every declared operation is actually mounted", async () => {
  for (const route of policy.declaredRoutes()) {
    const res = await request(getApp())
      .post(`/api/auth${route.path}`)
      .send({});

    // An empty body fails validation (400), reaches the handler, or is refused by
    // the domain (4xx) — what it must not do is 404, which would mean the policy
    // describes an endpoint the router does not have.
    assert.notEqual(res.status, 404, `${route.method} /api/auth${route.path} is declared but not mounted`);
  }
});

test("contract: an undeclared operation fails at load time, not at review time", () => {
  assert.throws(() => policy.assertDeclared("change-password"), /has no entry in auth\.policy\.POLICIES/);
});

// ── 4. refresh rotation ──────────────────────────────────────────────────────

test("rotation: a refresh issues a new pair and retires the old refresh token", async () => {
  const user = await createUser();
  const first = userTokens(user.uid, user.uemail);

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(200);

  assert.deepEqual(Object.keys(res.body.data).sort(), ["accessToken", "refreshToken"]);

  // The new refresh token is a different credential, not a copy.
  assert.notEqual(res.body.data.refreshToken, first.refreshToken);

  // And the old one is spent.
  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(401);
});

test("rotation: reusing a rotated token revokes the whole family", async () => {
  const user = await createUser();
  const first = userTokens(user.uid, user.uemail);

  const rotated = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(200);

  // The replay. This is the signature of a stolen token being used after the
  // legitimate client already rotated it.
  const replay = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(401);
  assert.equal(replay.body.error.code, "REFRESH_INVALID");

  // The family is now dead: the token the honest client is holding is revoked too.
  // This is the whole point — a replay means we cannot tell which holder is the
  // thief, so neither keeps the session.
  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: rotated.body.data.refreshToken })
    .expect(401);
});

test("rotation: the new access token from a rotated pair is denied after a replay", async () => {
  const user = await createUser();
  const first = userTokens(user.uid, user.uemail);

  const rotated = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(200);

  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(401);

  // Family revocation covers the access token too, so the stolen *session* dies,
  // not just the ability to refresh. One request, not the full 15-minute lifetime.
  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${rotated.body.data.accessToken}`)
    .expect(401);
});

test("rotation: a token without rotation state is accepted once, so legacy tokens work", async () => {
  // Tokens already in a browser when this deploys carry no rotation record. They
  // must keep working — a deploy that logs everyone out is its own outage.
  const user = await createUser();
  const legacy = userTokens(user.uid, user.uemail);

  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: legacy.refreshToken })
    .expect(200);

  // …and the record is written, so the legacy token is spent like any other.
  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: legacy.refreshToken })
    .expect(401);
});

test("rotation: a fresh token is unaffected by another family's replay", async () => {
  const user = await createUser();
  const other = await createUser({ uemail: "other.user@example.com" });

  const mine = userTokens(user.uid, user.uemail);
  const theirs = userTokens(other.uid, other.uemail);

  await request(getApp()).post("/api/auth/refresh").send({ refreshToken: theirs.refreshToken });
  await request(getApp()).post("/api/auth/refresh").send({ refreshToken: theirs.refreshToken }).expect(401);

  // Revocation is per family. One account's compromise must not log out the world.
  await request(getApp()).post("/api/auth/refresh").send({ refreshToken: mine.refreshToken }).expect(200);
});

// ── 5. tokenVersion ─────────────────────────────────────────────────────────

test("tokenVersion: a password reset invalidates every outstanding token", async () => {
  const user = await createUser();
  const { refreshToken, accessToken } = userTokens(user.uid, user.uemail);

  // Bump it directly, the way `replacePassword` does.
  await prisma.user.update({ where: { uid: user.uid }, data: { tokenVersion: { increment: 1 } } });

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken })
    .expect(401);
  assert.equal(res.body.error.code, "TOKEN_REVOKED");

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(401);
});

test("tokenVersion: a login after a reset mints a token at the new version", async () => {
  const user = await createUser({ tokenVersion: 3 });

  const login = await request(getApp())
    .post("/api/auth/login")
    .send({ email: user.uemail, password: PASSWORD })
    .expect(200);

  const decoded = jwt.decode(login.body.data.refreshToken);
  assert.equal(decoded.tokenVersion, 3, "the claim must carry the row's version, not 0");

  // And it survives a refresh, which is where the comparison happens.
  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: login.body.data.refreshToken })
    .expect(200);
});

test("tokenVersion: a reset-password bumps the row, so the reset is not theatre", async () => {
  const user = await createUser();
  const { refreshToken } = userTokens(user.uid, user.uemail);

  // Seed a valid reset token the way `verifyForgotPasswordOtp` would.
  await require("../../src/platform/cache").set(
    "otp",
    `reset:${user.uemail}`,
    { code: "a".repeat(64), purpose: "reset_token" },
    900
  );

  await request(getApp())
    .post("/api/auth/reset-password")
    .send({ email: user.uemail, resetToken: "a".repeat(64), password: "New@123456" })
    .expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.tokenVersion, 1, "a password reset must bump tokenVersion");

  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken })
    .expect(401);
});

// ── 6. expired vs malformed ─────────────────────────────────────────────────

test("claims: an expired access token is distinguishable from a forged one", async () => {
  const user = await createUser();

  const expired = jwt.sign(
    { userId: user.uid, email: user.uemail, role: "user", type: "access", jti: "x", fam: "f", tokenVersion: 0 },
    config.jwt.secret,
    { expiresIn: "-1s" }
  );

  const expiredRes = await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${expired}`)
    .expect(401);
  assert.equal(expiredRes.body.error.code, "TOKEN_EXPIRED");

  // A client that sees this refreshes. A client that sees TOKEN_INVALID signs in
  // again — which is why the two cannot be the same code.
  const forgedRes = await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${jwt.sign({ userId: 1, role: "admin" }, "not-the-secret")}`)
    .expect(401);
  assert.equal(forgedRes.body.error.code, "TOKEN_INVALID");

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", "Bearer not.a.jwt")
    .expect(401);
});

test("claims: an access token cannot be used as a refresh token", async () => {
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: accessToken })
    .expect(401);
});

test("claims: a token signed with the refresh secret is not an access token", async () => {
  const user = await createUser();

  const wrongSecret = jwt.sign(
    { userId: user.uid, email: user.uemail, role: "admin", type: "access", tokenVersion: 0 },
    config.jwt.refreshSecret,
    { expiresIn: "15m" }
  );

  // The two secrets are separate, so a refresh token cannot be escalated into an
  // admin access token by replaying it at `Authorization`.
  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${wrongSecret}`)
    .expect(401);
});

// ── 7. revocation via logout ────────────────────────────────────────────────

test("logout: the presented token stops working", async () => {
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  await request(getApp())
    .post("/api/auth/logout")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(401);
});

test("logout: still succeeds without a token, and revokes nothing", async () => {
  // Logout is the one endpoint a client calls *because* its token has expired.
  // Making it conditional would turn "log me out" into a 401 loop.
  await request(getApp()).post("/api/auth/logout").expect(200);

  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);
  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);
});

// ── 8. the denylist is bounded ──────────────────────────────────────────────

test("revocation: revoking a token denies the whole family, not one string", async () => {
  const user = await createUser();
  const { accessToken, refreshToken } = userTokens(user.uid, user.uemail);

  assert.equal(tokens.deniedKeyCount(), 0);

  // Two keys, not one: the presented token's own `jti` and the family it belongs
  // to. The family is the point — the refresh token shares it, so revoking an
  // access token at logout ends the session instead of leaving a live way back in.
  assert.equal(tokens.revoke(accessToken), true);
  assert.equal(tokens.deniedKeyCount(), 2);

  await request(getApp())
    .get("/api/users/me")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(401);

  assert.equal(tokens.revoke(refreshToken), false, "a refresh token is not an access token");

  tokens.clearDenials();
  assert.equal(tokens.deniedKeyCount(), 0);
});

// ── 9. admin refresh shares the endpoint ────────────────────────────────────

test("refresh: an admin token rotates through the same endpoint", async () => {
  const admin = await createAdmin();
  const first = adminTokens(admin.aid, admin.aemail);

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(200);

  const decoded = jwt.decode(res.body.data.accessToken);
  assert.equal(decoded.role, "admin");
  assert.equal(decoded.userId, admin.aid);

  await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken: first.refreshToken })
    .expect(401);
});

test("refresh: a token for a deleted account is refused", async () => {
  const user = await createUser();
  const { refreshToken } = userTokens(user.uid, user.uemail);

  await prisma.user.delete({ where: { uid: user.uid } });

  const res = await request(getApp())
    .post("/api/auth/refresh")
    .send({ refreshToken })
    .expect(404);
  assert.equal(res.body.error.code, "USER_NOT_FOUND");
});