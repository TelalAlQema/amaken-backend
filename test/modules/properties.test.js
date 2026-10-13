const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { getApp, resetDatabase, closeDatabase } = require("../helpers/app");
const { createUser, createAdmin, createProperty } = require("../helpers/fixtures");
const { userAccessToken, adminAccessToken } = require("../helpers/auth");
const { VisibilityPolicy } = require("../../src/modules/properties/properties.policy");
const propertyService = require("../../src/modules/properties/properties.service");

test.beforeEach(resetDatabase);
test.after(closeDatabase);

test("VisibilityPolicy is the single four-flag public predicate", () => {
  const visible = { deactivate: 1, adminapproval: 1, blocked_user: 1, adminblock: 0 };
  assert.equal(VisibilityPolicy.isVisible(visible), true);
  for (const flag of ["deactivate", "adminapproval", "blocked_user", "adminblock"]) {
    const hidden = { ...visible, [flag]: flag === "adminblock" ? 1 : 0 };
    assert.equal(VisibilityPolicy.isVisible(hidden), false, `${flag} must hide a property`);
  }
  assert.deepEqual(VisibilityPolicy.where({ city: "Dubai" }), { ...visible, city: "Dubai" });
});

test("public list, state list, and detail all enforce visibility", async () => {
  const user = await createUser();
  const visible = await createProperty({ uid: user.uid, title: "Visible", priceValue: "9000000.00" });
  const hidden = await createProperty({ uid: user.uid, title: "Hidden", adminblock: 1, priceValue: "950000.00" });

  const listed = await request(getApp()).get("/api/properties").expect(200);
  assert.deepEqual(listed.body.data.items.map((row) => row.id), [visible.id]);
  const state = await request(getApp()).get("/api/properties/state/Dubai").expect(200);
  assert.deepEqual(state.body.data.items.map((row) => row.id), [visible.id]);
  await request(getApp()).get(`/api/properties/${hidden.id}`).expect(404);
  await request(getApp()).get(`/api/properties/${visible.id}`).expect(200);
});

test("owner and moderation reads retain hidden records; pending approval remains reachable", async () => {
  const user = await createUser();
  const admin = await createAdmin();
  const hidden = await createProperty({ uid: user.uid, adminblock: 1 });
  const pending = await createProperty({ uid: user.uid, adminapproval: 0 });

  const mine = await request(getApp())
    .get("/api/properties/my")
    .set("Authorization", `Bearer ${userAccessToken(user.uid, user.uemail)}`)
    .expect(200);
  assert.deepEqual(new Set(mine.body.data.items.map((row) => row.id)), new Set([hidden.id, pending.id]));

  const all = await request(getApp())
    .get("/api/admin/properties")
    .set("Authorization", `Bearer ${adminAccessToken(admin.aid, admin.aemail)}`)
    .expect(200);
  assert.equal(all.body.data.items.length, 2);
  const approval = await request(getApp())
    .get("/api/admin/properties/approval")
    .set("Authorization", `Bearer ${adminAccessToken(admin.aid, admin.aemail)}`)
    .expect(200);
  assert.ok(approval.body.data.items.some((row) => row.id === pending.id));
});

test("price ranges and ordering use numeric priceValue", async () => {
  const user = await createUser();
  await createProperty({ uid: user.uid, price: "950000", priceValue: "950000.00" });
  await createProperty({ uid: user.uid, price: "9000000", priceValue: "9000000.00" });

  const ascending = await request(getApp()).get("/api/properties?sort=price_asc").expect(200);
  assert.deepEqual(ascending.body.data.items.map((row) => row.price), ["950000", "9000000"]);
  const range = await request(getApp()).get("/api/properties?minPrice=1000000").expect(200);
  assert.deepEqual(range.body.data.items.map((row) => row.price), ["9000000"]);
  assert.ok(9000000 > 950000);
  assert.equal(propertyService.parsePriceValue("AED 9,000,000"), "9000000.00");
  assert.equal(propertyService.parsePriceValue("call for price"), null);
});

test("approval and visibility setters update their own state flags", async () => {
  const user = await createUser();
  const property = await createProperty({ uid: user.uid });
  await propertyService.setApproval(property.id, false);
  await propertyService.setVisibility(property.id, false);
  const hidden = await propertyService.setApproval(property.id, true);
  assert.equal(hidden.adminapproval, 1);
  assert.equal(hidden.deactivate, 0);
  const displayed = await propertyService.setVisibility(property.id, true);
  assert.equal(displayed.deactivate, 1);
});
