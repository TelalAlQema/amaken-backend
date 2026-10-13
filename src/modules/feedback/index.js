const { authenticate, requireRole } = require("../../middleware/auth");
const routes = require("./feedback.routes");
const adminRoutes = require("./admin-feedback.routes");

module.exports = {
  name: "feedback",
  mounts: [
    { path: "/api/feedback", router: routes, guards: [] },
    { path: "/api/admin/feedback", router: adminRoutes, guards: [authenticate, requireRole("admin")] },
  ],
};
