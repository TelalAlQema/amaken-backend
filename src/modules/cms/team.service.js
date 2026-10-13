const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../middleware/errorHandler");
const { invalidateDashboard } = require("../../platform/cache/dashboard");
const {
  processAndSaveImage,
  deleteFileIfExists,
  getPropertyUploadDir,
  getFilePath,
} = require("../../services/upload.service");

// ─── Public: Get Team Members ───────────────────────────────────────

async function getTeamMembers() {
  return prisma.teamMember.findMany({ orderBy: { id: "desc" } });
}

// ─── Admin: Create Team Member ──────────────────────────────────────

async function createTeamMember(data, file) {
  const existing = await prisma.teamMember.findFirst({ where: { email: data.email } });
  if (existing) {
    throw new AppError("A team member with this email already exists", 409, "EMAIL_EXISTS");
  }

  let image = "";
  if (file) {
    const propDir = getPropertyUploadDir();
    image = await processAndSaveImage(file, propDir, "team", 500, 500);
  }

  const member = await prisma.teamMember.create({
    data: {
      fname: data.fname.substring(0, 255),
      lname: data.lname.substring(0, 255),
      email: data.email.substring(0, 255),
      wnumber: (data.wnumber || "").substring(0, 100),
      pnumber: (data.pnumber || "").substring(0, 100),
      about: data.about.substring(0, 65000),
      type: data.type,
      fb: data.fb || null,
      ig: data.ig || null,
      linkdin: data.linkdin || null,
      tiktok: data.tiktok || null,
      twitter: data.twitter || null,
      image,
      position: data.position.substring(0, 255),
    },
  });
  await invalidateDashboard();
  return member;
}

// ─── Admin: Update Team Member ──────────────────────────────────────

async function updateTeamMember(id, data, file) {
  const member = await prisma.teamMember.findFirst({ where: { id } });
  if (!member) throw new AppError("Team member not found", 404, "TEAM_NOT_FOUND");

  const updateData = {};
  const stringFields = ["fname", "lname", "email", "wnumber", "pnumber", "about", "type", "fb", "ig", "linkdin", "tiktok", "twitter", "position"];

  for (const field of stringFields) {
    if (data[field] !== undefined) {
      updateData[field] = field === "about" ? String(data[field]).substring(0, 65000) : String(data[field]).substring(0, 255);
    }
  }

  if (file) {
    const propDir = getPropertyUploadDir();
    if (member.image) {
      deleteFileIfExists(getFilePath(propDir, member.image));
    }
    updateData.image = await processAndSaveImage(file, propDir, "team", 500, 500);
  }

  const updated = await prisma.teamMember.update({ where: { id }, data: updateData });
  await invalidateDashboard();
  return updated;
}

// ─── Admin: Delete Team Member ──────────────────────────────────────

async function deleteTeamMember(id) {
  const member = await prisma.teamMember.findFirst({ where: { id } });
  if (!member) throw new AppError("Team member not found", 404, "TEAM_NOT_FOUND");

  if (member.image) {
    deleteFileIfExists(getFilePath(getPropertyUploadDir(), member.image));
  }

  await prisma.teamMember.delete({ where: { id } });
  await invalidateDashboard();
  return { message: "Team member deleted" };
}

module.exports = { getTeamMembers, createTeamMember, updateTeamMember, deleteTeamMember };

