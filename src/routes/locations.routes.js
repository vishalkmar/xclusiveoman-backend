const {
  Router
} = require('express');

const locationsController = require('../controllers/locations.controller.js');

const {
  requireAuth,
  requireRole,
  requireFeature,
  STAFF_ROLES
} = require('../middleware/auth.js');

const {
  validateBody,
  departureLocationSchema
} = require('../validation/schemas.js');

const router = Router();

router.get('/', requireAuth, locationsController.list);
// Staff-only, unlike the GET above — an agent can read the picklist while
// building a booking but shouldn't be the one adding new master-list
// entries. Kept on this same top-level /departure-locations router rather
// than moved under /admin/* to sidestep the ordering issues those bare
// /admin routers' own blanket requireRole gates call out in routes/index.js.
router.post('/', requireAuth, requireRole(...STAFF_ROLES), requireFeature('catalog'), validateBody(departureLocationSchema), locationsController.create);
router.delete('/:id', requireAuth, requireRole(...STAFF_ROLES), requireFeature('catalog'), locationsController.remove);

module.exports = router;
