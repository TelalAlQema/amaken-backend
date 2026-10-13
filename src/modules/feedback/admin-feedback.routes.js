const { Router } = require("express");
const feedbackService = require("./feedback.service");
const { toApiFeedbackPage } = require("./feedback.mapper");

const router = Router();
router.get("/company", async (req, res, next) => {
  try {
    const data = await feedbackService.getCompanyFeedback(req.user.email, Number(req.query.page) || 1, Number(req.query.limit) || 50);
    res.paginated(toApiFeedbackPage(data));
  } catch (error) { next(error); }
});
router.get("/agents", async (_req, res, next) => {
  try {
    const data = await feedbackService.getAgentFeedback(Number(_req.query.page) || 1, Number(_req.query.limit) || 50);
    res.paginated(toApiFeedbackPage(data));
  } catch (error) { next(error); }
});

module.exports = router;
