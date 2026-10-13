/**
 * The leads TSV export.
 *
 * ## The rendering is shared; the *delivery* is not
 *
 * `renderTsv` is called from two places: `lead.service.exportLeads`, which the
 * `GET /api/admin/leads/export` route still serves synchronously, and the queued
 * processor below. They share this file so the byte format cannot drift — a
 * queued export with different columns from the synchronous one is the kind of
 * difference nobody notices until a user reconciles two spreadsheets.
 *
 * M05 replaces the route with a 202 and a job id. Until then the sync path stays,
 * because changing this endpoint's contract in M02 would break the M00 contract
 * baseline for no gain.
 *
 * ## Formula injection
 *
 * Lead names, emails and nationalities come from a **public unauthenticated
 * form**, so they are attacker-controlled and Excel evaluates a leading `=`, `+`,
 * `-` or `@` when the file is opened. `cell` prefixes those with `'`. Without it,
 * `=cmd|'/c calc'!A1` in the Name column is a stored XSS with a spreadsheet
 * attached, and it fires on the machine of the **admin** who opens the export.
 *
 * ## The BOM is applied by the caller
 *
 * `renderTsv` returns the body without one. The route prepends `\xEF\xBB\xBF`
 * itself (it did before M02 and the contract baseline pins it), and the queued
 * writer prepends it via {@link toBuffer}. Excel needs it to detect UTF-8, and
 * baking it into the renderer would put an invisible character at the start of
 * every string a caller compares against a fixture.
 */
const { prisma } = require("../../db/prisma");
const storage = require("../../storage");
const { StorageDir } = require("../../storage/port");

/** UTF-8 byte order mark. Excel reads a BOM-less TSV as the local codepage. */
const BOM = "\xEF\xBB\xBF";

/** Column order. Fixed, and part of what the endpoint promises. */
const COLUMNS = Object.freeze([
  "ID",
  "PID",
  "Title",
  "Name",
  "Email",
  "Nationality",
  "Phone",
  "IP",
  "Device",
  "Created At",
]);

/** Leading characters Excel treats as the start of a formula. */
const FORMULA_PREFIX = /^[=+\-@]/;

/**
 * Renders one cell, neutralising anything that would break the file or execute.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) return "";
  // `0` is a value, not an absence — a lead id of 0 must not render blank.
  let text = value instanceof Date ? value.toISOString() : String(value);

  // A tab or newline inside a cell shifts every column after it, silently. A space
  // preserves the information for a human reading the file.
  text = text.replace(/[\t\r\n]+/g, " ");

  // Formula injection. The apostrophe is Excel's "this is text" marker and is not
  // displayed.
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;

  return text;
}

/**
 * The Prisma `where` for an export request.
 *
 * A `range` needs **both** bounds. A half-open range silently means "everything
 * from the given date onwards" or "everything up to it", and an admin asking for
 * "last month" with a typo gets every lead ever recorded in a file they then
 * email around. An unrecognised `mode` is unfiltered, which is what `all` means.
 *
 * @param {{ mode?: string, from?: string, to?: string }} request
 * @returns {object} a Prisma `where`
 */
function buildWhere({ mode, from, to } = {}) {
  if (mode !== "range" || !from || !to) return {};

  return {
    created_at: {
      gte: new Date(`${from}T00:00:00.000Z`),
      lte: new Date(`${to}T23:59:59.999Z`),
    },
  };
}

/**
 * Renders leads as a TSV body, without the BOM.
 *
 * @param {Array<object>} leads
 * @returns {string}
 */
function renderTsv(leads) {
  const rows = [COLUMNS.join("\t")];

  for (const lead of leads || []) {
    rows.push(
      [
        lead.id,
        lead.pid,
        lead.title,
        lead.name,
        lead.email,
        lead.nationality,
        lead.phone,
        lead.ip,
        lead.device,
        lead.created_at,
      ]
        .map(cell)
        .join("\t")
    );
  }

  return rows.join("\n");
}

/**
 * The file bytes: BOM + body.
 *
 * @param {Array<object>} leads
 * @returns {Buffer}
 */
function toBuffer(leads) {
  return Buffer.concat([Buffer.from(BOM, "binary"), Buffer.from(renderTsv(leads), "utf8")]);
}

/**
 * The queued processor.
 *
 * Reads the rows itself rather than receiving them in the payload: a payload
 * carrying every lead would be a `TEXT` column holding the entire lead table,
 * which defeats the point of moving the work off the request path. The filter
 * travels in the payload and the rows are read when the job runs, so a job
 * enqueued behind a backlog exports what is true at export time.
 *
 * Writes through `platform/storage` rather than `node:fs`, so the file lands
 * wherever the S3 adapter will eventually put it — and so the local-disk adapter
 * stays the only thing that knows what a path is.
 *
 * @param {object} payload
 * @param {"all" | "range"} [payload.mode]
 * @param {string} [payload.from]
 * @param {string} [payload.to]
 * @param {number} [payload.page]
 * @param {number} [payload.limit]
 * @returns {Promise<{ key: string, rows: number }>}
 * @throws when the export cannot be written, so the job retries
 */
async function processLeadsExport({ mode, from, to, page, limit } = {}) {
  const effectiveMode = mode === "page" || mode === "range" ? mode : "all";

  const leads = await prisma.propertyLead.findMany({
    where: buildWhere({ mode: effectiveMode, from, to }),
    orderBy: { id: "desc" },
    ...(effectiveMode === "page" ? { skip: ((page || 1) - 1) * (limit || 10), take: limit || 10 } : {}),
  });

  const filename = `leads_export_${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`;
  const key = await storage.saveBuffer(toBuffer(leads), StorageDir.EXPORTS, filename, {
    contentType: "text/tab-separated-values",
  });

  return { key: `${StorageDir.EXPORTS}/${key}`, rows: leads.length };
}

module.exports = {
  BOM,
  COLUMNS,
  cell,
  buildWhere,
  renderTsv,
  toBuffer,
  processLeadsExport,
};