/**
 * Dumps the full route table of the app.
 *
 *   node scripts/dump-routes.js          # routes only
 *   node scripts/dump-routes.js --mounts # routes with their mount chain
 *
 * The contract baseline test (test/contract/route-parity.test.js) imports
 * scripts/route-table.js directly and compares against a frozen list.
 */
const { getApp } = require("../test/helpers/app");
const { collectRoutes } = require("./route-table");

const showMounts = process.argv.includes("--mounts");
const routes = collectRoutes(getApp());

console.log(`# ${routes.length} routes\n`);
for (const r of routes) {
  const method = r.methods.join(",").padEnd(7);
  console.log(`${method} ${r.path}${showMounts && r.mount ? `    [${r.mount}]` : ""}`);
}
