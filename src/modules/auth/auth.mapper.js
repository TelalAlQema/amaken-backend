/**
 * Entity → wire shape.
 *
 * The only file that decides what a client sees. It exists because the M00 contract
 * baseline pins exact key sets, and because the pre-M03 service returned raw
 * fragments of the user row in three different shapes.
 *
 * Two rules:
 *   - a mapper never queries the database and never reads `config`;
 *   - a new field added to a Prisma model does **not** appear in a response until
 *     someone adds it here. `upass` sitting one `select` away from every login is
 *     the failure this file is positioned against.
 */

/**
 * The `user` object in `POST /login` and `POST /register`, and the `admin` object
 * the admin login builds from the same shape.
 *
 * `image` is emitted as `""` when the account has no avatar rather than omitted,
 * because both clients read `data.user.image` unconditionally and one of them
 * renders it straight into an `<img src>`. The M00 baseline pins this key set for
 * login; registration previously omitted it and now does not — a superset, so no
 * reader can break on the new response.
 *
 * @param {{ uid?: number, aid?: number, uemail?: string, aemail?: string, uname?: string, aname?: string, lname?: string, alname?: string, utype?: string, atype?: string, uimage?: string, aimage?: string }} row
 * @param {{ isAdmin?: boolean }} [options]
 * @returns {{ id: number, email: string, name: string, type: string, image: string }}
 */
function toUserSummary(row, { isAdmin = false } = {}) {
  const first = isAdmin ? row.aname : row.uname;
  const last = isAdmin ? row.alname : row.lname;

  return {
    id: Number(isAdmin ? row.aid : row.uid),
    email: isAdmin ? row.aemail : row.uemail,
    name: `${first} ${last}`,
    type: isAdmin ? row.atype : row.utype,
    image: isAdmin ? row.aimage || "" : row.uimage || "",
  };
}

/**
 * The token pair, and only the token pair.
 *
 * `issuePair` also returns the family, both `jti`s and the refresh lifetime so the
 * service can record rotation state. None of that is the client's business: a
 * `jti` on the wire is an invitation to build a client-side denylist that disagrees
 * with the server's.
 *
 * @param {{ accessToken: string, refreshToken: string }} pair
 * @returns {{ accessToken: string, refreshToken: string }}
 */
function toTokenPair(pair) {
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
}

/**
 * `POST /login` and `POST /register` return the user and the pair together.
 *
 * @param {object} row
 * @param {{ isAdmin?: boolean }} [options]
 * @param {{ accessToken: string, refreshToken: string }} pair
 * @returns {{ user: object, accessToken: string, refreshToken: string }}
 */
function toSession(row, pair, options) {
  return { user: toUserSummary(row, options), ...toTokenPair(pair) };
}

module.exports = { toUserSummary, toTokenPair, toSession };