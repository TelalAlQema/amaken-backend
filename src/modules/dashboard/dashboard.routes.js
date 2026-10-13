const { Router } = require("express");
const { z } = require("zod");
const { validateQuery } = require("../../middleware/validate");
const dashboardService = require("./dashboard.service");

const router = Router();
const chartQuery = z.object({ status: z.enum(["available", "sold_out"]).optional() });

router.get("/stats", async (_req, res, next) => {
  try { res.json({ success: true, data: await dashboardService.getDashboardStats() }); }
  catch (error) { next(error); }
});
router.get("/charts", validateQuery(chartQuery), async (req, res, next) => {
  try { res.json({ success: true, data: await dashboardService.getChartData(req.user.email, req.query.status) }); }
  catch (error) { next(error); }
});
router.get("/sidebar-counts", async (_req, res, next) => {
  try { res.json({ success: true, data: await dashboardService.getSidebarCounts() }); }
  catch (error) { next(error); }
});

module.exports = router;
