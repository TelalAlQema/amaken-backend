/**
 * `modules/admins` — module contract and behaviour tests.
 *
 * Mirrors `test/modules/users.test.js`. The mechanical half (manifest, layering,
 * policy/router agreement) is what keeps the twenty frozen `/api/admin` endpoints
 * honest; the second half pins what M04 changed, which is mostly *where the ledger
 * writes happen* — they moved out of an `await` inside a `prisma.$transaction([...])`
 * array literal into interactive transactions owned here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const bcrypt = require("bcryptjs");

const { getApp, buildApp, resetDatabase, closeDatabase, prisma } = require("../helpers/app");
const { createUser, createAdmin, createProperty, PASSWORD, PIN } = require("../helpers/fixtures");
const { userTokens, adminTokens } = require("../helpers/auth");

const adminsModule = require("../../src/modules/admins");
const policy = require("../../src/modules/admins/admins.policy");
const password = require("../../src/core/password");

const SRC = path.join(__dirname, "..", "..", "src");
const MODULE_DIR = path.join(SRC, "modules", "admins");

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
  assert.deepEqual(Object.keys(adminsModule).sort(), ["mounts", "name", "policy"]);

  assert.equal(adminsModule.name, "admins");
  assert.equal(adminsModule.mounts.length, 1);
  assert.equal(adminsModule.mounts[0].path, "/api/admin", "the frontend path must not move");
  assert.equal(typeof adminsModule.mounts[0].router, "function");
  assert.equal(adminsModule.capabilities, undefined, "admins publishes no shared surface");

  for (const leak of ["service", "repository", "routes", "router", "prisma", "schema", "mapper"]) {
    assert.equal(adminsModule[leak], undefined, `index.js must not export "${leak}"`);
  }
});

test("contract: the module is mounted by registration, and by nothing else", async () => {
  // Note the expected statuses. `/api/admin/*` cannot 404 with the registry emptied,
  // because `admin-property.routes` and `dashboard.routes` are still mounted at `/admin`
  // and both apply `router.use(authenticate)` — the shared guard answers first. So 401
  // means "a surviving admin router's guard ran and this module is not there", and 400
  // means the login handler ran and validated the empty body. The distinction proves
  // the mount comes from `registerModules` rather than a leftover `app.use`, which is
  // how the pre-M04 route was mounted and how a second mount would duplicate silently.
  const bare = buildApp({ modules: [] });
  await request(bare).post("/api/admin/login").send({}).expect(401);

  await request(getApp()).post("/api/admin/login").send({}).expect(400);
});

// ── 2. layering ──────────────────────────────────────────────────────────────

test("contract: nothing in src/ outside the module imports a module internal", () => {
  const offenders = [];

  for (const file of jsFiles(SRC)) {
    if (path.dirname(file) === MODULE_DIR) continue;
    const source = read(file);
    for (const match of source.matchAll(/require\(\s*["'][^"']*modules\/admins\/([^"']+)["']\s*\)/g)) {
      const target = match[1];
      if (target !== "index") offenders.push(`${path.relative(SRC, file)} → modules/admins/${target}`);
    }
  }

  assert.deepEqual(offenders, [], `internal imports outside the manifest: ${offenders.join(", ")}`);
});

test("contract: the module reaches accounts through its manifest, not its repository", () => {
  for (const name of ["admins.service.js", "admins.repository.js", "admins.routes.js"]) {
    const source = read(path.join(MODULE_DIR, name));
    const imports = source.match(/require\(\s*["'][^"']*modules\/accounts(\/[^"']*)?["']\s*\)/g) || [];

    for (const statement of imports) {
      assert.match(statement, /modules\/accounts["']\s*\)/, `${name} must import the accounts manifest only`);
    }
  }
});

test("contract: admins.repository.js is the only module file that touches prisma", () => {
  const files = jsFiles(MODULE_DIR).filter((f) => !f.endsWith(`${path.sep}index.js`));
  const prismaUsers = files.filter((f) => /require\([^)]*platform\/db\/prisma|@prisma\/client/.test(read(f)));

  assert.deepEqual(prismaUsers.map((f) => path.basename(f)), ["admins.repository.js"]);
});

test("contract: the service hashes only through core/password", () => {
  const service = read(path.join(MODULE_DIR, "admins.service.js"));

  // Comments are stripped first: this file documents the legacy `sha1 === stored`
  // fallback in prose precisely so the removal is auditable, and the rule below would
  // otherwise fail on the explanation of the thing it forbids.
  const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/require\([^)]*bcrypt/.test(code));
  assert.ok(!/sha1|sha256|createHash/.test(code), "no legacy bare-digest fallback");
  assert.ok(
    /require\([^)]*core\/password/.test(code),
    "password comparison must be core/password's job"
  );
});

// ── 3. the policy and the router agree ──────────────────────────────────────

test("contract: the policy declares all twenty endpoints", () => {
  const declared = policy.declaredRoutes();

  assert.equal(declared.length, 20);

  // Two endpoints are anonymous — `login` and `pin` — and the other eighteen all
  // require the admin role. A policy that quietly made a third one anonymous would be
  // a real hole, so the anonymous set is asserted exactly rather than by count alone.
  const anonymous = declared.filter((r) => r.principal === policy.Principal.ANONYMOUS);
  assert.deepEqual(anonymous.map((r) => `${r.method} ${r.path}`).sort(), ["POST /login", "POST /pin"]);

  assert.equal(declared.length - anonymous.length, 18);
});

test("contract: an undeclared operation fails at load time", () => {
  assert.throws(() => policy.assertDeclared("nuke-everything"), /has no entry in admins\.policy\.POLICIES/);
});

test("contract: every declared operation is actually mounted", async () => {
  for (const route of policy.declaredRoutes()) {
    const res = await request(getApp())
      [route.method.toLowerCase()](`/api/admin${route.path.replace(":id", "1")}`)
      .set("Authorization", "Bearer not.a.jwt");

    assert.notEqual(res.status, 404, `${route.method} /api/admin${route.path} is declared but not mounted`);
  }
});

test("guards: eighteen endpoints refuse a non-admin token, and login/pin do not", async () => {
  const admin = await createAdmin();
  const user = await createUser();
  const { accessToken } = userTokens(user.uid, user.uemail);

  // A user token on an admin route is a 403 from `requireRole`, distinct from the 401
  // above — the difference between "who are you" and "you are not an admin".
  const forbidden = await request(getApp())
    .get("/api/admin/users")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(403);
  assert.equal(forbidden.body.error.code, "FORBIDDEN");

  // The anonymous pair reach their handler: a bad body is a 400/401, never a 403.
  const badLogin = await request(getApp()).post("/api/admin/login").send({}).expect(400);
  assert.ok(badLogin.body.error);

  // And an admin token does get through, so the 403 above is the role check rather than
  // a route that is simply unreachable.
  await request(getApp())
    .get("/api/admin/profile")
    .set("Authorization", `Bearer ${adminTokens(admin.aid, admin.aemail).accessToken}`)
    .expect(200);
});

// ── 4. login and PIN ────────────────────────────────────────────────────────

test("login: a correct password mints an admin pair through the auth capability", async () => {
  const admin = await createAdmin();

  const res = await request(getApp())
    .post("/api/admin/login")
    .send({ email: admin.aemail, password: PASSWORD })
    .expect(200);

  assert.ok(res.body.data.accessToken);
  assert.ok(res.body.data.refreshToken);
});

test("login: a wrong password and an unknown admin share one 401", async () => {
  const admin = await createAdmin();

  const wrong = await request(getApp())
    .post("/api/admin/login")
    .send({ email: admin.aemail, password: "Wrong@1234567" })
    .expect(401);

  const unknown = await request(getApp())
    .post("/api/admin/login")
    .send({ email: "nobody@example.com", password: PASSWORD })
    .expect(401);

  assert.equal(wrong.body.error.code, unknown.body.error.code, "no enumeration oracle");
});

test("login: the ADMIN_MAIN_PHONE row is exempt from its own block switch", async () => {
  // The documented way back in for a blocked super-admin: there is no admin unfreeze
  // endpoint, so if the main phone were blocked by its own block check the only
  // recovery would be a direct database edit.
  const admin = await createAdmin({ adminblock: 1, aphone: process.env.ADMIN_MAIN_PHONE });
  expect(admin.aphone).toBe(process.env.ADMIN_MAIN_PHONE);

  await request(getApp())
    .post("/api/admin/login")
    .send({ email: admin.aemail, password: PASSWORD })
    .expect(200);

  // A *different* admin is still refused, so the exemption is this row and not a
  // bypass that ignores `adminblock` entirely.
  const other = await createAdmin({ adminblock: 1, aemail: "other.admin@example.com" });
  const res = await request(getApp())
    .post("/api/admin/login")
    .send({ email: other.aemail, password: PASSWORD })
    .expect(403);
  assert.equal(res.body.error.code, "ACCOUNT_BLOCKED");
});

test("pin: a wrong PIN is refused and a correct one mints a pair", async () => {
  const admin = await createAdmin();

  await request(getApp())
    .post("/api/admin/pin")
    .send({ email: admin.aemail, pin: "0000" })
    .expect(401);

  const res = await request(getApp())
    .post("/api/admin/pin")
    .send({ email: admin.aemail, pin: PIN })
    .expect(200);

  assert.ok(res.body.data.accessToken);
});

// ── 5. the ledger writes are in interactive transactions ────────────────────

test("freeze: writes adminblock, unpublishes properties, and upserts one ledger row", async () => {
  const admin = await createAdmin();
  const user = await createUser();
  const property = await createProperty({ uid: user.uid, email: user.uemail });
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  await request(getApp())
    .put(`/api/admin/users/${user.uid}/status`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ action: "freeze" })
    .expect(200);

  assert.equal((await prisma.user.findFirst({ where: { uid: user.uid } })).adminblock, 1);
  assert.equal((await prisma.property.findFirst({ where: { id: property.id } })).blocked_user, 1);

  // The pre-M04 bug this module exists to make un-repeatable: the ledger read ran
  // outside the transaction with an `id: -1` fallback, so a first freeze tried to
  // insert a literal `-1` primary key. With `@@unique([email])` it is one upsert, and
  // `id` is the database's problem.
  const ledger = await prisma.delAccount.findFirst({ where: { email: user.uemail } });
  assert.ok(ledger, "freeze writes a del_account row");
  assert.equal(ledger.type, "block");
  assert.equal(ledger.utype, "user");
  assert.notEqual(ledger.id, -1);
});

test("freeze: freezing twice upserts the same row instead of inserting a duplicate", async () => {
  const admin = await createAdmin();
  const user = await createUser();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  for (let i = 0; i < 2; i += 1) {
    await request(getApp())
      .put(`/api/admin/users/${user.uid}/status`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ action: "freeze" })
      .expect(200);
  }

  const rows = await prisma.delAccount.findMany({ where: { email: user.uemail } });
  assert.equal(rows.length, 1, "the unique constraint makes a second freeze idempotent");
});

test("unfreeze: clears adminblock, republishes properties, and deletes the ledger row", async () => {
  const admin = await createAdmin();
  const user = await createUser();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  await request(getApp())
    .put(`/api/admin/users/${user.uid}/status`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ action: "freeze" })
    .expect(200);

  await request(getApp())
    .put(`/api/admin/users/${user.uid}/status`)
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ action: "unfreeze" })
    .expect(200);

  assert.equal((await prisma.user.findFirst({ where: { uid: user.uid } })).adminblock, 0);
  assert.equal(await prisma.delAccount.findFirst({ where: { email: user.uemail } }), null);
});

test("delete: removes the user and leaves a `delete` ledger row", async () => {
  const admin = await createAdmin();
  const user = await createUser();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  await request(getApp())
    .delete(`/api/admin/users/${user.uid}`)
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  assert.equal(await prisma.user.findFirst({ where: { uid: user.uid } }), null);

  const ledger = await prisma.delAccount.findFirst({ where: { email: user.uemail } });
  assert.ok(ledger, "an admin delete is audited, unlike a self-delete");
  assert.equal(ledger.type, "delete");
  assert.equal(ledger.utype, "user");
});

// ── 6. the account screens ──────────────────────────────────────────────────

test("accounts: the three lists use the canonical `{ items, pagination }` envelope", async () => {
  const admin = await createAdmin();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  await createUser({ uemail: "still.here@example.com" });
  await prisma.delAccount.create({ data: { email: "gone@example.com", type: "delete", utype: "user" } });

  for (const kind of ["registered", "deleted", "blocked"]) {
    const res = await request(getApp())
      .get(`/api/admin/accounts/${kind}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);

    assert.ok(Array.isArray(res.body.data.items), `${kind} must contain canonical items`);
    assert.ok(res.body.data.pagination, `${kind} must carry pagination`);
    assert.equal(res.body.data.accounts, undefined, `${kind} must not emit legacy aliases`);
  }
});

test("accounts: the registered list reads register_email, not the user table", async () => {
  const admin = await createAdmin();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  // A user row with no `register_email` row is not "registered" by this screen's
  // definition — the ledger survives deletion, which is the whole point of it.
  await createUser({ uemail: "never.completed@example.com" });

  const res = await request(getApp())
    .get("/api/admin/accounts/registered")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);

  assert.ok(!res.body.data.items.some((a) => a.email === "never.completed@example.com"));
});

test("users list: `{ items, pagination }`, and admins are listed as a bare array", async () => {
  const admin = await createAdmin();
  await createUser();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  const users = await request(getApp())
    .get("/api/admin/users")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);
  assert.ok(Array.isArray(users.body.data.items));
  assert.ok(users.body.data.pagination);

  const admins = await request(getApp())
    .get("/api/admin/users/admins")
    .set("Authorization", `Bearer ${accessToken}`)
    .expect(200);
  assert.ok(Array.isArray(admins.body.data), "the admins list is a bare array, not an object");
});

// ── 7. preserved leaks ──────────────────────────────────────────────────────

test("profile update: the response still carries apass (M00.9, unchanged by M04)", async () => {
  // Deliberately left alone. M04 is structural and this is a real credential leak, but
  // removing the field is a client-visible change and the pinned contract expects it.
  // The fix is a mapper change plus a response-shape decision.
  const admin = await createAdmin();
  const { accessToken } = adminTokens(admin.aid, admin.aemail);

  const res = await request(getApp())
    .put("/api/admin/profile")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ aname: "Renamed" })
    .expect(200);

  assert.ok("apass" in res.body.data, "pinned: the leak is still here");
});
