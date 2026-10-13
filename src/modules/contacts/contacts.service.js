const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../middleware/errorHandler");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

// ─── Public: Submit Contact Form ────────────────────────────────────

async function submitContact(data) {
  const contact = await prisma.contact.create({
    data: {
      name: data.name.substring(0, 255),
      email: data.email.substring(0, 255),
      phone: data.phone.substring(0, 100),
      subject: data.subject.substring(0, 255),
      message: data.message.substring(0, 65000),
    },
  });
  await invalidateDashboard();
  return contact;
}

// ─── Admin: List Contact Submissions ────────────────────────────────

async function listContacts(page = 1, limit = 50) {
  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      orderBy: { id: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.contact.count(),
  ]);

  return {
    items: contacts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── Admin: Delete Contact Submission ───────────────────────────────

async function deleteContact(id) {
  const contact = await prisma.contact.findFirst({ where: { id } });
  if (!contact) throw new AppError("Contact not found", 404, "CONTACT_NOT_FOUND");

  await prisma.contact.delete({ where: { id } });
  await invalidateDashboard();
  return { message: "Contact deleted" };
}

module.exports = { submitContact, listContacts, deleteContact };

