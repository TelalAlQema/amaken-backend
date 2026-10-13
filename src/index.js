/**
 * Entry point. Nothing else.
 *
 * `pnpm dev` (`node --watch src/index.js`), `pnpm start` and Playwright's
 * `webServer` all invoke this path, so the shim is what keeps every one of them
 * working with no configuration change. The real boot sequence lives in
 * `server.js`; the app factory lives in `app.js`.
 */
require("./server");
