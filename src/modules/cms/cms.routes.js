const { Router } = require("express");
const { z } = require("zod");
const { validateBody, validateParams } = require("../../middleware/validate");
const { uploadAboutImage, uploadTeamImage } = require("../../services/upload.service");
const aboutService = require("./about.service");
const teamService = require("./team.service");
const { AppError } = require("../../middleware/errorHandler");

const publicRoutes = Router();
const adminRoutes = Router();
const idParam = z.object({ id: z.coerce.number().int().min(1) });
const aboutSchema = z.object({ title: z.string().max(255).optional(), content: z.string().min(1).max(65000) });
const teamSchema = z.object({
  fname: z.string().min(1).max(255),
  lname: z.string().min(1).max(255),
  email: z.string().email().max(255),
  wnumber: z.string().max(100).optional(),
  pnumber: z.string().max(100).optional(),
  about: z.string().min(1).max(65000),
  type: z.enum(["leader", "Team"]),
  fb: z.string().max(500).optional(),
  ig: z.string().max(500).optional(),
  linkdin: z.string().max(500).optional(),
  tiktok: z.string().max(500).optional(),
  twitter: z.string().max(500).optional(),
  position: z.string().min(1).max(255),
});

function upload(middleware) {
  return (req, res, next) => middleware(req, res, (error) => {
    if (error) return next(new AppError(error.message || "Upload failed", 400));
    next();
  });
}

publicRoutes.get("/about", async (_req, res, next) => {
  try { res.json({ success: true, data: await aboutService.getAboutContent() }); }
  catch (error) { next(error); }
});
publicRoutes.get("/team", async (_req, res, next) => {
  try { res.json({ success: true, data: await teamService.getTeamMembers() }); }
  catch (error) { next(error); }
});

adminRoutes.post("/about", upload(uploadAboutImage), validateBody(aboutSchema), async (req, res, next) => {
  try {
    const data = await aboutService.createAbout(req.body, req.file);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});
adminRoutes.put("/about/:id", validateParams(idParam), upload(uploadAboutImage), validateBody(aboutSchema.partial()), async (req, res, next) => {
  try {
    const data = await aboutService.updateAbout(Number(req.params.id), req.body, req.file);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
adminRoutes.delete("/about/:id", validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: await aboutService.deleteAbout(Number(req.params.id)) }); }
  catch (error) { next(error); }
});

adminRoutes.post("/team", upload(uploadTeamImage), validateBody(teamSchema), async (req, res, next) => {
  try {
    const data = await teamService.createTeamMember(req.body, req.file);
    res.status(201).json({ success: true, data });
  } catch (error) { next(error); }
});
adminRoutes.put("/team/:id", validateParams(idParam), upload(uploadTeamImage), validateBody(teamSchema.partial()), async (req, res, next) => {
  try {
    const data = await teamService.updateTeamMember(Number(req.params.id), req.body, req.file);
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
adminRoutes.delete("/team/:id", validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: await teamService.deleteTeamMember(Number(req.params.id)) }); }
  catch (error) { next(error); }
});

module.exports = { publicRoutes, adminRoutes };
