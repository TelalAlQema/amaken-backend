/**
 * Route parity baseline.
 *
 * The complete route table as of M00.3, frozen, plus `/metrics` from M01. If a
 * route is added, removed or renamed, this test fails. That is the point: M01-M06
 * move 97 routes between files, and a route silently vanishing is the single most
 * likely regression.
 *
 * The app under test is `createApp()` — the same factory production boots — so
 * from M01 this asserts the real composition root rather than a mirror of it.
 *
 * Every change here is a deliberate API change and must update
 * docs/api-contract.md in the same commit.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { getApp, closeDatabase } = require("../helpers/app");

/** @type {[string, string][]} [method, path] */
const EXPECTED_ROUTES = [
  ["GET", "/api"],
  ["GET", "/api/docs"],
  ["GET", "/api/about"],
  ["POST", "/api/admin/about"],
  ["DELETE", "/api/admin/about/:id"],
  ["PUT", "/api/admin/about/:id"],
  ["DELETE", "/api/admin/accounts/:id"],
  ["GET", "/api/admin/accounts/blocked"],
  ["GET", "/api/admin/accounts/deleted"],
  ["GET", "/api/admin/accounts/registered"],
  ["GET", "/api/admin/charts"],
  ["POST", "/api/admin/cities"],
  ["GET", "/api/admin/feedback/agents"],
  ["GET", "/api/admin/feedback/company"],
  ["DELETE", "/api/admin/cities/:id"],
  ["PUT", "/api/admin/cities/:id"],
  ["GET", "/api/admin/contacts"],
  ["DELETE", "/api/admin/contacts/:id"],
  ["GET", "/api/admin/leads"],
  ["DELETE", "/api/admin/leads/:id"],
  ["POST", "/api/admin/leads/bulk-delete"],
  ["POST", "/api/admin/leads/delete-all"],
  ["GET", "/api/admin/leads/export"],
  ["POST", "/api/admin/login"],
  ["POST", "/api/admin/pin"],
  ["GET", "/api/admin/profile"],
  ["PUT", "/api/admin/profile"],
  ["DELETE", "/api/admin/profile/avatar"],
  ["POST", "/api/admin/profile/avatar"],
  ["PUT", "/api/admin/profile/links"],
  ["DELETE", "/api/admin/profile/logo"],
  ["POST", "/api/admin/profile/logo"],
  ["PUT", "/api/admin/profile/password"],
  ["GET", "/api/admin/properties"],
  ["DELETE", "/api/admin/properties/:id"],
  ["PUT", "/api/admin/properties/:id/approve"],
  ["PUT", "/api/admin/properties/:id/disapprove"],
  ["PUT", "/api/admin/properties/:id/display"],
  ["PUT", "/api/admin/properties/:id/freeze"],
  ["PUT", "/api/admin/properties/:id/hide"],
  ["PUT", "/api/admin/properties/:id/release"],
  ["GET", "/api/admin/properties/approval"],
  ["GET", "/api/admin/sidebar-counts"],
  ["POST", "/api/admin/states"],
  ["DELETE", "/api/admin/states/:id"],
  ["PUT", "/api/admin/states/:id"],
  ["GET", "/api/admin/stats"],
  ["POST", "/api/admin/team"],
  ["DELETE", "/api/admin/team/:id"],
  ["PUT", "/api/admin/team/:id"],
  ["GET", "/api/admin/users"],
  ["DELETE", "/api/admin/users/:id"],
  ["PUT", "/api/admin/users/:id/status"],
  ["GET", "/api/admin/users/admins"],
  ["GET", "/api/admin/users/agents"],
  ["GET", "/api/admin/users/builders"],
  ["POST", "/api/auth/forgot-password"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
  ["POST", "/api/auth/refresh"],
  ["POST", "/api/auth/register"],
  ["POST", "/api/auth/reset-password"],
  ["POST", "/api/auth/verify-email"],
  ["POST", "/api/auth/verify-forgot-otp"],
  ["POST", "/api/auth/verify-otp"],
  ["GET", "/api/cities"],
  ["POST", "/api/contact/"],
  ["POST", "/api/feedback/"],
  ["DELETE", "/api/feedback/:id"],
  ["GET", "/api/feedback/:id"],
  ["PUT", "/api/feedback/:id"],
  ["GET", "/api/feedback/about-me"],
  ["GET", "/api/feedback/my"],
  ["GET", "/api/properties/"],
  ["POST", "/api/properties/"],
  ["DELETE", "/api/properties/:id"],
  ["GET", "/api/properties/:id"],
  ["PUT", "/api/properties/:id"],
  ["POST", "/api/properties/:id/lead"],
  ["GET", "/api/properties/my"],
  ["GET", "/api/properties/state/:stateSlug"],
  ["GET", "/api/states"],
  ["GET", "/api/team"],
  ["GET", "/api/users/:id"],
  ["POST", "/api/users/block/:id"],
  ["DELETE", "/api/users/me"],
  ["GET", "/api/users/me"],
  ["PUT", "/api/users/me"],
  ["POST", "/api/users/me/activate"],
  ["DELETE", "/api/users/me/avatar"],
  ["POST", "/api/users/me/avatar"],
  ["POST", "/api/users/me/deactivate"],
  ["PUT", "/api/users/me/links"],
  ["DELETE", "/api/users/me/logo"],
  ["POST", "/api/users/me/logo"],
  ["PUT", "/api/users/me/password"],
  ["POST", "/api/users/unblock/:id"],
  ["GET", "/health"],
  // Added in M01 with the prom-client registry. Unauthenticated and not
  // enveloped — a scraper parses the Prometheus text format.
  ["GET", "/metrics"],
  // Added in M02. `/health` above stays as the legacy alias, byte-identical —
  // something already probes it and a 404 there would be an outage of the thing
  // monitoring the thing.
  ["GET", "/health/live"],
  ["GET", "/health/ready"],
];

test.after(async () => {
  await closeDatabase();
});

test("route table: exactly the frozen baseline, no additions or removals", async () => {
  const { collectRoutes } = require("../../scripts/route-table");
  const actual = collectRoutes(getApp()).map((r) => [r.methods[0], r.path]);

  const expectedSet = new Set(EXPECTED_ROUTES.map(([m, p]) => `${m} ${p}`));
  const actualSet = new Set(actual.map(([m, p]) => `${m} ${p}`));

  const missing = [...expectedSet].filter((r) => !actualSet.has(r));
  const added = [...actualSet].filter((r) => !expectedSet.has(r));

  assert.deepEqual(
    { missing, added },
    { missing: [], added: [] },
    `Route table drifted.\n  missing: ${JSON.stringify(missing)}\n  added:   ${JSON.stringify(added)}\n` +
      "If this change is intended, update EXPECTED_ROUTES and docs/api-contract.md together."
  );

  assert.equal(actual.length, EXPECTED_ROUTES.length);
});

test("route table: unknown paths return the 404 envelope, not an Express default", async () => {
  const res = await request(getApp()).get("/api/definitely-not-a-route").expect(404);

  assert.deepEqual(res.body, {
    success: false,
    error: { message: "Route not found" },
  });
});

test("route table: an unauthenticated /api/admin path returns 401 AUTH_REQUIRED", async () => {
  const res = await request(getApp()).get("/api/admin/users").expect(401);

  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "AUTH_REQUIRED");
});
