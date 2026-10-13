/**
 * Public surface contract baseline.
 *
 * Pins the envelope shape of every unauthenticated endpoint. These pass on
 * unmodified src/.
 *
 * Where an assertion documents a KNOWN BUG it says so and carries a fix marker, and
 * it asserts the CURRENT, wrong behaviour so the suite stays green at baseline.
 * `GET /api/users/:id` used to be one of those (FIXME(M00.5)); M04 resolved it and the
 * assertion is now inverted. The remaining markers are M00.5's property-leads leak
 * and M05's.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { getApp, resetDatabase, closeDatabase } = require("../helpers/app");
const {
  createUser,
  createProperty,
  createLead,
  createAbout,
  createTeamMember,
  createState,
  createCity,
  createContact,
} = require("../helpers/fixtures");

const { authenticate } = require("../../src/middleware/auth");
const userPolicy = require("../../src/modules/users/users.policy");

test.beforeEach(resetDatabase);
test.after(closeDatabase);

// ── GET /api ────────────────────────────────────────────────────────────────

test("GET /api returns the discovery envelope (no success flag)", async () => {
  const res = await request(getApp()).get("/api").expect(200);

  assert.equal(res.body.message, "Amaken Real Estate API");
  assert.equal(res.body.version, "0.1.0");
  assert.equal(res.body.docs, "/api/docs");
});

test("GET /api/docs serves OpenAPI 3.1 for all mounted routes", async () => {
  const res = await request(getApp()).get("/api/docs").expect(200);
  assert.equal(res.body.openapi, "3.1.0");
  assert.ok(res.body.paths["/api/properties"]);
  assert.ok(res.body.paths["/api/admin/leads/export"]);
  assert.ok(res.body.paths["/api/auth/refresh"]);
});

// ── GET /api/properties ─────────────────────────────────────────────────────

test("GET /api/properties returns { items, pagination }", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, title: "Visible Villa" });

  const res = await request(getApp()).get("/api/properties").expect(200);

  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.items));
  assert.equal(res.body.data.properties, undefined, "legacy list aliases are removed");
  assert.deepEqual(Object.keys(res.body.data.pagination).sort(), [
    "limit",
    "page",
    "total",
    "totalPages",
  ]);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].title, "Visible Villa");
  // The list carries the owner summary, not the full user row.
  assert.ok(res.body.data.items[0].user);
  assert.ok("uimage" in res.body.data.items[0].user);
});

test("GET /api/properties paginates", async () => {
  const user = await createUser();
  for (let i = 0; i < 5; i++) await createProperty({ uid: user.uid, title: `P${i}` });

  const page1 = await request(getApp()).get("/api/properties?page=1&limit=2").expect(200);
  assert.equal(page1.body.data.items.length, 2);
  assert.equal(page1.body.data.pagination.total, 5);
  assert.equal(page1.body.data.pagination.totalPages, 3);

  const page3 = await request(getApp()).get("/api/properties?page=3&limit=2").expect(200);
  assert.equal(page3.body.data.items.length, 1);
});

test("GET /api/properties caps limit at 100", async () => {
  const res = await request(getApp()).get("/api/properties?limit=9999").expect(400);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

test("GET /api/properties filters by city", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, city: "Dubai", title: "Dubai Flat" });
  await createProperty({ uid: user.uid, city: "Abu Dhabi", title: "Abu Dhabi Flat" });

  const res = await request(getApp()).get("/api/properties?city=Dubai").expect(200);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].title, "Dubai Flat");
});

test("GET /api/properties hides unapproved properties from the public", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, title: "Approved", adminapproval: 1 });
  await createProperty({ uid: user.uid, title: "Pending", adminapproval: 0 });

  const res = await request(getApp()).get("/api/properties").expect(200);
  const titles = res.body.data.items.map((p) => p.title);

  assert.deepEqual(titles, ["Approved"]);
});

test("GET /api/properties accepts a search term", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, title: "Marina Penthouse" });
  await createProperty({ uid: user.uid, title: "Desert Warehouse" });

  const res = await request(getApp()).get("/api/properties?search=Marina").expect(200);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].title, "Marina Penthouse");
});

// ── GET /api/properties/:id ────────────────────────────────────────────────

test("GET /api/properties/:id returns a BARE object, not a list envelope", async () => {
  const user = await createUser();
  const property = await createProperty({ uid: user.uid });

  const res = await request(getApp()).get(`/api/properties/${property.id}`).expect(200);

  assert.equal(res.body.success, true);
  // Six frontend call sites unwrap this directly; it must never become { items }.
  assert.equal(Array.isArray(res.body.data), false);
  assert.equal(res.body.data.id, property.id);
  assert.ok("items" in res.body.data === false);
  assert.ok("properties" in res.body.data === false);
});

test("GET /api/properties/:id returns 404 PROPERTY_NOT_FOUND for a missing id", async () => {
  const res = await request(getApp()).get("/api/properties/999999").expect(404);

  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "PROPERTY_NOT_FOUND");
});

test("GET /api/properties/:id returns 400 for a non-numeric id", async () => {
  const res = await request(getApp()).get("/api/properties/abc").expect(400);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

test("SECURITY: GET /api/properties/:id currently exposes every lead unauthenticated", async () => {
  // FIXME(M00.5): property.service.js:255 does `include: { leads: true }` with no
  // guard on the public route, so lead name, email, phone and IP are public.
  // This asserts the CURRENT behaviour. The fixed test asserts the ABSENCE of
  // `leads` for an unauthenticated caller.
  const user = await createUser();
  const property = await createProperty({ uid: user.uid });
  await createLead({
    pid: property.id,
    name: "Confidential Buyer",
    email: "buyer.private@example.com",
    phone: "+971509999999",
  });

  const res = await request(getApp()).get(`/api/properties/${property.id}`).expect(200);

  assert.ok(Array.isArray(res.body.data.leads), "leads are currently included");
  assert.equal(res.body.data.leads[0].email, "buyer.private@example.com");
  assert.equal(res.body.data.leads[0].phone, "+971509999999");
  assert.equal(res.body.data.leads[0].ip, "127.0.0.1");
});

// ── POST /api/properties/:id/lead ───────────────────────────────────────────

test("POST /api/properties/:id/lead records a public enquiry", async () => {
  const user = await createUser();
  const property = await createProperty({ uid: user.uid });

  const res = await request(getApp())
    .post(`/api/properties/${property.id}/lead`)
    .send({
      name: "Enquirer",
      email: "enquirer@example.com",
      nationality: "British",
      phone: "+971501111111",
    })
    .expect(201);

  assert.equal(res.body.success, true);
});

test("POST /api/properties/:id/lead requires a valid body", async () => {
  const res = await request(getApp())
    .post("/api/properties/1/lead")
    .send({ name: "No Contact" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});

// ── GET /api/properties/state/:slug ─────────────────────────────────────────

test("GET /api/properties/state/:stateSlug returns { items, pagination }", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, state: "Dubai", title: "Dubai One" });

  const res = await request(getApp()).get("/api/properties/state/Dubai").expect(200);

  assert.ok(Array.isArray(res.body.data.items));
  assert.equal(res.body.data.items[0].title, "Dubai One");
});

// ── GET /api/users/:id ──────────────────────────────────────────────────────

test("GET /api/users/:id is reachable without a token", async () => {
  // Resolves FIXME(M00.5). The pre-M04 router applied `router.use(authenticate)`
  // to the whole file, which made this route unreachable without a token even
  // though it is the one profile endpoint the frontend fetches anonymously.
  //
  // `modules/users` now opts out of the router-wide guard for this route only, and
  // declares that choice in `users.policy.js` — so the exemption is asserted against
  // the policy here rather than left as an unexplained hole in the guard list.
  const user = await createUser();

  const res = await request(getApp()).get(`/api/users/${user.uid}`).expect(200);

  assert.equal(res.body.data.uid, user.uid);
  assert.equal(
    userPolicy.guardsFor(authenticate, userPolicy.Operation.PUBLIC_PROFILE).length,
    0,
    "the anonymous route must be declared public in the policy, not merely left unguarded"
  );
});

// ── CMS ─────────────────────────────────────────────────────────────────────

test("GET /api/about returns a bare array", async () => {
  await createAbout({ title: "Who We Are", content: "Amaken builds property." });

  const res = await request(getApp()).get("/api/about").expect(200);

  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data[0].title, "Who We Are");
});

test("GET /api/team returns a bare array", async () => {
  await createTeamMember({ email: "lead.agent@example.com", fname: "Lead" });

  const res = await request(getApp()).get("/api/team").expect(200);

  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.data[0].email, "lead.agent@example.com");
});

test("GET /api/states and /api/cities return bare arrays", async () => {
  const state = await createState({ sname: "Dubai" });
  await createCity({ cname: "Downtown", sid: state.sid });

  const states = await request(getApp()).get("/api/states").expect(200);
  const cities = await request(getApp()).get("/api/cities").expect(200);

  assert.ok(Array.isArray(states.body.data));
  assert.ok(Array.isArray(cities.body.data));
  assert.equal(cities.body.data[0].cname, "Downtown");
});

// ── POST /api/contact ───────────────────────────────────────────────────────

test("POST /api/contact stores a submission and returns 201", async () => {
  const res = await request(getApp())
    .post("/api/contact")
    .send({
      name: "Prospect",
      email: "prospect@example.com",
      phone: "+971502222222",
      subject: "Interested in a villa",
      message: "Please call me.",
    })
    .expect(201);

  assert.equal(res.body.success, true);
});

test("POST /api/contact validates required fields", async () => {
  const res = await request(getApp())
    .post("/api/contact")
    .send({ name: "No Message" })
    .expect(400);

  assert.equal(res.body.error.code, "VALIDATION_ERROR");
});
