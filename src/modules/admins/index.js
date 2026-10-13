/**
 * `modules/admins` — the module manifest.
 *
 * The twenty endpoints from the pre-M04 `src/routes/admin.routes.js`, moved with
 * their paths, schemas, status codes and response bodies unchanged.
 *
 * ## Mount order relative to `auth`
 *
 * `bootstrap/registerModules.js` declares `auth`, `admins`, `users`, `accounts` in
 * that order. It only has to be "`auth` first" today — the three mounts
 * (`/api/auth`, `/api/admin`, `/api/users`) share no path prefix, so no route in
 * one can shadow a route in another. The order is written down rather than left to
 * `require` resolution so it stays that way.
 *
 * ## `guards: []`, for the same reason as `modules/users`
 *
 * `POST /pin` and `POST /login` must be reachable without a token, so the
 * pre-M04 `router.use(authenticate, requireRole("admin"))` could not be a mount
 * guard. Every operation declares its own principal in `admins.policy.js`.
 *
 * ## Why this module has no capabilities
 *
 * `auth` publishes `issueTokenPair` and this module calls it — that is the
 * direction that matters. Nothing calls into `admins`.
 *
 * `modules/accounts` is the dependency that runs *this* way: the four
 * `/admin/accounts/*` screens are implemented there and reached through
 * `accounts.capabilities`, because a second module owning `del_account` and
 * `register_email` would defeat the point of M04. `admins.service` gathers those
 * four into a single block at its foot, so the route file never imports
 * `modules/accounts` directly and the cross-module edge is one readable list.
 *
 * @typedef {object} AdminsModule
 * @property {string} name
 * @property {{ path: string, router: import("express").Router, guards: import("express").RequestHandler[] }[]} mounts
 * @property {{ declaredRoutes: () => object[], assertDeclared: (operation: string) => object }} policy
 */

/** @type {import("./admins.routes")} */
const routes = require("./admins.routes");
const policy = require("./admins.policy");

module.exports = {
  name: "admins",

  mounts: [{ path: "/api/admin", router: routes, guards: [] }],

  policy: {
    declaredRoutes: policy.declaredRoutes,
    assertDeclared: policy.assertDeclared,
  },
};