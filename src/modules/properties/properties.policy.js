/** The single definition of public property visibility. */
const VISIBLE = Object.freeze({
  deactivate: 1,
  adminapproval: 1,
  blocked_user: 1,
  adminblock: 0,
});

const VisibilityPolicy = Object.freeze({
  where(extra = {}) {
    return { ...VISIBLE, ...extra };
  },
  isVisible(property) {
    return Object.entries(VISIBLE).every(([key, value]) => property?.[key] === value);
  },
});

module.exports = { VisibilityPolicy };
