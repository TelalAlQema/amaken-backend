const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../middleware/errorHandler");
const queue = require("../../platform/queue");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

// ─── Lead Submission ────────────────────────────────────────────────

/**
 * Records a property enquiry and notifies the admin inbox.
 *
 * The notification is **queued** (M02). It used to be awaited here, which meant a
 * user's "I would like to view this property" form submission was gated on an SMTP
 * round-trip *and* on the full lead-table scan the notification performed. The
 * lead row is committed first and the job is enqueued after, so a worker that runs
 * immediately still sees the row.
 *
 * Dashboard caching, and the invalidation that would go with it, are M06 — this
 * milestone ships the cache and the queue but does not decide the dashboard's
 * TTL or its invalidation policy.
 */
async function submitLead(propertyId, data, request = {}) {
  const property = await prisma.property.findFirst({ where: { id: propertyId } });
  if (!property) throw new AppError("Property not found", 404, "PROPERTY_NOT_FOUND");

  const lead = await prisma.propertyLead.create({
    data: {
      pid: propertyId,
      title: property.title,
      saleid: String(property.saleid),
      name: data.name.substring(0, 255),
      email: data.email.substring(0, 255),
      nationality: (data.nationality || "").substring(0, 100),
      phone: data.phone.substring(0, 100),
      ip: (request.ip || request.socket?.remoteAddress || "").substring(0, 50),
      device: (request.headers?.["user-agent"] || "").substring(0, 255),
    },
  });

  await invalidateDashboard();

  // Fail-open: a dropped notification must never turn a recorded lead into a 500.
  // See platform/queue/index.js for why, and the enqueue-error counter as the
  // alarm.
  await queue.enqueueLeadNotification({ kind: "lead", leadId: lead.id, email: lead.email, propertyId });

  return lead;
}

// ─── Admin Lead Management ──────────────────────────────────────────

async function listLeads(page = 1, limit = 10, filters) {
  const where = {};

  if (filters?.from && filters?.to) {
    where.created_at = {
      gte: new Date(`${filters.from}T00:00:00.000Z`),
      lte: new Date(`${filters.to}T23:59:59.999Z`),
    };
  }

  const [leads, total] = await Promise.all([
    prisma.propertyLead.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.propertyLead.count({ where }),
  ]);

  return {
    items: leads,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function deleteLead(id) {
  const lead = await prisma.propertyLead.findFirst({ where: { id } });
  if (!lead) throw new AppError("Lead not found", 404, "LEAD_NOT_FOUND");

  await prisma.propertyLead.delete({ where: { id } });
  await invalidateDashboard();
  return { message: "Lead deleted" };
}

async function bulkDeleteLeads(ids) {
  if (!ids.length) throw new AppError("No IDs provided", 400, "NO_IDS");

  const result = await prisma.propertyLead.deleteMany({
    where: { id: { in: ids } },
  });

  if (result.count) await invalidateDashboard();
  return { deleted: result.count, message: `${result.count} leads deleted` };
}

async function deleteAllLeads() {
  const result = await prisma.propertyLead.deleteMany();
  if (result.count) await invalidateDashboard();
  return { deleted: result.count, message: `${result.count} leads deleted` };
}

/**
 * Builds the TSV, synchronously, in the request.
 *
 * **M02 leaves this endpoint's behaviour alone.** M05 replaces the route handler
 * with a queue enqueue; the queued version is a different contract (a 202 and a
 * job id, not a download), and changing it here would break the M00 contract
 * baseline for no gain in this milestone.
 *
 * What M02 *does* change is the rendering: both paths now go through
 * `renderTsv` in `platform/queue/jobs/leads-export.js`, so the BOM, the column
 * order and the formula-injection guard cannot drift apart. That matters because
 * the sync path sanitises only tabs and newlines, while the queued path also
 * neutralises a leading `=` — a lead name of `=cmd|'/c calc'!A1` is attacker
 * controlled, and the sync path would hand it to Excel verbatim.
 */
async function exportLeads(mode, page = 1, limit = 10, filters) {
  const { renderTsv, buildWhere } = require("../../platform/queue/jobs/leads-export");
  const maxRows = 10000;

  const leads = await prisma.propertyLead.findMany({
    where: buildWhere({ mode, from: filters?.from, to: filters?.to }),
    orderBy: { id: "desc" },
    skip: mode === "page" ? (page - 1) * limit : 0,
    take: mode === "page" ? limit : maxRows + 1,
  });

  if (leads.length > maxRows) {
    throw new AppError("Export exceeds the 10,000 row limit; select a date range", 413, "EXPORT_TOO_LARGE");
  }

  return renderTsv(leads);
}

module.exports = {
  submitLead,
  listLeads,
  deleteLead,
  bulkDeleteLeads,
  deleteAllLeads,
  exportLeads,
};

