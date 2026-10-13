/**
 * `user` column mapping.
 *
 * The `user` table is spelled in four cases at once and the request body spells it
 * in a fifth:
 *
 *   | meaning  | request body | column |
 *   |----------|--------------|--------|
 *   | phone    | `phone`      | `uphone`   |
 *   | address  | `address`    | `Address`  |
 *   | gender   | `gender`     | `ugender`  |
 *   | birth    | `dateOfBirth`| `dateofbirth` |
 *   | company address | `companyAddress` | `Companyaddress` |
 *
 * Ten renames, hand-translated in `services/user.service.js:76-88`, all inside one
 * `if (data.x !== undefined)` block. Two of them are PascalCase (`Address`,
 * `Companyaddress`), which is why this table exists rather than a rename map —
 * a typo in `updateData.Address` is not a crash, it is a silently ignored write,
 * and a silently ignored `address` is a support ticket about a lost field.
 *
 * ## The timestamp columns
 *
 * Every profile field group has a companion column recording when that group last
 * changed: `editprofile`, `editpropic`, `editcomlogo`, `linkpagedate`. They are
 * written on every write to their group and read by nothing in this codebase — the
 * admin UI may use them. They are declared here as part of each group's definition
 * because they are inseparable from it: a profile update that forgets
 * `editprofile` is not a different feature, it is the same feature with one field
 * missing.
 */

/**
 * The editable profile fields, and where each one lands.
 *
 * `max` is the request-body cap enforced by `users.schema.js`. It is recorded here
 * as well as in the schema because the legacy service *also* truncated with
 * `.substring()` — and that truncation was unreachable, since the schema rejects an
 * over-long value with a 400 before the service ever sees it. One enforcement
 * point, in the schema; this column is documentation, not a second gate.
 *
 * @type {Readonly<Record<string, { column: string, max?: number }>>}
 */
const PROFILE_FIELDS = Object.freeze({
  uname: { column: "uname" },
  lname: { column: "lname" },
  phone: { column: "uphone", max: 20 },
  address: { column: "Address", max: 200 },
  company: { column: "company", max: 100 },
  companyAddress: { column: "Companyaddress", max: 200 },
  state: { column: "state" },
  city: { column: "city" },
  gender: { column: "ugender" },
  dateOfBirth: { column: "dateofbirth" },
  wphone: { column: "wphone", max: 20 },
  utype: { column: "utype" },
});

/**
 * The six social links, all of which map to a same-named column.
 *
 * `linkpagedate` is stamped on every write, whether or not any value actually
 * changed — the legacy service wrote all six columns and the timestamp on every
 * call, including one that sent an empty body. Preserved: an empty
 * `PUT /me/links` clears every link and re-stamps the date.
 */
const SOCIAL_FIELDS = Object.freeze([
  "fb",
  "linkedin",
  "tiktok",
  "instagram",
  "twitter",
  "website",
]);

/**
 * Converts a validated `PUT /me` body into a `user.update` payload.
 *
 * Two things happen that the legacy inline version did not make explicit:
 *
 *   - **Absent keys are distinguished from empty ones.** `updateProfileSchema` is
 *     not `.strict()` and every field is `.optional()`, so `{}` and
 *     `{ phone: "" }` are both valid and mean different things. `undefined` is
 *     skipped; `""` is written. Collapsing the two would make it impossible to
 *     clear a field.
 *   - **`editprofile` is stamped only when something was written.** The legacy
 *     version stamped it unconditionally, so a `PUT /me` with an empty body — a
 *     no-op — still claimed the profile had been edited.
 *
 * @param {Record<string, unknown>} body a validated request body
 * @param {string} now ISO timestamp for `editprofile`
 * @returns {Record<string, unknown>} a Prisma `data` payload
 */
function toProfileUpdate(body, now = new Date().toISOString()) {
  const data = {};

  for (const [field, { column }] of Object.entries(PROFILE_FIELDS)) {
    if (body[field] !== undefined) data[column] = body[field];
  }

  if (Object.keys(data).length > 0) data.editprofile = now;

  return data;
}

/**
 * Converts a validated `PUT /me/links` body into a `user.update` payload.
 *
 * `""` becomes `null`, not `""`, because these are nullable link columns and the
 * admin UI reads `null` as "no link" while `""` renders as a broken anchor. The
 * legacy service did the same with `data.fb || null`.
 *
 * @param {Record<string, string>} body
 * @param {string} now ISO timestamp for `linkpagedate`
 * @returns {Record<string, unknown>}
 */
function toLinksUpdate(body, now = new Date().toISOString()) {
  const data = {};

  for (const field of SOCIAL_FIELDS) {
    data[field] = body[field] || null;
  }

  data.linkpagedate = now;

  return data;
}

/**
 * The `select` for `GET /users/me` — the user's own record.
 *
 * 30 columns, and it is a wire contract: the settings page reads them by name.
 * Includes `uemail`, which the public profile also exposes; see the note on
 * {@link PUBLIC_PROFILE_FIELDS} before adding anything here.
 */
const PROFILE_FIELDS_SELECT = Object.freeze([
  "uid",
  "uname",
  "lname",
  "uemail",
  "uphone",
  "utype",
  "uimage",
  "dateofbirth",
  "Address",
  "company",
  "ucompanylogo",
  "state",
  "city",
  "Companyaddress",
  "ugender",
  "wphone",
  "fb",
  "linkedin",
  "tiktok",
  "instagram",
  "twitter",
  "website",
  "deactivate",
  "adminblock",
  "editprofile",
  "editcomlogo",
  "editpropic",
  "linkpagedate",
  "lastseen",
  "udate",
]);

