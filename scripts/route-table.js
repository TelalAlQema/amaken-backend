/**
 * Route table extraction.
 *
 * Walks the Express router stack and reports what is genuinely registered,
 * rather than what the source appears to declare. Used by scripts/dump-routes.js
 * and by the contract baseline test.
 */

/**
 * @param {import("express").Application} app
 * @returns {{path: string, methods: string[], mount: string}[]}
 */
function collectRoutes(app) {
  const found = [];
  walk(app._router.stack, "", "");

  return found.sort((a, b) =>
    a.path === b.path ? a.methods[0].localeCompare(b.methods[0]) : a.path.localeCompare(b.path)
  );

  function walk(stack, prefix, mountTrail) {
    if (!stack) return;

    for (const layer of stack) {
      if (layer.route) {
        found.push({
          path: `${prefix}${layer.route.path}`,
          methods: Object.keys(layer.route.methods)
            .filter((m) => m !== "_all")
            .map((m) => m.toUpperCase())
            .sort(),
          mount: mountTrail,
        });
        continue;
      }

      const handle = layer.handle;
      if (!handle) continue;

      // A mounted Router has its own stack.
      if (handle.stack && Array.isArray(handle.stack)) {
        const at = mountPathOf(layer);
        walk(handle.stack, `${prefix}${at}`, at ? `${mountTrail} → ${at}`.trim() : mountTrail);
      }
    }
  }
}

/**
 * Recovers the literal path a router was mounted at. Express compiles it into a
 * regexp and exposes no accessor, so it has to be parsed.
 */
function mountPathOf(layer) {
  if (!layer.regexp) return "";
  const m = /^\^\\\/(.*?)\\\/\?/.exec(layer.regexp.source);
  if (!m) return "";
  return "/" + m[1].replace(/\\\//g, "/").replace(/\\\./g, ".");
}

module.exports = { collectRoutes };
