/**
 * The local-disk storage adapter.
 *
 * Implements the `platform/storage` port against the filesystem. This is the
 * **only** adapter that exists today, and its existence is precisely why the API
 * is pinned to one replica: files live on this container's disk, and no other
 * replica can see them. See `docs/runbook.md` § *Deployment constraint: single
 * replica*.
 *
 * The S3 adapter lands later. Until it does, **nothing outside this file may
 * touch `node:fs` for uploads** — that is what keeps the swap a one-file change.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { StorageDir, buildKey, assertAdapter } = require("./port");
const { getLogger } = require("../../core/logger");

/**
 * @param {object} [options]
 * @param {string} [options.root] absolute directory that is the storage root.
 *   Defaults to `config.paths.uploads` (`UPLOAD_DIR`).
 * @returns {object} an adapter satisfying the port.
 */
function createLocalDiskStorage(options = {}) {
  const root = path.resolve(options.root || require("../../config").paths.uploads);

  /** Absolute path for a key, refusing anything that escapes `root`. */
  function resolveKey(key) {
    const resolved = path.resolve(root, key);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new Error(`storage key escapes root: ${key}`);
    }
    return resolved;
  }

  async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
  }

  return assertAdapter(
    {
      name: "local-disk",
      root,

      /**
       * @param {string} key
       * @param {Buffer} buffer
       * @param {{ contentType?: string, dir?: string }} [meta]
       * @returns {Promise<{ key: string, size: number, contentType: string }>}
       */
      async put(key, buffer, meta = {}) {
        const finalKey = meta.dir ? buildKey(meta.dir, key) : key;
        const filepath = resolveKey(finalKey);

        await ensureDir(path.dirname(filepath));
        await fsp.writeFile(filepath, buffer);

        return {
          key: finalKey,
          size: buffer.length,
          contentType: meta.contentType || "application/octet-stream",
        };
      },

      /**
       * @param {string} key
       * @returns {Promise<Buffer | null>} null when absent — an absent file is
       * not an error, it is the answer.
       */
      async get(key) {
        try {
          return await fsp.readFile(resolveKey(key));
        } catch (err) {
          if (err.code === "ENOENT") return null;
          throw err;
        }
      },

      /**
       * @param {string} key
       * @returns {Promise<boolean>} true if a file was actually removed.
       */
      async delete(key) {
        try {
          await fsp.unlink(resolveKey(key));
          return true;
        } catch (err) {
          if (err.code === "ENOENT") return false;
          getLogger().error(
            { key, err: { message: err.message } },
            "storage delete failed"
          );
          return false;
        }
      },

      /**
       * @param {string} key
       * @returns {Promise<boolean>}
       */
      async exists(key) {
        try {
          const stat = await fsp.stat(resolveKey(key));
          return stat.isFile();
        } catch (err) {
          if (err.code === "ENOENT") return false;
          throw err;
        }
      },

      /**
       * The URL `express.static` already serves. Relative on purpose: the
       * browser resolves it against the API origin, which is the one that
       * actually has the file. An S3 adapter returns an absolute URL here
       * instead — that is the visible difference between the adapters.
       *
       * @param {string} key
       * @param {{ absolute?: boolean, publicBase?: string }} [opts]
       * @returns {string}
       */
      url(key, opts = {}) {
        const relative = `/uploads/${key}`;
        if (!opts.absolute) return relative;
        const base = (opts.publicBase || "").replace(/\/+$/, "");
        return base ? `${base}${relative}` : relative;
      },

      /**
       * @param {string} [dir] logical directory, or all of storage when omitted
       * @returns {Promise<{ key: string, size: number, modifiedAt: Date }[]>}
       */
      async list(dir) {
        const dirPath = dir ? resolveKey(dir) : root;

        let names;
        try {
          names = await fsp.readdir(dirPath);
        } catch (err) {
          if (err.code === "ENOENT") return [];
          throw err;
        }

        const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
        const entries = [];

        for (const name of names) {
          const full = path.join(dirPath, name);
          let stat;
          try {
            stat = await fsp.stat(full);
          } catch {
            continue; // raced with a delete
          }
          if (stat.isDirectory()) continue;
          entries.push({
            key: `${prefix}${name}`,
            size: stat.size,
            modifiedAt: stat.mtime,
          });
        }

        return entries;
      },

      /**
       * @param {string} key
       * @returns {Promise<import("node:stream").Readable | null>}
       */
      async readStream(key) {
        const filepath = resolveKey(key);
        if (!fs.existsSync(filepath)) return null;
        return fs.createReadStream(filepath);
      },

      /**
       * @returns {Promise<{ ok: boolean, adapter: string, detail?: string }>}
       */
      async health() {
        try {
          // Write-and-remove: `access()` proves permission but not writability,
          // and the write is what a duplicate replica id or a full disk breaks.
          // No timeout here — `core/health/routes.js` wraps every probe in one,
          // and a full or hung NFS mount is exactly the case it exists for.
          await ensureDir(root);
          const probe = path.join(root, `.healthcheck-${process.pid}`);
          await fsp.writeFile(probe, "ok");
          await fsp.unlink(probe);
          return { ok: true, adapter: "local-disk", detail: root };
        } catch (err) {
          return { ok: false, adapter: "local-disk", detail: err.message };
        }
      },

      /**
       * Local disk holds no sockets, so there is nothing to drain. Present for
       * interface parity: the drain calls it unconditionally so the S3 adapter's
       * `close()` does not need a separate code path in `server.js`.
       *
       * @returns {Promise<void>}
       */
      async close() {},
    },
    "local-disk"
  );
}

module.exports = { createLocalDiskStorage, StorageDir };
