const { Router } = require("express");
const { z } = require("zod");
const { validateBody, validateParams } = require("../../middleware/validate");
const locationService = require("./locations.service");

const publicRoutes = Router();
const adminRoutes = Router();
const idParam = z.object({ id: z.coerce.number().int().min(1) });
const stateSchema = z.object({ sname: z.string().min(1).max(255) });
const citySchema = z.object({ cname: z.string().min(1).max(255), sid: z.coerce.number().int().min(1) });

publicRoutes.get("/cities", async (_req, res, next) => {
  try { res.json({ success: true, data: await locationService.getCities() }); }
  catch (error) { next(error); }
});
publicRoutes.get("/states", async (_req, res, next) => {
  try { res.json({ success: true, data: await locationService.getStates() }); }
  catch (error) { next(error); }
});

adminRoutes.post("/states", validateBody(stateSchema), async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await locationService.createState(req.body) }); }
  catch (error) { next(error); }
});
adminRoutes.put("/states/:id", validateParams(idParam), validateBody(stateSchema), async (req, res, next) => {
  try { res.json({ success: true, data: await locationService.updateState(Number(req.params.id), req.body) }); }
  catch (error) { next(error); }
});
adminRoutes.delete("/states/:id", validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: await locationService.deleteState(Number(req.params.id)) }); }
  catch (error) { next(error); }
});
adminRoutes.post("/cities", validateBody(citySchema), async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await locationService.createCity(req.body) }); }
  catch (error) { next(error); }
});
adminRoutes.put("/cities/:id", validateParams(idParam), validateBody(citySchema), async (req, res, next) => {
  try { res.json({ success: true, data: await locationService.updateCity(Number(req.params.id), req.body) }); }
  catch (error) { next(error); }
});
adminRoutes.delete("/cities/:id", validateParams(idParam), async (req, res, next) => {
  try { res.json({ success: true, data: await locationService.deleteCity(Number(req.params.id)) }); }
  catch (error) { next(error); }
});

module.exports = { publicRoutes, adminRoutes };
