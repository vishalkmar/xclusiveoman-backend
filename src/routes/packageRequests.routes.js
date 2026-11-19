const {
  Router
} = require('express');

const packageRequestsController = require('../controllers/packageRequests.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const {
  validateBody,
  createPackageRequestSchema,
  draftPackageRequestSchema,
  respondPackageRequestSchema
} = require('../validation/schemas.js');

const {
  bookingLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

// "My FIT Requests / Quotes" (items 1/2/8).
router.get('/', packageRequestsController.list);
router.post('/', bookingLimiter, validateBody(createPackageRequestSchema), packageRequestsController.create);

// Draft Quotes (item 1) — registered before '/:id' so '/draft' isn't
// swallowed by the param route.
router.post('/draft', validateBody(draftPackageRequestSchema), packageRequestsController.createDraft);

router.get('/:id', packageRequestsController.get);
// PackageBuilder.jsx's "Download PDF": token for ItineraryPrint.jsx; the PDF
// itself is built in the browser.
router.get('/:id/itinerary-print-token', packageRequestsController.getItineraryPrintToken);
router.patch('/:id', validateBody(draftPackageRequestSchema), packageRequestsController.updateDraft);
router.delete('/:id', packageRequestsController.remove);
router.post('/:id/submit', bookingLimiter, validateBody(createPackageRequestSchema), packageRequestsController.submit);

// Agent Actions on a Published quote (item 5).
router.post('/:id/respond', validateBody(respondPackageRequestSchema), packageRequestsController.respond);

module.exports = router;
