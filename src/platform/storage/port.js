/**
 * The storage port.
 *
 * This file is an **interface, not an implementation**. It exists so that M05
 * (queue-based export) and M06 (dashboard cache) write against `platform/storage`
 * and never against `node:fs`, and so the S3 adapter can land later without a
 * call-site change.
 *
 * ## Why this is the hard single-replica blocker
 *
 * `backend/public/uploads` is local disk. Replica B serves nothing that replica A
 * wrote: every avatar, logo, team photo, about image and property image written
 * to A 404s on B. No queue, no cache and no shared database changes that — it is
 * a shared-nothing filesystem.
 *
 * **Until an S3 adapter implements this port, the API must run as exactly one
 * replica.** See `docs/runbook.md` § *Deployment constraint: single replica* for
 * the exit path. The queue and the cache going shared does not relax this.
 *
 * ## The interface
 *
 * Adapters implement:
 *
 *   put(key, buffer, { contentType, dir })  → { key, size, contentType }
 *   get(key)                                → Buffer | null
 *   delete(key)                             → boolean
 *   exists(key)                             → boolean
 *   url(key, { absolute })                  → string   (absolute needs a base)
 *   list(dir)                               → [{ key, size, modifiedAt }]
 *   readStream(key)                         → Readable | null
 *   health()                                → { ok, adapter, detail? }
 *   close()                                 → Promise<void>
 *
 * `dir` is a logical directory such as `"properties"` or `"team"`, not a
 * filesystem path. It is joined into `key` by the adapter and never
 * concatenated into a real path by a caller — that is what makes the interface
 * path-traversal-proof by construction.
 */
const path = require("node:path");

/**
 * Logical directories the application uses. Not filesystem paths.
 *
 * `USERS` is the odd one out and is named that way deliberately. It is not a
 * category — it is the directory the pre-M02 code wrote *every* non-property
 * image into: profile avatars, company logos, team photos and about images all
 * share `public/uploads/users/`, and the database rows holding those filenames
 * are addressed by callers that rebuild the path themselves.
 *
 * M04 is the milestone that stopped those callers from doing so: `modules/users` and
 * `modules/admins` now call `saveImage(file, StorageDir.USERS, …)` and
 * `deleteFile(StorageDir.USERS, filename)` on this port, so the path is rebuilt in
 * one place. `services/upload.service.js` still exports `getUserUploadDir` and
 * `getFilePath` for the not-yet-migrated property and CMS routes, and its comment
 * says which they are.
 *
 * Renaming the directory to `avatars` — which reads better and is what the other
 * entries are named for — would write new files somewhere the read path does not
 * look, so an image would 404 immediately after a successful upload. Directory
 * names are part of the persisted contract until every row is migrated. When
 * `AVATARS`/`LOGOS`/`TEAM`/`ABOUT` are actually used, they need a data migration
 * in the same change.
 */
const StorageDir = Object.freeze({
  PROPERTIES: "properties",
  USERS: "users",
  TEAM: "team",
  ABOUT: "about",
  AVATARS: "avatars",
  LOGOS: "logos",
  EXPORTS: "exports",
});

/**
 * Rejects anything that could escape the adapter root.
 *
 * Applied by every adapter, but validated here as well: a caller that passes
 * `../../etc/passwd` as `key` should be rejected by the *port*, not depend on
 * every adapter remembering.
 *
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.includes("\0")) return false;
  if (path.isAbsolute(key)) return false;
  // Normalising before comparing collapses `a/../..` to `..`, which the next
  // check rejects. A raw `includes("..")` would also reject legitimate names
  // like `property..jpg`, which is worse than useless.
  const normalised = path.posix.normalize(key);
  if (normalised.startsWith("../") || normalised === ".." || normalised.startsWith("/")) return false;
  return true;
}

/**
 * Builds the namespaced key for an upload. Pure, so it is unit-testable and so
 * every caller produces the same key for the same inputs.
 *
 * @param {string} dir one of {@link StorageDir}
 * @param {string} filename already-sanitised basename, no directory part
 * @returns {string}
 */
function buildKey(dir, filename) {
  const safeDir = String(dir || "")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  const safeName = path.posix.basename(String(filename || ""));

  // `basename("..")` is `".."`, which is truthy and would pass a truthiness check
  // while producing the key `properties/..` — a directory reference, not a file.
  // Dot segments have to be rejected explicitly.
  if (!safeDir || !safeName || safeName === "." || safeName === "..") {
    throw new Error(`storage key could not be built from dir=${dir} filename=${filename}`);
  }

  const key = `${safeDir}/${safeName}`;
  if (!isSafeKey(key)) throw new Error(`unsafe storage key rejected: ${key}`);
  return key;
}

/** Every method an adapter must implement. */
const REQUIRED_METHODS = Object.freeze([
  "put",
  "get",
  "delete",
  "exists",
  "url",
  "list",
  "readStream",
  "health",
  "close",
]);

/**
 * Throws unless `impl` satisfies the port. Called by every adapter's factory so
 * a missing method fails at boot rather than on the first upload.
 *
 * @param {object} impl
 * @param {string} name
 * @returns {object} impl
 */
function assertAdapter(impl, name) {
  const missing = REQUIRED_METHODS.filter((m) => typeof impl[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`storage adapter "${name}" is missing: ${missing.join(", ")}`);
  }
  return impl;
}

module.exports = { StorageDir, isSafeKey, buildKey, assertAdapter, REQUIRED_METHODS };
