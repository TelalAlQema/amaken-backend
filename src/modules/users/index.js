/**
 * `modules/users` — the module manifest.
 *
 * The 14 endpoints the pre-M04 `src/routes/user.routes.js` declared, moved here
 * unchanged except for `GET /:id`, which is now public.
 *
 * ## `guards: []`, and why the mount cannot carry one
 *
 * `auth` can mount with an empty guard list because eight of its nine endpoints are
 * anonymous. This module is the other way round: thirteen of fourteen need a token
 * and exactly one does not. A mount-level guard would have to be `authenticate`
 * (for the thirteen) with no way to exempt `GET /:id`, or nothing (for the one) with
 * no way to protect the other thirteen.
 *
 * So the guard is per-operation, declared in `users.policy.js` and applied by
 * `policy.guardsFor(authenticate, operation)` in the route file. The mount itself
 * takes no guards, and `bootstrap/registerModules.js` mounts it in declaration
 * order after `auth`.
 *
 * ## Why this module does not expose capabilities
 *
 * `auth` publishes `issueTokenPair` because another module needed to mint an admin
 * session. Nothing needed `users`' internals: the admin user-management endpoints
 * that read and freeze accounts are part of the frozen route table and stayed under
 * `modules/admins` (see the M04 milestone notes on route parity), and they reach
 * the `user` table directly through their own repository under ADR 0002.
 *
 * Publishing `getProfile` here would be a convenience for one caller and a second
 * way to read a user row for everyone else. The module's value is that
 * `GET /users/:id` and the twelve `/me` endpoints live in one readable place.
 *
 * @typedef {object} UsersModule
 * @property {string} name
 * @property {{ path: string, router: import("express").Router, guards: import("express").RequestHandler[] }[]} mounts
 * @property {{ declaredRoutes: () => object[], assertDeclared: (operation: string) => object }} policy
 */

/** @type {import("./users.routes")} */
const routes = require("./users.routes");
const policy = require("./users.policy");

module.exports = {
  name: "users",

  mounts: [{ path: "/api/users", router: routes, guards: [] }],

  /**
   * Re-exported for `test/modules/users.test.js`, for the same reason `auth`
   * re-exports it: a capability only the module's own test can reach is one a
   * reviewer can see is tested. The contract test asserts that every route on the
   * router has a policy entry and vice versa.
   */
  policy: {
    declaredRoutes: policy.declaredRoutes,
    assertDeclared: policy.assertDeclared,
  },
};