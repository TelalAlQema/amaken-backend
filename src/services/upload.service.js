/**
 * `upload.service.js` — re-exports of `platform/storage`.
 *
 * This file used to *be* the storage layer: `processAndSaveImage`,
 * `deleteFileIfExists`, `getUserUploadDir`, `getPropertyUploadDir` and the multer
 * middlewares all lived here, with `__dirname` paths resolved one level up.
 *
 * M02 splits it. The image pipeline, the path handling and the directory
 * knowledge move behind the `platform/storage` **port** (`saveImage`,
 * `deleteFile`, `publicUrl`), and what remains here is:
 *
 *   - the multer middlewares, which are HTTP concerns and belong in the request
 *     path, not in a storage interface;
 *   - these re-exports, so the existing call sites keep working. M03 repoints them
 *     at `platform/storage` directly and deletes this file.
 *
 * ## The single-replica ceiling is still here
 *
 * The only adapter is local disk. Replica B 404s every image replica A wrote.
 * The shared cache, the durable OTP store and the queue removed every *other*
 * single-replica ceiling in M02; this one stays until an S3 adapter implements the
 * port. See `docs/runbook.md`.
 */
const multer = require("multer");
const path = require("path");

const storage = require("../platform/storage");

const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * `memoryStorage`, deliberately.
 *
 * Images are resized and re-encoded by sharp before anything touches the disk, so
 * writing the original to a temp file first would be pure overhead. It also means
 * the storage **port** is what decides where a file lands — multer never gets a
 * destination path, which is what lets an S3 adapter work without changing it.
 */
const memory = multer.memoryStorage();

/**
 * @param {import("express").Request} _req
 * @param {{ mimetype: string }} file
 * @param {(err: Error | null, accept?: boolean) => void} cb
 */
function fileFilter(_req, file, cb) {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only JPG, PNG, WEBP, and GIF are allowed."));
  }
}

// ─── middleware ──────────────────────────────────────────────────────────────
//
// The field name in `.single()` / `.fields()` **must** match the client's FormData
// key. They were inconsistent once already (`avatar` / `logo` against
// `.single("image")`) and every one of these has to be verified against the
// calling page before an upload path is touched.

/** 2MB. The profile avatar page. */
const uploadProfileImage = multer({ storage: memory, fileFilter, limits: { fileSize: 2 * 1024 * 1024 } })
  .single("image");

/** 5MB. The company logo page. */
const uploadLogo = multer({ storage: memory, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single(
  "image"
);

/** 5MB per file, up to 8 files. The property create/edit form. */
const uploadPropertyImages = multer({
  storage: memory,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).fields([
  { name: "pimage", maxCount: 1 },
  { name: "pimage1", maxCount: 1 },
  { name: "pimage2", maxCount: 1 },
  { name: "pimage3", maxCount: 1 },
  { name: "pimage4", maxCount: 1 },
  { name: "mapimage", maxCount: 1 },
  { name: "topmapimage", maxCount: 1 },
  { name: "groundmapimage", maxCount: 1 },
]);

/** 5MB. The about page. */
const uploadAboutImage = multer({ storage: memory, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } })
  .single("image");

/** 5MB. The team page. */
const uploadTeamImage = multer({ storage: memory, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } })
  .single("image");

// ─── pre-M02 API, preserved ──────────────────────────────────────────────────

/**
 * Resize, re-encode and store an uploaded image.
 *
 * @param {{ buffer: Buffer, mimetype: string }} file
 * @param {string} targetDir an absolute path, as the pre-M02 callers pass it.
 *   Kept as a path rather than a `StorageDir` because the call sites pass one;
 *   M03 repoints them and this translation goes away with them.
 * @param {string} prefix
 * @param {number} [maxWidth]
 * @param {number} [maxHeight]
 * @returns {Promise<string>} the stored filename — **only** the filename, which is
 *   what gets persisted in the database.
 */
function processAndSaveImage(file, targetDir, prefix, maxWidth = 800, maxHeight = 800) {
  // Maps the caller's absolute path back to a logical directory. The two that
  // exist are `properties/` and `users/` — pre-M02 wrote every avatar, logo, team
  // and about image into `users/`.
  //
  // M04 removed the other half of this problem: `modules/users` and `modules/admins`
  // no longer call `processAndSaveImage` at all. They pass `StorageDir.USERS` to the
  // `platform/storage` port directly, so there is no absolute path to map back from
  // on the read side either. What is left here is for the property, CMS and team
  // routes, which have not been migrated yet.
  //
  // Anything else falls back to `USERS` rather than a category-specific directory,
  // because a file written to `avatars/` cannot be found by the code that reads it.
  const dir =
    path.basename(targetDir) === storage.StorageDir.PROPERTIES
      ? storage.StorageDir.PROPERTIES
      : storage.StorageDir.USERS;

  return storage.saveImage(file, dir, prefix, { maxWidth, maxHeight });
}

/**
 * Deletes a file given its absolute path.
 *
 * @param {string} filepath
 * @returns {Promise<boolean>} true if a file was removed. Never throws — the
 *   pre-M02 version swallowed every error, and an orphaned file on disk is not
 *   worth failing a user's request over.
 */
function deleteFileIfExists(filepath) {
  if (!filepath) return Promise.resolve(false);

  // `basename` discards any directory part, so a caller passing
  // `../../etc/passwd` deletes `passwd` inside the upload root rather than
  // anything outside it.
  const relative = path
    .relative(storage.getStorage().root, filepath)
    .split(path.sep)
    .join("/");

  if (!relative || relative.startsWith("..")) return Promise.resolve(false);

  return storage.getStorage().delete(relative);
}

/** Absolute directory the pre-M02 callers wrote user images to. */
function getUserUploadDir() {
  return path.join(storage.getStorage().root, "users");
}

/** Absolute directory the pre-M02 callers wrote property images to. */
function getPropertyUploadDir() {
  return path.join(storage.getStorage().root, "properties");
}

/**
 * Resolves a filename inside a directory, rejecting traversal.
 *
 * @param {string} directory
 * @param {string} filename
 * @returns {string}
 */
function getFilePath(directory, filename) {
  return storage.getFilePath(directory, filename);
}

module.exports = {
  uploadProfileImage,
  uploadLogo,
  processAndSaveImage,
  deleteFileIfExists,
  getUserUploadDir,
  getPropertyUploadDir,
  getFilePath,
  uploadPropertyImages,
  uploadAboutImage,
  uploadTeamImage,
  // Exposed so a caller can move to the port without changing its import.
  StorageDir: storage.StorageDir,
};
