const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { getApp, resetDatabase, closeDatabase } = require("../helpers/app");
const { createAdmin, createUser, createFeedback } = require("../helpers/fixtures");
const { adminAccessToken } = require("../helpers/auth");
const { toApiFeedback } = require("../../src/modules/feedback/feedback.mapper");
const dashboardService = require("../../src/modules/dashboard/dashboard.service");
const aboutService = require("../../src/modules/cms/about.service");
const cache = require("../../src/platform/cache");

test.beforeEach(resetDatabase);
test.after(closeDatabase);

test("feedback mapper resolves the database names to the frontend contract", () => {
  assert.deepEqual(toApiFeedback({ fid: 7, fdescription: "Helpful", send_email: "a@b.co", receive_email: "c@d.co", rating: 4, status: 1, created_at: "now" }), {
    id: 7,
    description: "Helpful",
    send_email: "a@b.co",
    receive_email: "c@d.co",
    rating: 4,
    status: 1,
    created_at: "now",
  });
});

test("admin feedback screens are mounted under /api/admin and return mapped rows", async () => {
  const admin = await createAdmin();
  const agent = await createUser({ utype: "Agent", uemail: "agent.support@example.com" });
  const companyRow = await createFeedback({ uid: agent.uid, agid: admin.aid, receive_email: admin.aemail, fdescription: "Company note" });
  const agentRow = await createFeedback({ uid: agent.uid, fdescription: "Agent note" });
  const auth = `Bearer ${adminAccessToken(admin.aid, admin.aemail)}`;

  const company = await request(getApp()).get("/api/admin/feedback/company").set("Authorization", auth).expect(200);
  assert.equal(company.body.data.items[0].id, companyRow.fid);
  assert.equal(company.body.data.items[0].description, "Company note");
  assert.equal("fid" in company.body.data.items[0], false);

  const agents = await request(getApp()).get("/api/admin/feedback/agents").set("Authorization", auth).expect(200);
  assert.ok(agents.body.data.items.some((row) => row.id === agentRow.fid && row.description === "Agent note"));
});

test("the relocated admin feedback endpoints require an admin token", async () => {
  await request(getApp()).get("/api/admin/feedback/company").expect(401);
  await request(getApp()).get("/api/admin/feedback/agents").expect(401);
});

test("public feedback detail stays unauthenticated and uses the mapped fields", async () => {
  const user = await createUser();
  const feedback = await createFeedback({ uid: user.uid, fdescription: "Public feedback detail" });

  const response = await request(getApp()).get(`/api/feedback/${feedback.fid}`).expect(200);
  assert.equal(response.body.data.id, feedback.fid);
  assert.equal(response.body.data.description, "Public feedback detail");
  assert.equal("fid" in response.body.data, false);
});

test("dashboard stats are cached and content writes invalidate the cached total", async () => {
  cache.clear();
  assert.equal((await dashboardService.getDashboardStats()).totalAboutEntries, 0);
  await aboutService.createAbout({ title: "About", content: "Updated dashboard count" });
  assert.equal((await dashboardService.getDashboardStats()).totalAboutEntries, 1);
});
