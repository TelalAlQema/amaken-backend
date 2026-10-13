const { Router } = require("express");
const { z } = require("zod");
const { validateBody, validateQuery } = require("../../middleware/validate");
const { AppError } = require("../../middleware/errorHandler");
const contactsService = require("./contacts.service");

const publicRoutes = Router();
const adminRoutes = Router();
const contactSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  phone: z.string().min(1).max(100),
  subject: z.string().min(1).max(255),
  message: z.string().min(1).max(65000),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

publicRoutes.post("/", validateBody(contactSchema), async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await contactsService.submitContact(req.body) }); }
  catch (error) { next(error); }
});
adminRoutes.get("/contacts", validateQuery(listQuery), async (req, res, next) => {
  try { res.paginated(await contactsService.listContacts(Number(req.query.page), Number(req.query.limit))); }
  catch (error) { next(error); }
});
adminRoutes.delete("/contacts/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new AppError("Invalid contact ID", 400);
    res.json({ success: true, data: await contactsService.deleteContact(id) });
  }
  catch (error) { next(error); }
});

module.exports = { publicRoutes, adminRoutes };
