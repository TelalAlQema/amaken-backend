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
        (SELECT COUNT(*) FROM Admin) AS adminCount,
        (SELECT COUNT(*) FROM User WHERE utype = 'User') AS userCount,
        (SELECT COUNT(*) FROM User WHERE utype = 'Agent') AS agentCount,
        (SELECT COUNT(*) FROM User WHERE utype = 'Builder') AS builderCount,
        (SELECT COUNT(*) FROM Property) AS totalProperties,
        (SELECT COUNT(*) FROM Property WHERE status = 'available') AS availableProperties,
        (SELECT COUNT(*) FROM Property WHERE status = 'sold_out') AS soldOutProperties,
        (SELECT COUNT(*) FROM Property WHERE stype = 'rent') AS forRent,
        (SELECT COUNT(*) FROM Property WHERE stype = 'sale') AS forSale,
        (SELECT COUNT(*) FROM Property WHERE adminapproval = 0) AS pendingApproval,
        (SELECT COUNT(*) FROM PropertyLead) AS totalLeads,
        (SELECT COUNT(*) FROM Contact) AS totalContacts,
        (SELECT COUNT(*) FROM Feedback) AS totalFeedback,
        (SELECT COUNT(*) FROM City) AS totalCities,
        (SELECT COUNT(*) FROM State) AS totalStates,
        (SELECT COUNT(*) FROM TeamMember) AS totalTeamMembers,
        (SELECT COUNT(*) FROM About) AS totalAboutEntries
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
      FROM Property
      WHERE (${!email} OR email = ${email || ""})
    `;
    return numericRow(row);
  }, DASHBOARD_TTL_SECONDS);
}

async function getSidebarCounts() {
  return remember("dashboard", "sidebar-counts", async () => {
    const [row] = await prisma.$queryRaw`
      SELECT
        (SELECT COUNT(*) FROM Admin) AS admins,
        (SELECT COUNT(*) FROM User WHERE utype = 'User') AS users,
        (SELECT COUNT(*) FROM User WHERE utype = 'Agent') AS agents,
        (SELECT COUNT(*) FROM User WHERE utype = 'Builder') AS builders,
        (SELECT COUNT(*) FROM Property) AS totalProperties,
        (SELECT COUNT(*) FROM Property WHERE status = 'available') AS availableProperties,
        (SELECT COUNT(*) FROM Property WHERE adminapproval = 0) AS pendingApproval,
        (SELECT COUNT(*) FROM Contact) AS contacts,
        (SELECT COUNT(*) FROM Feedback) AS companyFeedback,
        (SELECT COUNT(*) FROM Feedback WHERE uid IN (SELECT uid FROM User WHERE utype = 'Agent')) AS agentFeedback,
        (SELECT COUNT(*) FROM PropertyLead) AS leads,
        (SELECT COUNT(*) FROM About) AS aboutEntries,
        (SELECT COUNT(*) FROM TeamMember) AS teamMembers,
        (SELECT COUNT(*) FROM register_email) AS registeredAccounts,
        (SELECT COUNT(*) FROM DelAccount WHERE type = 'delete') AS deletedAccounts,
        (SELECT COUNT(*) FROM DelAccount WHERE type = 'block') AS blockedAccounts
    `;
    return numericRow(row);
  }, DASHBOARD_TTL_SECONDS);
}

module.exports = { getDashboardStats, getChartData, getSidebarCounts, DASHBOARD_TTL_SECONDS };
