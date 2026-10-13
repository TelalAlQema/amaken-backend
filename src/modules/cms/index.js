const { authenticate, requireRole } = require("../../middleware/auth");
const { publicRoutes, adminRoutes } = require("./cms.routes");

module.exports = {
  name: "cms",
  mounts: [
    { path: "/api", router: publicRoutes, guards: [] },
    { path: "/api/admin", router: adminRoutes, guards: [authenticate, requireRole("admin")] },
  ],
};
