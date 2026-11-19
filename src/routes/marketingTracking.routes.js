const {
  Router
} = require('express');

const trackingController = require('../controllers/marketingTracking.controller.js');

// Marketing Center Task 11 — Open & Click Tracking. Deliberately public: no
// requireAuth/requireRole here, unlike every route in marketing.routes.js
// (still gated to sales_marketing/super_admin, untouched by this task) —
// the requester is an external agency contact's mail client, which can
// never hold an admin session (requirement 16). This is the one documented
// exception to "Marketing APIs stay protected", not a general loosening.
const {
  publicReadLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

router.get('/open/:token', publicReadLimiter, trackingController.trackOpen);
router.get('/click/:token', publicReadLimiter, trackingController.trackClick);

module.exports = router;
