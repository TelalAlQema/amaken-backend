/**
 * CORS origin resolution.
 *
 * Its own module because `app.js` exports exactly one symbol by design — an
 * M01 invariant, and a test asserts it. The alternative was either weakening that
 * invariant or testing an allow-list decision through a live preflight, and the
 * second is worse: the exactness rule below is precisely the thing that has to be
 * provable by reading an assertion, not by firing requests.
 *
 * No Express import. This decides a policy; `app.js` applies it.
 */

/**
 * @typedef {(
 *   origin: string | undefined,
 *   callback: (err: Error | null, allow?: boolean) => void
 * ) => void} CorsOriginPredicate
 */

/**
 * Turns `CORS_ORIGIN` into the value the `cors` package should receive.
 *
 * Four cases, and the second is the reason this is a function at all:
 *
 *   - **no list** → the raw string, unchanged. Whatever was configured before
 *     multi-origin support existed keeps working.
 *   - **one origin** → that bare string. The `cors` package compares against it
 *     directly, which is cheaper than a list scan on every request, and it is the
 *     shape every single-origin deployment already uses.
 *   - **several** → a predicate, so "add the staging frontend" is a config change
 *     rather than a deploy. The list is a `Set` because this runs per request.
 *   - **a `*` anywhere** → the literal `"*"`, i.e. the package's own wildcard
 *     handling. It is deliberately **not** a membership test against a list that
 *     happens to contain `*`: that behaves identically for a preflight and
 *     completely differently for a request presenting some other `Origin`, and
 *     "it worked in testing" is exactly how that ships.
 *
 * ## The comparison is exact
 *
 * No suffix, prefix or substring matching. `endsWith(".example.com")` admits
 * `https://evil-example.com`; `includes("example.com")` admits
 * `https://example.com.attacker.test`. With `credentials: true` — which this app
 * needs for its refresh-token cookie — either mistake hands an attacker a readable
 * copy of every authenticated response. Scheme and port are part of the origin per
 * the URL spec, so they are compared too: `http://a.com` is not `https://a.com`,
 * and `https://a.com:8443` is not `https://a.com`.
 *
 * @param {string | string[]} raw the configured value, or an already-split list
 * @returns {string | CorsOriginPredicate}
 */
function resolveCorsOrigin(raw) {
  const origins = toList(raw);

  if (origins.length === 0) return typeof raw === "string" ? raw : "";
  if (origins.includes("*")) return "*";
  if (origins.length === 1) return origins[0];

  const allowed = new Set(origins);

  /**
   * @type {CorsOriginPredicate}
   */
  return (origin, callback) => {
    // Absent `Origin`: same-origin navigation, curl, or a server-to-server call.
    // CORS only constrains browser-initiated cross-origin reads, so rejecting this
    // would break every non-browser client against no security benefit.
    if (!origin) return callback(null, true);
    callback(null, allowed.has(origin));
  };
}

/**
 * Accepts the comma-separated string form or an array.
 *
 * The string form is what a `.env` can express without escaping, and it is what the
 * runbook documents. Entries are trimmed, so `a, b` and `a,b` are the same config.
 *
 * @param {string | string[] | undefined} raw
 * @returns {string[]}
 */
function toList(raw) {
  if (Array.isArray(raw)) return raw.map((o) => String(o).trim()).filter(Boolean);
  if (typeof raw !== "string") return [];

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

module.exports = { resolveCorsOrigin, toList };
