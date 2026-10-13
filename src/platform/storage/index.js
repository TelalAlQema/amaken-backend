/**
 * `platform/storage` — the one place the application is allowed to read or
 * write a file.
 *
 * M02 splits storage into a **port** (`port.js`) and an **adapter**
 * (`local-disk.js`), and this module is the single resolved instance plus the
 * helpers every caller actually needs. The rule it enforces: nothing outside
 * `platform/storage/` calls `node:fs` for uploads. That is what makes the S3
 * adapter a one-file change rather than a grep across the codebase.
 *
 * ## Why the API is still pinned to a single replica
 *
 * The only adapter is local disk. Replica B serves nothing replica A wrote —
 * every uploaded image 404s. The shared cache, the durable OTP store and the queue
 * remove every *other* single-replica ceiling in M02, but not this one. **Until
 * the S3 adapter lands, scale up, not out.** `docs/runbook.md` § *Deployment
 * constraint: single replica* is the operational statement of the same fact.
 *
 * @see ./port.js for the interface
 * @see ./local-disk.js for the current implementation
 */
const path = require("node:path");
const sharp = require("sharp");

const config = require("../../config");
const { StorageDir, buildKey, isSafeKey } = require("./port");
const { createLocalDiskStorage } = require("./local-disk");

/** @type {object | null} */
let storage = null;

/** @type {Set<import("node:http").Server> | null} static servers, keyed by dir. */
const ensuredDirs = new Set();

/**
 * The resolved adapter. Lazily built so a process that only serves `/health`
 * does not mkdir anything.
 *
 * @returns {object}
 */
function getStorage() {
  if (!storage) {
    storage = createLocalDiskStorage({ root: config.paths.uploads });
  }
  return storage;
}

/** Test seam — lets a unit test point the process at a temp directory. */
function setStorage(adapter) {
  storage = adapter;
  return storage;
}

/**
 * Re-encodes an uploaded image and persists it through the adapter.
 *
 * This is the behaviour `services/upload.service.js:41-52` had inline
 * (`processAndSaveImage`), moved behind the port. **Only the filename is
 * persisted in the database** — that invariant is unchanged, and it is why every
 * read path joins the stored filename back onto a directory.
 *
 * @param {{ buffer: Buffer, mimetype: string }} file a multer memory-storage file
 * @param {string} dir one of {@link StorageDir}
 * @param {string} prefix filename prefix, e.g. `"property"` or `"avatar"`
 * @param {{ maxWidth?: number, maxHeight?: number, format?: "webp" | "png" }} [opts]
 * @returns {Promise<string>} the stored filename — **not** the full key.
 */
async function saveImage(file, dir, prefix, opts = {}) {
  const { maxWidth = 800, maxHeight = 800, format } = opts;
  const ext = format || (file.mimetype === "image/png" ? "png" : "webp");
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const output = await sharp(file.buffer)
    .resize(maxWidth, maxHeight, { fit: "inside", withoutEnlargement: true })
    .toFormat(ext === "png" ? "png" : "webp", { quality: 85 })
    .toBuffer();

  await getStorage().put(filename, output, { contentType: `image/${ext}`, dir });

  return filename;
}

/**
 * Writes an arbitrary buffer (a generated TSV export, for M05).
 *
 * @param {Buffer} buffer
 * @param {string} dir
 * @param {string} filename
 * @param {{ contentType?: string }} [meta]
 * @returns {Promise<string>} the stored filename.
 */
async function saveBuffer(buffer, dir, filename, meta = {}) {
  await getStorage().put(filename, buffer, { dir, contentType: "text/tab-separated-values", ...meta });
  return filename;
}

/**
 * Absolute path for a stored filename within a directory.
 *
 * Retained because `deleteFileIfExists`-style callers pass a full path, and
 * rewriting every one of them is M03's job. New code should use
 * {@link deleteFile} with a filename and a dir instead.
 *
 * @param {string} directory
 * @param {string} filename
 * @returns {string}
 */
function getFilePath(directory, filename) {
  const sanitized = path.basename(filename);
  const resolved = path.resolve(directory, sanitized);
  if (resolved !== path.resolve(directory) && !resolved.startsWith(path.resolve(directory) + path.sep)) {
    throw new Error("Invalid file path: directory traversal detected");
  }
  return resolved;
}

/**
 * Deletes a stored file by filename and logical directory. Returns false when
 * the file was already gone — deleting an absent file is not an error.
 *
 * @param {string} dir
 * @param {string} filename
 * @returns {Promise<boolean>}
 */
function deleteFile(dir, filename) {
  if (!filename) return Promise.resolve(false);
  return getStorage().delete(buildKey(dir, filename));
}

/**
 * Public URL for a stored file. Resolves to `/uploads/<dir>/<filename>`, which
 * is what `express.static` serves and what is persisted alongside rows.
 *
 * @param {string} dir
 * @param {string} filename
 * @param {{ absolute?: boolean, publicBase?: string }} [opts]
 * @returns {string}
 */
function publicUrl(dir, filename, opts = {}) {
  if (!filename) return "";
  return getStorage().url(buildKey(dir, filename), opts);
}

/**
 * Ensures a logical directory exists on disk, and returns an
 * `express.static` middleware for it.
 *
 * `express.static` does not need the directory to pre-exist, so this exists for
 * the *health* check and for `fs.existsSync`-gated legacy callers, not for
 * serving. Kept here so the one place that knows about directories is the port.
 *
 * @param {string} dir
 * @returns {Promise<object>}
 */
async function ensureDir(dir) {
  if (!ensuredDirs.has(dir)) {
    ensuredDirs.add(dir);
    await getStorage().health();
  }
  return getStorage();
}

module.exports = {
  // the port
  StorageDir,
  buildKey,
  isSafeKey,
  // the resolved adapter
  getStorage,
  setStorage,
  // helpers
  saveImage,
  saveBuffer,
  deleteFile,
  publicUrl,
  getFilePath,
  ensureDir,
};
