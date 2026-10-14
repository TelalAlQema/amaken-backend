const { prisma } = require("../../platform/db/prisma");
const { remember } = require("../../platform/cache");

const DASHBOARD_TTL_SECONDS = 30;

function numericRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
}

async function getDashboardStats() {
  return remember("dashboard", "stats", async () => {
    const [row] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM admin) AS adminCount,
        (SELECT COUNT(*) FROM user WHERE utype = 'User') AS userCount,
        (SELECT COUNT(*) FROM user WHERE utype = 'Agent') AS agentCount,
        (SELECT COUNT(*) FROM user WHERE utype = 'Builder') AS builderCount,
        (SELECT COUNT(*) FROM property) AS totalProperties,
        (SELECT COUNT(*) FROM property WHERE status = 'available') AS availableProperties,
        (SELECT COUNT(*) FROM property WHERE status = 'sold_out') AS soldOutProperties,
        (SELECT COUNT(*) FROM property WHERE stype = 'rent') AS forRent,
        (SELECT COUNT(*) FROM property WHERE stype = 'sale') AS forSale,
        (SELECT COUNT(*) FROM property WHERE adminapproval = 0) AS pendingApproval,
        (SELECT COUNT(*) FROM property_leads) AS totalLeads,
        (SELECT COUNT(*) FROM contact) AS totalContacts,
        (SELECT COUNT(*) FROM feedback) AS totalFeedback,
        (SELECT COUNT(*) FROM city) AS totalCities,
        (SELECT COUNT(*) FROM state) AS totalStates,
        (SELECT COUNT(*) FROM newmember) AS totalTeamMembers,
        (SELECT COUNT(*) FROM about) AS totalAboutEntries
    `;
    return numericRow(row);
  }, DASHBOARD_TTL_SECONDS);
}

async function getChartData(email, status) {
  const key = `charts:${Buffer.from(JSON.stringify([email || null, status || null])).toString("base64url")}`;
  return remember("dashboard", key, async () => {
    const [row] = await prisma.$queryRaw`
      SELECT
        COUNT(CASE WHEN (${!status} OR status = ${status || ""}) THEN 1 END) AS total,
        COALESCE(SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END), 0) AS available,
        COALESCE(SUM(CASE WHEN status = 'sold_out' THEN 1 ELSE 0 END), 0) AS sold
      FROM property
      WHERE (${!email} OR email = ${email || ""})
    `;
    return numericRow(row);
  }, DASHBOARD_TTL_SECONDS);
}

async function getSidebarCounts() {
  return remember("dashboard", "sidebar-counts", async () => {
    const [row] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM admin) AS admins,
        (SELECT COUNT(*) FROM user WHERE utype = 'User') AS users,
        (SELECT COUNT(*) FROM user WHERE utype = 'Agent') AS agents,
        (SELECT COUNT(*) FROM user WHERE utype = 'Builder') AS builders,
        (SELECT COUNT(*) FROM property) AS totalProperties,
        (SELECT COUNT(*) FROM property WHERE status = 'available') AS availableProperties,
        (SELECT COUNT(*) FROM property WHERE adminapproval = 0) AS pendingApproval,
        (SELECT COUNT(*) FROM contact) AS contacts,
        (SELECT COUNT(*) FROM feedback) AS companyFeedback,
        (SELECT COUNT(*) FROM feedback WHERE uid IN (SELECT uid FROM user WHERE utype = 'Agent')) AS agentFeedback,
        (SELECT COUNT(*) FROM property_leads) AS leads,
        (SELECT COUNT(*) FROM about) AS aboutEntries,
        (SELECT COUNT(*) FROM newmember) AS teamMembers,
        (SELECT COUNT(*) FROM register_email) AS registeredAccounts,
        (SELECT COUNT(*) FROM delaccount WHERE type = 'delete') AS deletedAccounts,
        (SELECT COUNT(*) FROM delaccount WHERE type = 'block') AS blockedAccounts
    `;
    return numericRow(row);
  }, DASHBOARD_TTL_SECONDS);
}

module.exports = { getDashboardStats, getChartData, getSidebarCounts, DASHBOARD_TTL_SECONDS };
