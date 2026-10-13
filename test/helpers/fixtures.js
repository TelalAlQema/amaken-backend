/**
 * Seed fixtures.
 *
 * One bcrypt hash is computed at module load and shared by every seeded
 * account, so the suite pays the cost-12 hash exactly once.
 */
const bcrypt = require("bcryptjs");
const { prisma } = require("./app");

const PASSWORD = "Test@12345";
const PIN = "9182";

const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 12);
const PIN_HASH = bcrypt.hashSync(PIN, 12);

const TODAY = "2026-01-15";

async function createUser(overrides = {}) {
  return prisma.user.create({
    data: {
      uname: "Test",
      lname: "User",
      uemail: "test.user@example.com",
      uphone: "+971500000001",
      upass: PASSWORD_HASH,
      utype: "User",
      date: TODAY,
      ...overrides,
    },
  });
}

async function createAdmin(overrides = {}) {
  return prisma.admin.create({
    data: {
      aname: "Test",
      alname: "Admin",
      aemail: "test.admin@example.com",
      aphone: "+971500000002",
      apass: PASSWORD_HASH,
      atype: "Admin",
      joinadate: TODAY,
      ...overrides,
    },
  });
}

async function createPin(overrides = {}) {
  return prisma.pin.create({ data: { upin: PIN_HASH, ...overrides } });
}

/**
 * Defaults to a property that passes the public visibility predicate
 * (property.service.js:10-15): deactivate 1, adminapproval 1, blocked_user 1,
 * adminblock 0. The schema default for adminapproval is 0, so a fixture that
 * relied on it would be invisible to every public listing test.
 *
 * `email` is resolved from the owner's uemail, matching what createProperty
 * writes (property.service.js:46, where the `email` argument is the owner's
 * uemail). blockSelf scopes its property update by `{ uid, email: uemail }`
 * (user.service.js:304), so a fixture with a mismatched email would leave the
 * properties untouched.
 */
async function createProperty(overrides = {}) {
  const uid = overrides.uid ?? 1;
  const owner = await prisma.user.findFirst({ where: { uid }, select: { uemail: true } });

  return prisma.property.create({
    data: {
      email: owner?.uemail ?? "test.user@example.com",
      date: TODAY,
      title: "Test Property",
      type: "Apartment",
      bhk: "2",
      stype: "sale",
      city: "Dubai",
      state: "Dubai",
      location: "Downtown Dubai",
      price: "1500000",
      adminapproval: 1,
      ...overrides,
      uid,
    },
  });
}

async function createLead(overrides = {}) {
  return prisma.propertyLead.create({
    data: {
      pid: 1,
      title: "Test Property",
      saleid: "SALE-1",
      name: "Lead Name",
      email: "lead@example.com",
      nationality: "Indian",
      phone: "+971500000003",
      ip: "127.0.0.1",
      device: "test-device",
      ...overrides,
    },
  });
}

async function createFeedback(overrides = {}) {
  return prisma.feedback.create({
    data: {
      fdescription: "Great service",
      send_email: "test.user@example.com",
      receive_email: "test.admin@example.com",
      rating: 5,
      uid: overrides.uid ?? 1,
      ...overrides,
    },
  });
}

async function createContact(overrides = {}) {
  return prisma.contact.create({
    data: {
      name: "Contact Name",
      email: "contact@example.com",
      phone: "+971500000004",
      subject: "Enquiry",
      message: "Please get in touch.",
      ...overrides,
    },
  });
}

async function createAbout(overrides = {}) {
  return prisma.about.create({
    data: { title: "About Us", content: "We are Amaken.", ...overrides },
  });
}

async function createTeamMember(overrides = {}) {
  return prisma.teamMember.create({
    data: {
      fname: "Team",
      lname: "Member",
      email: "team@example.com",
      wnumber: "+971500000005",
      pnumber: "+971500000006",
      about: "A team member.",
      type: "Agent",
      image: "member.webp",
      position: "Senior Agent",
      ...overrides,
    },
  });
}

async function createState(overrides = {}) {
  return prisma.state.create({ data: { sname: "Dubai", ...overrides } });
}

async function createCity(overrides = {}) {
  return prisma.city.create({ data: { cname: "Downtown", sid: 1, ...overrides } });
}

async function createRegisterEmail(overrides = {}) {
  return prisma.registerEmail.create({
    data: {
      email: "registered@example.com",
      name: "Registered User",
      type: "registered",
      utype: "User",
      ...overrides,
    },
  });
}

async function createDelAccount(overrides = {}) {
  return prisma.delAccount.create({
    data: { email: "deleted@example.com", type: "deleted", utype: "User", ...overrides },
  });
}

/**
 * The common case: one user, one admin, one PIN, one property, and the
 * reference rows most list endpoints need.
 */
async function seedStandard() {
  const user = await createUser();
  const admin = await createAdmin();
  const pin = await createPin();
  const property = await createProperty({ uid: user.uid });
  return { user, admin, pin, property };
}

module.exports = {
  PASSWORD,
  PIN,
  PASSWORD_HASH,
  PIN_HASH,
  TODAY,
  prisma,
  createUser,
  createAdmin,
  createPin,
  createProperty,
  createLead,
  createFeedback,
  createContact,
  createAbout,
  createTeamMember,
  createState,
  createCity,
  createRegisterEmail,
  createDelAccount,
  seedStandard,
};
