/**
 * Re-export shim. The implementation moved to `core/http/validate.js` in M03.
 *
 * Eleven route files under `src/routes/` still import from this path. They are
 * migrated module by module through M06, and this file is deleted with the last of
 * them — nothing new should import it.
 *
 *   ./validate → src/core/http/validate.js
 */
module.exports = require("../core/http/validate");