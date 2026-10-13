// Property types
const PROPERTY_TYPES = [
  "Villa",
  "Apartment",
  "Town House",
  "Pent House",
  "Compound",
  "Duplex",
  "Full Floor",
  "Half Floor",
  "Building",
  "Bulk Sale Unit",
  "Bungalow",
  "Office",
  "Shop",
  "Mall",
  "Hotel",
  "Hotel Apartment or Flat",
  "Restaurant",
  "Warehouse",
  "Bedspace",
  "Partition",
  "Others",
];

const SELLING_TYPES = ["rent", "sale", "lease"];

const BHK_OPTIONS = [
  "Open",
  "1 BHK",
  "2 BHK",
  "3 BHK",
  "4 BHK",
  "5 BHK",
  "1,2 BHK",
  "2,3 BHK",
  "2,3,4 BHK",
  "2,3,4,5 BHK",
  "2,3,4,5,6 BHK",
];

const PROPERTY_STATUS = ["available", "sold out"];

const PLAN_TYPES = ["Off Plan", "Secondary", "Ready to Move"];

const DECORATION_TYPES = [
  "Furnished",
  "Unfurnished",
  "Partially Furnished",
];

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "PKR", "INR"];

const USER_TYPES = ["User", "Agent", "Builder"];

const GENDERS = ["Male", "Female", "Other"];

// Pagination defaults
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

// File upload limits
const MAX_FILE_SIZE = 6 * 1024 * 1024; // 6MB
const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

// Property visibility conditions (all must be true for public visibility)
const PROPERTY_VISIBILITY = {
  DEACTIVATE: 1,
  ADMIN_APPROVAL: 1,
  BLOCKED_USER: 1,
  ADMIN_BLOCK: 0,
};

// Contact info
const CONTACT = {
  PHONE: "+971 55 261 5993",
  EMAIL: "info@amaken-realestate.com",
  WHATSAPP: "+971552615993",
  ADDRESS: "Dubai, United Arab Emirates",
};

// Site info
const SITE = {
  NAME: "Amaken Real Estate",
  URL: "https://amaken-realestate.com",
  TAGLINE: "Your Trusted Real Estate Partner in Dubai",
};

// Social links defaults
const SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "twitter",
  "linkedin",
  "tiktok",
  "website",
];

module.exports = {
  PROPERTY_TYPES,
  SELLING_TYPES,
  BHK_OPTIONS,
  PROPERTY_STATUS,
  PLAN_TYPES,
  DECORATION_TYPES,
  CURRENCIES,
  USER_TYPES,
  GENDERS,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_FILE_SIZE,
  ALLOWED_IMAGE_TYPES,
  PROPERTY_VISIBILITY,
  CONTACT,
  SITE,
  SOCIAL_PLATFORMS,
};
