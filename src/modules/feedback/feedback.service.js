const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../middleware/errorHandler");
const { invalidateDashboard } = require("../../platform/cache/dashboard");

// ─── Create Feedback ────────────────────────────────────────────────

async function createFeedback(senderEmail, receiverEmail, data) {
  const [sender, receiverRows] = await Promise.all([
    prisma.user.findFirst({ where: { uemail: senderEmail } }),
    prisma.$queryRaw`
      SELECT 'admin' AS kind, aid AS id FROM Admin WHERE aemail = ${receiverEmail}
      UNION ALL
      SELECT 'user' AS kind, uid AS id FROM User WHERE uemail = ${receiverEmail}
      LIMIT 1
    `,
  ]);
  if (!sender) throw new AppError("User not found", 404, "USER_NOT_FOUND");

  const receiver = receiverRows[0];
  if (!receiver) {
    throw new AppError("Receiver not found", 404, "RECEIVER_NOT_FOUND");
  }

  const feedback = await prisma.feedback.create({
    data: {
      uid: sender.uid,
      agid: receiver.kind === "admin" ? Number(receiver.id) : null,
      fdescription: data.description.substring(0, 65000),
      rating: data.rating || 0,
      send_email: senderEmail,
      receive_email: receiverEmail,
      fblock: 1,
      fdeactivate: 1,
      fadminblock: 0,
    },
  });
  await invalidateDashboard();
  return feedback;
}

// ─── Get My Feedback (sent by me) ──────────────────────────────────

async function getMyFeedback(userId, page = 1, limit = 50) {
  const where = { uid: userId };

  const [feedbacks, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        admin: { select: { aid: true, aname: true, alname: true, aemail: true, aimage: true } },
        user: { select: { uid: true, uname: true, lname: true, uemail: true, uimage: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  return {
    items: feedbacks,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── Get Feedback About Me ──────────────────────────────────────────

async function getFeedbackAboutMe(email, page = 1, limit = 50) {
  const where = { receive_email: email };

  const [feedbacks, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        admin: { select: { aid: true, aname: true, alname: true, aemail: true, aimage: true } },
        user: { select: { uid: true, uname: true, lname: true, uemail: true, uimage: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  return {
    items: feedbacks,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── Get Single Feedback ────────────────────────────────────────────

async function getFeedbackById(fid) {
  const feedback = await prisma.feedback.findFirst({
    where: { fid },
    include: {
      admin: { select: { aid: true, aname: true, alname: true, aemail: true, aimage: true } },
      user: { select: { uid: true, uname: true, lname: true, uemail: true, uimage: true } },
    },
  });

  if (!feedback) throw new AppError("Feedback not found", 404, "FEEDBACK_NOT_FOUND");
  return feedback;
}

// ─── Update Feedback ────────────────────────────────────────────────

async function updateFeedback(fid, userId, data) {
  const feedback = await prisma.feedback.findFirst({ where: { fid } });
  if (!feedback) throw new AppError("Feedback not found", 404, "FEEDBACK_NOT_FOUND");
  if (feedback.uid !== userId) throw new AppError("Not authorized", 403, "FORBIDDEN");

  const updateData = {};
  if (data.description !== undefined) updateData.fdescription = data.description.substring(0, 65000);
  if (data.rating !== undefined) updateData.rating = data.rating;

  return prisma.feedback.update({
    where: { fid },
    data: updateData,
  });
}

// ─── Delete Feedback ────────────────────────────────────────────────

async function deleteFeedback(fid, userId) {
  const feedback = await prisma.feedback.findFirst({ where: { fid } });
  if (!feedback) throw new AppError("Feedback not found", 404, "FEEDBACK_NOT_FOUND");
  if (userId && feedback.uid !== userId) throw new AppError("Not authorized", 403, "FORBIDDEN");

  await prisma.feedback.delete({ where: { fid } });
  await invalidateDashboard();
  return { message: "Feedback deleted" };
}

// ─── Admin: Company Feedback (by receive_email) ─────────────────────

async function getCompanyFeedback(email, page = 1, limit = 50) {
  const where = { receive_email: email };

  const [feedbacks, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        admin: { select: { aid: true, aname: true, alname: true, aemail: true } },
        user: { select: { uid: true, uname: true, lname: true, uemail: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  return {
    items: feedbacks,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── Admin: Agent Feedback (feedbacks where sender is agent) ────────

async function getAgentFeedback(page = 1, limit = 50) {
  const where = {
    user: { utype: "Agent" },
  };

  const [feedbacks, total] = await Promise.all([
    prisma.feedback.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        admin: { select: { aid: true, aname: true, alname: true, aemail: true } },
        user: { select: { uid: true, uname: true, lname: true, uemail: true } },
      },
    }),
    prisma.feedback.count({ where }),
  ]);

  return {
    items: feedbacks,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

module.exports = {
  createFeedback,
  getMyFeedback,
  getFeedbackAboutMe,
  getFeedbackById,
  updateFeedback,
  deleteFeedback,
  getCompanyFeedback,
  getAgentFeedback,
};

