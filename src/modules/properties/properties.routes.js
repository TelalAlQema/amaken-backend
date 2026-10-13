const { Router } = require("express");
const { z } = require("zod");
const { validateBody, validateQuery, validateParams } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/auth");
const { uploadPropertyImages } = require("../../services/upload.service");
const propertyService = require("./properties.service");
const { AppError } = require("../../middleware/errorHandler");

const router = Router();

// ─── GET /api/properties (Public: filtered, paginated, visible only) ─
const listPropertiesQuery = z.object({
  page: z.coerce.number().min(1).optional().default(1),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  type: z.string().optional(),
  stype: z.string().optional(),
  status: z.string().optional(),
  plan: z.string().optional(),
  minPrice: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).optional(),
  maxPrice: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).optional(),
  bhk: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(["price_asc", "price_desc", "date_asc", "date_desc"]).optional(),
  isFeatured: z.coerce.number().optional(),
  offer: z.coerce.number().optional(),
});

router.get(
  "/",
  validateQuery(listPropertiesQuery),
  async (req, res, next) => {
    try {
      const result = await propertyService.listVisibleProperties(req.query);
      res.paginated(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/properties/state/:stateSlug ────────────────────────────
router.get(
  "/state/:stateSlug",
  async (req, res, next) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const result = await propertyService.getPropertiesByState(
        req.params.stateSlug,
        page,
        limit
      );
      res.paginated(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/properties/my (Owner's properties) ─────────────────────
router.get(
  "/my",
  authenticate,
  requireRole("user"),
  async (req, res, next) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const result = await propertyService.getMyProperties(req.user.id, page, limit);
      res.paginated(result);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/properties (Create new property) ──────────────────────
router.post(
  "/",
  authenticate,
  requireRole("user"),
  (req, res, next) => {
    uploadPropertyImages(req, res, (err) => {
      if (err) return next(new AppError(err.message || "Upload failed", 400));
      next();
    });
  },
  async (req, res, next) => {
    try {
      const files = req.files;
      const fileArray = [];
      if (Array.isArray(files)) {
        fileArray.push(...files);
      } else if (files && typeof files === "object") {
        for (const fieldFiles of Object.values(files)) {
          fileArray.push(...fieldFiles);
        }
      }

      const property = await propertyService.createProperty(
        req.user.email,
        req.body,
        fileArray.length > 0 ? fileArray : undefined
      );
      res.status(201).json({ success: true, data: property });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /api/properties/:id (Update property) ───────────────────────
const idParam = z.object({ id: z.coerce.number().min(1) });

router.put(
  "/:id",
  authenticate,
  requireRole("user"),
  validateParams(idParam),
  (req, res, next) => {
    uploadPropertyImages(req, res, (err) => {
      if (err) return next(new AppError(err.message || "Upload failed", 400));
      next();
    });
  },
  async (req, res, next) => {
    try {
      const files = req.files;
      const fileArray = [];
      if (Array.isArray(files)) {
        fileArray.push(...files);
      } else if (files && typeof files === "object") {
        for (const fieldFiles of Object.values(files)) {
          fileArray.push(...fieldFiles);
        }
      }

      const property = await propertyService.updateProperty(
        Number(req.params.id),
        req.user.id,
        req.user.email,
        req.body,
        fileArray.length > 0 ? fileArray : undefined
      );
      res.json({ success: true, data: property });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /api/properties/:id (Delete property) ────────────────────
router.delete(
  "/:id",
  authenticate,
  requireRole("user"),
  validateParams(idParam),
  async (req, res, next) => {
    try {
      const result = await propertyService.deleteProperty(
        Number(req.params.id),
        req.user.id
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/properties/:id (Property detail) ───────────────────────
router.get(
  "/:id",
  validateParams(idParam),
  async (req, res, next) => {
    try {
      const property = await propertyService.getPropertyById(Number(req.params.id));
      res.json({ success: true, data: property });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

