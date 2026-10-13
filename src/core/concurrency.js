/**
 * Bounded-concurrency `map`.
 *
 * ## Why this exists
 *
 * `services/property.service.js` processed up to eight uploaded images in a `for`
 * loop with an `await` in the body, which is fully serial: eight sharp decode-resize-encode
 * round trips, one after the other, in the request path. The obvious fix —
 * `await Promise.all(files.map(process))` — is worse in a way that is not obvious.
 *
 * Eight concurrent sharp pipelines decode their input at once. A 1200×1200 RGB decode is
 * roughly 4MB of pixel buffer per image before any resize, and the multer buffers for all
 * eight files are *already* resident because `uploadPropertyImages` uses `memoryStorage`.
 * So the unbounded version peaks at eight live decodes on top of up to 40MB of uploaded
 * buffers, on a container with a memory limit. sharp does not reject the work; the kernel
 * OOM-kills the process, which takes every in-flight request with it.
 *
 * Bounded concurrency trades a little wall-clock for a ceiling. `limit` is the number of
 * decodes that may be live at once.
 *
 * ## Why not `p-limit` or a worker pool
 *
 * Both are a dependency. The whole primitive is twenty lines and has no configuration
 * surface beyond the limit, and `platform/` already exists for things that earn a file of
 * their own.
 *
 * ## Error handling
 *
 * The first rejection wins and propagates. The other workers are **not** cancelled —
 * JavaScript has no cancellation — so a worker mid-`await` finishes the item it is on and
 * then observes the shared index has moved past the end and exits. That means a rejected
 * batch can still write some files to storage before the request fails.
 *
 * That is the same shape as the serial version's failure (a partially-processed upload),
 * and it is why the image columns are only written after every file has succeeded — see
 * `properties.service.createProperty`.
 *
 * @module core/concurrency
 */

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit how many `fn` calls may be in flight at once. Must be >= 1.
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} results in **input order**, not completion order
 * @throws {Error} at call time when `limit` is not a positive integer
 */
async function mapWithConcurrency(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
  }

  const list = Array.from(items ?? []);
  if (list.length === 0) return [];

  /** @type {R[]} */
  const results = new Array(list.length);

  // A single cursor shared by every worker, read-then-incremented with no await in
  // between. That is what makes the assignment of an index to a worker atomic in JS:
  // there is no interleaving point between `next++` and the worker using it.
  let next = 0;

  const workerCount = Math.min(limit, list.length);

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));

  return results;
}

module.exports = { mapWithConcurrency };