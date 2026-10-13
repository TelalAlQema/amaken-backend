const routes = require("./leads.routes");
const adminRoutes = require("./admin-leads.routes");

module.exports = {
  name: "leads",
  mounts: [
    { path: "/api/properties", router: routes, guards: [] },
    { path: "/api/admin", router: adminRoutes, guards: [] },
  ],
};
