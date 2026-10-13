const { invalidateNamespace } = require("./cache");

function invalidateDashboard() {
  return invalidateNamespace("dashboard");
}

module.exports = { invalidateDashboard };
