/**
 * `modules/auth` — the module manifest.
 *
 * The **only** file outside this directory that is allowed to know the module
 * exists. Everything else reaches it through `src/bootstrap/registerModules.js`,
 * so the dependency is declared in one place instead of being spread across nine
 * route files and two services.
 *
 * ## The capabilities, and why they are capabilities and not `export *`
 *
 * `verifyAccessToken` is here for `middleware/auth.js`, which every other module
 * uses to authenticate a request. If the module's internals were re-exported
 * wholesale, a consumer could reach `repository.markLogin` through a `require` of
 * the manifest — and there would be nothing in the import to stop it.
 *
 * `issueTokenPair` is here because `modules/admins` mints an admin pair in its login
 * handler. It is a second entry point into this module and it is named in the
 * manifest on purpose: the alternative is `modules/admins` importing
 * `token.service.js` directly, which would give the process two ways to mint a
 * session and no single place to see who does.
 *
 * M04 note: the milestone's own wording was that it "moves the admin login into this
 * module". It does not, and should not — the admin login is one of the twenty
 * `/api/admin` endpoints that the frozen route table pins, so it belongs to
 * `modules/admins`, and M04 moved it there rather than here. What moved is the
 * dependency: the admin login used to mint its own tokens through this capability
 * from a service in `src/services/`, and now it does from a module that declares it
 * in its own manifest.
 *
 * `authenticate`, `requireRole` and `optionalAuth` are deliberately **not**
 * re-exported. They live in `src/middleware/`, one shared implementation for the
 * whole process; a module-local copy would be a second thing to keep in sync, and
 * "which guard does this route use" is a question worth one answer.
 *
 * ## Why `assertDeclared` is re-exported
 *
 * `auth.policy.js` throws at load time for an undeclared operation, and the module
 * contract test asserts that the router and the policy agree. The test imports it
 * from here, which is the point: a capability that only the module's own test can
 * reach is one a reviewer can see is tested.
 *
 * @typedef {object} AuthModule
 * @property {string} name
 * @property {{ path: string, router: import("express").Router, guards: import("express").RequestHandler[] }[]} mounts
 * @property {{ issueTokenPair: typeof import("./token.service").issuePair, verifyAccessToken: typeof import("./token.service").verifyAccess, verifyRefreshToken: typeof import("./token.service").verifyRefresh }} capabilities
 * @property {{ declaredRoutes: () => object[], assertDeclared: (operation: string) => object }} policy
 */

/** @type {import("./auth.routes")} */
const routes = require("./auth.routes");
const tokens = require("./token.service");
const policy = require("./auth.policy");

module.exports = {
  name: "auth",

  /**
   * `/api/auth` — byte-identical to the path the module took before it was a
   * module. `guards: []` because every endpoint declares its own requirement in
   * `auth.policy.js`: eight are anonymous and the ninth needs a refresh token in
   * its *body*, which is not a route guard.
   */
  mounts: [{ path: "/api/auth", router: routes, guards: [] }],

  capabilities: {
    issueTokenPair: tokens.issuePair,
    verifyAccessToken: tokens.verifyAccess,
    verifyRefreshToken: tokens.verifyRefresh,
  },

  policy: {
    declaredRoutes: policy.declaredRoutes,
    assertDeclared: policy.assertDeclared,
  },
};