/**
 * The `select` for the `PUT /me` response — 21 columns.
 *
 * **Narrower than {@link PROFILE_FIELDS_SELECT}, and deliberately so.** The legacy
 * service returned a different projection after an update than before one, so
 * `PUT /api/users/me` never echoes the social links or the `*date` columns back.
 * That inconsistency is a wart, but it is frozen by
 * `test/contract/user.test.js`, and "return the same shape as the read" is a
 * client-visible change rather than a refactor.
 */
const PROFILE_UPDATE_FIELDS_SELECT = Object.freeze([
  "uid",
  "uname",
  "lname",
  "uemail",
  "uphone",
  "utype",
  "uimage",
  "ucompanylogo",
  "Address",
  "company",
  "Companyaddress",
  "state",
  "city",
  "ugender",
  "wphone",
  "dateofbirth",
]);

/**
 * The `select` for `GET /users/:id` — the **public** profile.
 *
 * Note what is in it: `uemail`. A public, unauthenticated endpoint returns the
 * email address, the gender and the date of birth of any user by numeric id.
 * That is the M00 finding that made this endpoint public in the first place, and
 * it is still shipping: making the endpoint reachable without a token (M04) without
 * dropping `uemail` from the projection widens it from "any logged-in user can see
 * it" to "anyone on the internet can see it".
 *
 * The id is a sequential `uid`, so the addresses are enumerable rather than
 * merely discoverable.
 *
 * Removing `uemail`, `ugender` and `dateofbirth` from this list is the single
 * highest-value change available to this endpoint, and it is **not** made here
 * because it breaks the public profile widget on the frontend and belongs to a
 * milestone that can say so. Tracked as M00.4.
 */
const PUBLIC_PROFILE_FIELDS_SELECT = Object.freeze([
  "uid",
  "uname",
  "lname",
  "uemail",
  "utype",
  "uimage",
  "company",
  "ucompanylogo",
  "state",
  "city",
  "ugender",
  "fb",
  "linkedin",
  "tiktok",
  "instagram",
  "twitter",
  "website",
  "lastseen",
]);

/**
 * @param {readonly string[]} fields
 * @returns {Record<string, boolean>} a Prisma `select` with every key set to `true`
 */
function select(fields) {
  return Object.fromEntries(fields.map((f) => [f, true]));
}

/**
 * Builds the avatar-write payload.
 *
 * @param {string} filename
 * @param {string} [now]
 * @returns {{ uimage: string, editpropic: string }}
 */
function toImageUpdate(filename, now = new Date().toISOString()) {
  return { uimage: filename, editpropic: now };
}

/**
 * Builds the avatar-clear payload.
 *
 * `""` rather than `null`, matching every other image column in this codebase —
 * `uimage` is `VarChar` and the admin UI tests it for falsiness, so both work,
 * but they must not be mixed up per-row. `deleteAccount` reads it the same way.
 *
 * @param {string} [now]
 * @returns {{ uimage: string, editpropic: string }}
 */
function toImageClear(now = new Date().toISOString()) {
  return { uimage: "", editpropic: now };
}

/**
 * Builds the logo-write payload.
 *
 * @param {string} filename
 * @param {string} [now]
 * @returns {{ ucompanylogo: string, editcomlogo: string }}
 */
function toLogoUpdate(filename, now = new Date().toISOString()) {
  return { ucompanylogo: filename, editcomlogo: now };
}

/**
 * @param {string} [now]
 * @returns {{ ucompanylogo: string, editcomlogo: string }}
 */
function toLogoClear(now = new Date().toISOString()) {
  return { ucompanylogo: "", editcomlogo: now };
}

/**
 * Builds the activate/deactivate payload.
 *
 * The counter-intuitive part, preserved exactly: `deactivate = 1` means
 * **active**, and `uloginvalue` is a second, redundant copy of the same flag.
 * `deactivateAccount` sets both to `0`, `activateAccount` sets both to `1`, and
 * `getPublicProfile` filters on `deactivate: 1` to mean "visible".
 *
 * `uloginvalue` has no reader in this codebase; it is written in three places and
 * read nowhere. It stays because it is in the frozen write set and dropping a
 * column from a write is not observable — removing it *and* the flag it duplicates
 * is a schema question, not this milestone's.
 *
 * @param {boolean} active
 * @param {string} [now]
 * @returns {{ deactivate: number, uloginvalue: number, lastseen: string }}
 */
function toActivationUpdate(active, now = new Date().toISOString()) {
  const flag = active ? 1 : 0;
  return { deactivate: flag, uloginvalue: flag, lastseen: now };
}

module.exports = {
  PROFILE_FIELDS,
  SOCIAL_FIELDS,
  PROFILE_FIELDS_SELECT,
  PROFILE_UPDATE_FIELDS_SELECT,
  PUBLIC_PROFILE_FIELDS_SELECT,
  select,
  toProfileUpdate,
  toLinksUpdate,
  toImageUpdate,
  toImageClear,
  toLogoUpdate,
  toLogoClear,
  toActivationUpdate,
};