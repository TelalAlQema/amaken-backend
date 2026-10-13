const { Router } = require("express");
const { z } = require("zod");
const { validateBody, validateParams } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/auth");
const feedbackService = require("./feedback.service");
const { toApiFeedback, toApiFeedbackPage } = require("./feedback.mapper");

const router = Router();
const idParam = z.object({ id: z.coerce.number().int().min(1) });
const createSchema = z.object({
  receiverEmail: z.string().email(),
  description: z.string().min(1).max(65000),
  rating: z.number().min(0).max(5).optional(),
});
const updateSchema = z.object({
  description: z.string().min(1).max(65000).optional(),
  rating: z.number().min(0).max(5).optional(),
});

router.post("/", authenticate, requireRole("user"), validateBody(createSchema), async (req, res, next) => {
  try {
    const row = await feedbackService.createFeedback(req.user.email, req.body.receiverEmail, req.body);
    res.status(201).json({ success: true, data: toApiFeedback(row) });
  } catch (error) { next(error); }
});
router.get("/my", authenticate, async (req, res, next) => {
  try { res.paginated(toApiFeedbackPage(await feedbackService.getMyFeedback(req.user.id, Number(req.query.page) || 1, Number(req.query.limit) || 50))); }
  catch (error) { next(error); }
});
router.get("/about-me", authenticate, async (req, res, next) => {
  try { res.paginated(toApiFeedbackPage(await feedbackService.getFeedbackAboutMe(req.user.email, Number(req.query.page) || 1, Number(req.query.limit) || 50))); }
  catch (error) { next(error); }
});

// Kept public by the M00 regression contract.
router.get("/:id", validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: toApiFeedback(await feedbackService.getFeedbackById(Number(req.params.id))) }); }
  catch (error) { next(error); }
});
router.put("/:id", authenticate, requireRole("user"), validateParams(idParam), validateBody(updateSchema), async (req, res, next) => {
  try { res.json({ success: true, data: toApiFeedback(await feedbackService.updateFeedback(Number(req.params.id), req.user.id, req.body)) }); }
  catch (error) { next(error); }
});
router.delete("/:id", authenticate, validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: await feedbackService.deleteFeedback(Number(req.params.id), req.user.id) }); }
  catch (error) { next(error); }
});

module.exports = router;
