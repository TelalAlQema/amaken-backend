const { prisma } = require("../../platform/db/prisma");
const { AppError } = require("../../middleware/errorHandler");
const { invalidateDashboard } = require("../../platform/cache/dashboard");
const {
  processAndSaveImage,
  deleteFileIfExists,
  getPropertyUploadDir,
  getFilePath,
} = require("../../services/upload.service");

// ─── Public: Get About Content ──────────────────────────────────────

async function getAboutContent() {
  return prisma.about.findMany({ orderBy: { id: "desc" } });
}

// ─── Admin: Create About ────────────────────────────────────────────

async function createAbout(data, file) {
  let image = null;

  if (file) {
    const propDir = getPropertyUploadDir();
    image = await processAndSaveImage(file, propDir, "about", 1200, 800);
  }

  const about = await prisma.about.create({
    data: {
      title: data.title || null,
      content: data.content.substring(0, 65000),
      image,
    },
  });
  await invalidateDashboard();
  return about;
}

// ─── Admin: Update About ────────────────────────────────────────────

async function updateAbout(id, data, file) {
  const about = await prisma.about.findFirst({ where: { id } });
  if (!about) throw new AppError("About content not found", 404, "ABOUT_NOT_FOUND");

  const updateData = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.content !== undefined) updateData.content = data.content.substring(0, 65000);

  if (file) {
    const propDir = getPropertyUploadDir();
    if (about.image) {
      deleteFileIfExists(getFilePath(propDir, about.image));
    }
    updateData.image = await processAndSaveImage(file, propDir, "about", 1200, 800);
  }

  const updated = await prisma.about.update({ where: { id }, data: updateData });
  await invalidateDashboard();
  return updated;
}

// ─── Admin: Delete About ────────────────────────────────────────────

async function deleteAbout(id) {
  const about = await prisma.about.findFirst({ where: { id } });
  if (!about) throw new AppError("About content not found", 404, "ABOUT_NOT_FOUND");

  if (about.image) {
    deleteFileIfExists(getFilePath(getPropertyUploadDir(), about.image));
  }

  await prisma.about.delete({ where: { id } });
  await invalidateDashboard();
  return { message: "About content deleted" };
}

module.exports = { getAboutContent, createAbout, updateAbout, deleteAbout };

