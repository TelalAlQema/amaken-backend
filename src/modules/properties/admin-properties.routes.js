const { Router } = require("express");
const { z } = require("zod");
const { validateQuery, validateParams } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/auth");
const propertyService = require("./properties.service");

const router = Router();

// All admin routes require admin auth
router.use(authenticate, requireRole("admin"));

// ─── GET /api/admin/properties ───────────────────────────────────────
const adminListQuery = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  status: z.string().optional(),
  stype: z.string().optional(),
  type: z.string().optional(),
  search: z.string().optional(),
});

router.get(
  "/properties",
  validateQuery(adminListQuery),
  async (req, res, next) => {
    try {
      const result = await propertyService.adminListProperties(
        Number(req.query.page),
        Number(req.query.limit),
        {
          status: req.query.status,
          stype: req.query.stype,
          type: req.query.type,
          search: req.query.search,
        }
      );
      res.paginated(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/admin/properties/approval (pending approval) ───────────
router.get(
  "/properties/approval",
  validateQuery(adminListQuery),
  async (req, res, next) => {
    try {
      const result = await propertyService.adminListPendingApproval(
        Number(req.query.page),
        Number(req.query.limit)
      );
      res.paginated(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/approve ───────────────────────────
const propertyIdParam = z.object({ id: z.coerce.number().min(1) });

router.put(
  "/properties/:id/approve",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.approveProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property approved" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/disapprove ────────────────────────
router.put(
  "/properties/:id/disapprove",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.disapproveProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property disapproved" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/hide (adminapproval=0) ───────────
router.put(
  "/properties/:id/hide",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.hideProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property hidden" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/display (adminapproval=1) ─────────
router.put(
  "/properties/:id/display",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.displayProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property displayed" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/freeze ────────────────────────────
router.put(
  "/properties/:id/freeze",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.freezeProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property frozen" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/admin/properties/:id/release ───────────────────────────
router.put(
  "/properties/:id/release",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.releaseProperty(Number(req.params.id));
      res.json({ success: true, data: result, message: "Property released" });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/admin/properties/:id ────────────────────────────────
router.delete(
  "/properties/:id",
  validateParams(propertyIdParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.deleteProperty(Number(req.params.id));
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

