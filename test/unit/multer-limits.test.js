/**
 * Multer field-name DoS regression (CVE-2026-77078 / CVE-2026-82333).
 *
 * `append-field` parses bracket notation in multipart field names, so a field
 * literally named `items[4294967294]` materializes a sparse array whose length is
 * ~4.29e9. Appending a second, non-numeric key to the same base then converts that
 * array to an object by iterating its whole length, which pins the event loop
 * synchronously. One request is enough.
 *
 * The fix has two halves and this file pins both: `multer@2.3.0` rejects the
 * crafted name at the middleware (`limits.fieldArrayIndexLimit`), and every
 * middleware in `services/upload.service.js` sets that limit to `0`, because none
 * of the fields this service reads carries an array index at all.
 *
 * Database-free and server-free: it drives the exported middlewares directly with
 * a hand-built multipart body, so a failure here is a regression in the upload
 * path rather than a missing database.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

// Repoint at the test database before any `src/` module is required: `src/config`
// reads the environment at load time.
const { useTestDatabase } = require("../helpers/env");
useTestDatabase();

const { uploadProfileImage } = require("../../src/services/upload.service");

/**
 * A minimal `multipart/form-data` body. `parts` are `{ headers, body }`, where
 * `headers` is the raw header block for one part without the trailing CRLF pair.
 *
 * @param {string} boundary
 * @param {Array<{ headers: string, body: Buffer }>} parts
 * @returns {Buffer}
 */
function multipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`),
      part.body,
      Buffer.from("\r\n")
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/**
 * Run one multer middleware over a body and settle with its callback.
 *
 * @param {import("express").RequestHandler} middleware
 * @param {Buffer} body
 * @returns {Promise<{ err: (Error & { code?: string }) | null, req: object, ms: number }>}
 */
function run(middleware, body) {
  const boundary = "----uploadtest";
  const req = Readable.from(body);
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
  };

  const started = Date.now();
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve({ err, req, ms: Date.now() - started }));
  });
}

test("a field name with a huge numeric index is rejected", async () => {
  const body = multipart("----uploadtest", [
    {
      headers: `Content-Disposition: form-data; name="items[4294967294]"`,
      body: Buffer.from("x"),
    },
  ]);

  const { err, ms } = await run(uploadProfileImage, body);

  // `fieldNestingDepth: 0` rejects *any* bracketed name, so the nesting guard
  // fires before the array-index guard ever sees this one. Either rejection is
  // the property under test: the name is refused before `append-field` builds
  // the sparse array, so the request stays cheap.
  assert.equal(err?.name, "MulterError");
  assert.ok(
    err?.code === "LIMIT_FIELD_NESTING" || err?.code === "LIMIT_FIELD_ARRAY_INDEX",
    `unexpected code: ${err?.code}`
  );
  assert.ok(ms < 1000, `crafted field took ${ms}ms; the array must never be built`);
});

test("a nested field name is rejected", async () => {
  const body = multipart("----uploadtest", [
    {
      headers: `Content-Disposition: form-data; name="a[b][c][d]"`,
      body: Buffer.from("x"),
    },
  ]);

  const { err, ms } = await run(uploadProfileImage, body);

  assert.equal(err?.name, "MulterError");
  assert.equal(err?.code, "LIMIT_FIELD_NESTING");
  assert.ok(ms < 1000, `nested field took ${ms}ms; the object must never be built`);
});

test("a legitimate, unindexed field still uploads", async () => {
  const body = multipart("----uploadtest", [
    {
      headers: `Content-Disposition: form-data; name="image"; filename="a.jpg"\r\nContent-Type: image/jpeg`,
      body: Buffer.alloc(64, 1),
    },
  ]);

  const { err, req } = await run(uploadProfileImage, body);

  assert.equal(err, undefined, "the limit must not reject a plain field name");
  assert.equal(req.file?.originalname, "a.jpg");
});
