const { authenticate, requireRole } = require("../../middleware/auth");
const { publicRoutes, adminRoutes } = require("./locations.routes");

module.exports = {
  name: "locations",
  mounts: [
    { path: "/api", router: publicRoutes, guards: [] },
    { path: "/api/admin", router: adminRoutes, guards: [authenticate, requireRole("admin")] },
  ],
};
