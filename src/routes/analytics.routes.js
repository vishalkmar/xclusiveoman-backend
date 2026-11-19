const {
  Router
} = require('express');

const analyticsController = require('../controllers/analytics.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const router = Router();

// Admin Analytics & Reporting (Task 19 — Screen 18, ANL-1). Its own RBAC
// gate, independent of every other admin feature — ops_admin/super_admin
// per the doc's own §12.11 route annotation, same convention every prior
// admin feature in this codebase established.
router.use(requireAuth, requireRole('ops_admin', 'super_admin'));

router.get('/summary', analyticsController.summary);
router.get('/revenue-by-month', analyticsController.revenueByMonth);
router.get('/top-agencies', analyticsController.topAgencies);
router.get('/revenue-by-package', analyticsController.revenueByPackage);
router.get('/payments-overview', analyticsController.paymentsOverview);
router.get('/revenue-analysis', analyticsController.revenueAnalysis);
// Revenue page → Visa tab: visa fees collected (visa_payments).
router.get('/visa-revenue', analyticsController.visaRevenue);

module.exports = router;
