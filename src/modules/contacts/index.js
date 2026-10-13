const { authenticate, requireRole } = require("../../middleware/auth");
const { publicRoutes, adminRoutes } = require("./contacts.routes");

module.exports = {
  name: "contacts",
  mounts: [
    { path: "/api/contact", router: publicRoutes, guards: [] },
    { path: "/api/admin", router: adminRoutes, guards: [authenticate, requireRole("admin")] },
  ],
};
