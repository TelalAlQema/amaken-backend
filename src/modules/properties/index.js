const propertiesRoutes = require("./properties.routes");
const adminPropertiesRoutes = require("./admin-properties.routes");

module.exports = {
  name: "properties",
  mounts: [
    { path: "/api/properties", router: propertiesRoutes, guards: [] },
    { path: "/api/admin", router: adminPropertiesRoutes, guards: [] },
  ],
};
