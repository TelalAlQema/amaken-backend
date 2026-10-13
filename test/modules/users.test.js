/**
 * `modules/users` — module contract and behaviour tests.
 *
 * The shape of this file follows `test/modules/auth.test.js`, and the first half is
 * deliberately mechanical: manifest surface, layering, policy/router agreement. Those
 * are the assertions that catch someone reaching past the boundary, which is the whole
 * failure mode M04 exists to prevent. They need no database.
 *
 * The second half pins the two behaviours M04 actually changed here — the anonymous
 * profile route, and the password path that moved to `core/password`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const { getApp, buildApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, PASSWORD } = require("../helpers/fixtures");
const { userTokens } = require("../helpers/auth");

const usersModule = require("../../src/modules/users");
const policy = require("../../src/modules/users/users.policy");
const password = require("../../src/core/password");

const SRC = path.join(__dirname, "..", "..", "src");
const MODULE_DIR = path.join(SRC, "modules", "users");

test.beforeEach(resetDatabase);
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
  assert.deepEqual(Object.keys(usersModule).sort(), ["mounts", "name", "policy"]);

  assert.equal(usersModule.name, "users");
  assert.equal(usersModule.mounts.length, 1);
  assert.equal(usersModule.mounts[0].path, "/api/users", "the frontend path must not move");
  assert.equal(typeof usersModule.mounts[0].router, "function");

  // No `capabilities`: this module owns no shared surface. Anything reaching it goes
  // through its URL, which means the route table is the complete dependency list.
  assert.equal(usersModule.capabilities, undefined);

  for (const leak of ["service", "repository", "routes", "router", "prisma", "schema", "mapper", "policyFile"]) {
    assert.equal(usersModule[leak], undefined, `index.js must not export "${leak}"`);
  }
});

test("contract: the module is mounted by registration, and by nothing else", async () => {
  const bare = buildApp({ modules: [] });
  await request(bare).get("/api/users/me").expect(404);

  await request(getApp()).get("/api/users/me").expect(401);
});

// ── 2. layering ──────────────────────────────────────────────────────────────

test("contract: nothing in src/ outside the module imports a module internal", () => {
  const offenders = [];

  for (const file of jsFiles(SRC)) {
    if (path.dirname(file) === MODULE_DIR) continue;
    const source = read(file);
    for (const match of source.matchAll(/require\(\s*["'][^"']*modules\/users\/([^"']+)["']\s*\)/g)) {
      const target = match[1];
      if (target !== "index") offenders.push(`${path.relative(SRC, file)} → modules/users/${target}`);
    }
  }

  assert.deepEqual(offenders, [], `internal imports outside the manifest: ${offenders.join(", ")}`);
});

test("contract: users.routes.js has no try/catch and writes no envelope by hand", () => {
  const source = read(path.join(MODULE_DIR, "users.routes.js"));

  // Strip comments first — both rules trip on the file's own doc comments, which quote
  // the code they forbid.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/\btry\s*\{/.test(code), "asyncHandler covers rejection; a try/catch is redundant");
  assert.ok(!/\bcatch\b/.test(code), "catch blocks are how status codes get flattened");
  assert.ok(!/platform\/db\/prisma|@prisma\/client/.test(code));
  assert.ok(!/res\.json\(/.test(code), "routes use res.ok so the envelope has one implementation");
});

test("contract: users.repository.js is the only module file that touches prisma", () => {
  const files = jsFiles(MODULE_DIR).filter((f) => !f.endsWith(`${path.sep}index.js`));
  const prismaUsers = files.filter((f) => /require\([^)]*platform\/db\/prisma|@prisma\/client/.test(read(f)));

  assert.deepEqual(prismaUsers.map((f) => path.basename(f)), ["users.repository.js"]);
});

test("contract: the service reaches storage only through the port, and bcrypt only through core/password", () => {
  const service = read(path.join(MODULE_DIR, "users.service.js"));

  assert.ok(!/require\([^)]*bcrypt/.test(service), "hash comparison is core/password's job");
  assert.ok(!/sha1|sha256|createHash/.test(service), "no legacy bare-digest fallback");
  assert.ok(
    /require\([^)]*platform\/storage/.test(service),
    "the module must go through the storage port, not rebuild upload paths"
  );
});

// ── 3. the policy and the router agree ──────────────────────────────────────

test("contract: the policy declares all fourteen endpoints", () => {
  const declared = policy.declaredRoutes();

  assert.equal(declared.length, 14);

  // Fourteen *declarations* over ten paths: `/me` is GET/PUT/DELETE and `/me/avatar`
  // and `/me/logo` are each POST/DELETE. Sorted as a list, not a set, so a duplicate or
  // a dropped declaration cannot hide behind `Set` semantics.
  assert.deepEqual(
    declared.map((d) => `${d.method} ${d.path}`).sort(),
    [
      "DELETE /me",
      "DELETE /me/avatar",
      "DELETE /me/logo",
      "GET /:id",
      "GET /me",
      "POST /block/:id",
      "POST /me/activate",
      "POST /me/avatar",
      "POST /me/deactivate",
      "POST /me/logo",
      "POST /unblock/:id",
      "PUT /me",
      "PUT /me/links",
      "PUT /me/password",
    ]
  );

  // The frozen table is GET/PUT/POST/DELETE by path; this catches a method silently
  // changing on a path that still looks right.
  for (const route of declared) {
    assert.ok(["GET", "POST", "PUT", "DELETE"].includes(route.method), `bad method on ${route.path}`);
    assert.ok(policy.Principal[route.principal.toUpperCase()], `bad principal on ${route.path}`);
  }
});

test("contract: exactly one route is anonymous, and it is the public profile", () => {
  const anonymous = policy.declaredRoutes().filter((r) => r.principal === policy.Principal.ANONYMOUS);

  assert.deepEqual(anonymous.map((r) => `${r.method} ${r.path}`), ["GET /:id"]);

  // `/:id` is a wildcard for a router, so its position matters: `/me` and `/block/:id`
  // must be declared before it or they are shadowed. Asserted on the router below too,
  // but a failure here localises the cause to the policy.
  assert.ok(
    policy.declaredRoutes().findIndex((r) => r.path === "/:id") ===
      policy.declaredRoutes().length - 1,
    "the wildcard must be declared last so it cannot shadow a literal path"
  );
});

test("contract: an undeclared operation fails at load time, not at review time", () => {
  assert.throws(() => policy.assertDeclared("ban-someone"), /has no entry in users\.policy\.POLICIES/);
});

test("contract: every declared operation is actually mounted", async () => {
  for (const route of policy.declaredRoutes()) {
    // The anonymous one with no guards would otherwise 404-vs-401 be ambiguous, so it
    // is asserted separately below. Everything here is expected to be 401 or 400.
    const res = await request(getApp())
      [route.method.toLowerCase()](`/api/users${route.path.replace(":id", "1")}`)
      .set("Authorization", "Bearer not.a.jwt");

    assert.notEqual(res.status, 404, `${route.method} /api/users${route.path} is declared but not mounted`);
  }

  // And the anonymous route really is reachable with no token at all.
  const anon = await request(getApp()).get("/api/users/1");
  assert.notEqual(anon.status, 401, "GET /:id must not be guarded");
  assert.notEqual(anon.status, 404, "GET /:id must be mounted");
});

// ── 4. the anonymous profile route ──────────────────────────────────────────

test("public profile: GET /:id answers without a token (FIXME M00.5 resolved)", async () => {
  const user = await createUser({ uname: "Visible" });

  const res = await request(getApp()).get(`/api/users/${user.uid}`).expect(200);

  assert.equal(res.body.data.uid, user.uid);
  assert.equal(res.body.data.uname, "Visible");
});

test("public profile: a valid token changes nothing — the route ignores the caller", async () => {
  // `/:id` is declared ANONYMOUS, so an admin token must not widen the response. If the
  // handler ever branches on `req.user`, this is the test that catches it.
  const user = await createUser();
  const viewer = await createUser({ uemail: "viewer@example.com" });
  const { accessToken } = userTokens(viewer.uid, viewer.uemail);

  const anonymous = await request(getApp()).get(`/api/users/${user.uid}`).expect(200);
  const authenticated = await request(getApp())
    .get(`/api/users/${user.uid}`)
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  assert.deepEqual(authenticated.body.data, anonymous.body.data);
});

test("public profile: a missing user is a 404, and a bad id is a 400", async () => {
  await request(getApp()).get("/api/users/999999").expect(404);

  // `parseUserId` keeps the legacy `parseInt` leniency, so `"1abc"` resolves to 1 —
  // pinned here because the stricter form is a future change and must not be silent.
  await request(getApp()).get("/api/users/abc").expect(400);
});

// ── 5. password changes go through core/password ────────────────────────────

test("password: a change re-hashes at the shared cost and rejects reuse", async () => {
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  await request(getApp())
    .put("/api/users/me/password")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ currentPassword: PASSWORD, newPassword: "Rotated@12345" })
    .expect(200);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.notEqual(row.upass, user.upass, "the stored hash must change");
  assert.ok(password.isHash(row.upass), "the new hash must carry a recognised prefix");
  assert.equal(await bcrypt.getRounds(row.upass), password.BCRYPT_COST);

  // Reusing the current password as the new one is refused, and the old password still
  // works — a rejected change must not have half-applied.
  await request(getApp())
    .put("/api/users/me/password")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ currentPassword: "Rotated@12345", newPassword: "Rotated@12345" })
    .expect(400);

  assert.equal(await password.verify(PASSWORD, row.upass), false);
  assert.equal((await password.verify("Rotated@12345", row.upass)).ok, true);
});

test("password: a wrong current password is refused and nothing is written", async () => {
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  await request(getApp())
    .put("/api/users/me/password")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ currentPassword: "Wrong@1234567", newPassword: "Rotated@12345" })
    .expect(401);

  const row = await prisma.user.findFirst({ where: { uid: user.uid } });
  assert.equal(row.upass, user.upass);
});

// ── 6. the preserved M00.6 IDOR ─────────────────────────────────────────────

test("IDOR (M00.6, preserved): POST /block/:id still acts on the path parameter", async () => {
  // M04 kept this deliberately. `test/contract/user.test.js` pins the vulnerable
  // behaviour, and the fix removes a capability from any authenticated user rather
  // than adding one — a change to the documented contract, not a refactor.
  //
  // If this test ever starts failing because a *victim* was frozen, the fix has landed:
  // pass `req.user.id` in `blockSelf` and delete this file and the M00.6 block in
  // `test/contract/user.test.js` together.
  const attacker = await createUser({ uemail: "attacker@example.com" });
  const victim = await createUser({ uemail: "victim@example.com" });
  const { accessToken } = userTokens(attacker.uid, attacker.uemail);

  await request(getApp())
    .post(`/api/users/block/${victim.uid}`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({})
    .expect(200);

  assert.equal((await prisma.user.findFirst({ where: { uid: victim.uid } })).adminblock, 1);
  assert.equal((await prisma.user.findFirst({ where: { uid: attacker.uid } })).adminblock, 0);
});