const { authenticate, requireRole } = require("../../middleware/auth");
const routes = require("./dashboard.routes");

module.exports = {
  name: "dashboard",
  mounts: [{ path: "/api/admin", router: routes, guards: [authenticate, requireRole("admin")] }],
};
