const {
  Router
} = require('express');

const bookingsController = require('../controllers/bookings.controller.js');
const documentsAgentController = require('../controllers/travelerDocumentsAgent.controller.js');
const reviewsAgentController = require('../controllers/reviewsAgent.controller.js');
const agentRevenueController = require('../controllers/agentRevenue.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const {
  upload
} = require('../middleware/upload.js');

const {
  validateBody,
  submitReviewSchema,
  requestRefundSchema
} = require('../validation/schemas.js');

const router = Router();

router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

// Agent Portal Revenue page — registered ahead of the generic '/:id' below
// (same "specific prefix before the generic one" convention this codebase's
// admin route registration already uses, see routes/index.js's own
// comments) so '/revenue/summary' etc. are never captured as an :id, though
// in practice Express wouldn't shadow a 2-segment path with a 1-segment
// pattern anyway — kept explicit for readability.
router.get('/revenue/summary', agentRevenueController.summary);
router.get('/revenue/by-month', agentRevenueController.spendByMonth);
router.get('/revenue/by-package', agentRevenueController.spendByPackage);
router.get('/revenue/payments-overview', agentRevenueController.paymentsOverview);

router.get('/', bookingsController.listMyBookings);
router.get('/:id', bookingsController.getBooking);
router.post('/:id/refund-request', validateBody(requestRefundSchema), bookingsController.requestRefund);

// --- Traveler Document Upload (Task 14 — Screen 23, DOC-1/DOC-6) ---
router.get('/:id/documents', documentsAgentController.getDocuments);
router.post(
  '/:id/travelers/:travelerId/documents',
  upload.fields([
    { name: 'passportScan', maxCount: 1 },
    { name: 'passportPhoto', maxCount: 1 },
  ]),
  documentsAgentController.uploadDocuments
);
router.get('/:id/travelers/:travelerId/documents/:type/download', documentsAgentController.downloadTravelerDocument);
router.get('/:id/voucher/download', documentsAgentController.downloadVoucher);

// --- Review & Rating Popup (Task 20 — Screen 32, REV-2) ---
router.post('/:id/review', validateBody(submitReviewSchema), reviewsAgentController.submitReview);
router.post('/:id/dismiss-review-prompt', reviewsAgentController.dismissReviewPrompt);

module.exports = router;
