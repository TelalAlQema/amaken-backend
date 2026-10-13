const { Router } = require("express");
const { z } = require("zod");
const { authenticate, requireRole } = require("../../middleware/auth");
const { validateBody, validateQuery, validateParams } = require("../../middleware/validate");
const leadService = require("./leads.service");

const router = Router();
router.use(authenticate, requireRole("admin"));

const leadsQuery = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  from: z.string().optional(),
  to: z.string().optional(),
});
router.get("/leads", validateQuery(leadsQuery), async (req, res, next) => {
  try {
    const data = await leadService.listLeads(Number(req.query.page), Number(req.query.limit), {
      from: req.query.from,
      to: req.query.to,
    });
    res.paginated(data);
  } catch (error) {
    next(error);
  }
});

const exportQuery = z.object({
  mode: z.enum(["all", "page", "range"]).optional().default("all"),
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  from: z.string().optional(),
  to: z.string().optional(),
});
router.get("/leads/export", validateQuery(exportQuery), async (req, res, next) => {
  try {
    const tsv = await leadService.exportLeads(req.query.mode, Number(req.query.page), Number(req.query.limit), {
      from: req.query.from,
      to: req.query.to,
    });
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=UTF-8");
    res.setHeader("Content-Disposition", "attachment; filename=property_leads.xls");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send("\xEF\xBB\xBF" + tsv);
  } catch (error) {
    next(error);
  }
});

const idParam = z.object({ id: z.coerce.number().int().min(1) });
router.delete("/leads/:id", validateParams(idParam), async (req, res, next) => {
  try {
    res.json({ success: true, data: await leadService.deleteLead(Number(req.params.id)) });
  } catch (error) {
    next(error);
  }
});
router.post("/leads/bulk-delete", validateBody(z.object({ ids: z.array(z.coerce.number()).min(1) })), async (req, res, next) => {
  try {
    res.json({ success: true, data: await leadService.bulkDeleteLeads(req.body.ids) });
  } catch (error) {
    next(error);
  }
});
router.post("/leads/delete-all", async (_req, res, next) => {
  try {
    res.json({ success: true, data: await leadService.deleteAllLeads() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
