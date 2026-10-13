/**
 * Token helpers.
 *
 * Tokens are minted with the application's own token service so tests exercise the
 * real signing path rather than a fabricated one.
 *
 * M03: that service moved to `modules/auth/token.service.js`, and tests reach it
 * through the module manifest for the same reason the rest of the codebase does —
 * the internal path is not an API. `tokenVersion` is left undefined, which
 * `normalizeTokenVersion` turns into 0, matching the column default.
 */
const { capabilities } = require("../../src/modules/auth");

const { issueTokenPair } = capabilities;

function userAccessToken(uid, email = "test.user@example.com") {
  return issueTokenPair(uid, email, "user").accessToken;
}

function adminAccessToken(aid, email = "test.admin@example.com") {
  return issueTokenPair(aid, email, "admin").accessToken;
}

function userTokens(uid, email) {
  const { accessToken, refreshToken } = issueTokenPair(uid, email, "user");
  return { accessToken, refreshToken };
}

function adminTokens(aid, email) {
  const { accessToken, refreshToken } = issueTokenPair(aid, email, "admin");
  return { accessToken, refreshToken };
}

module.exports = { userAccessToken, adminAccessToken, userTokens, adminTokens };