const {
  Router
} = require('express');

const {
  getItineraryDataForPdf
} = require('../controllers/packageRequests.controller.js');

const {
  requirePdfToken
} = require('../middleware/auth.js');

// Deliberately a separate router/mount from packageRequests.routes.js: that
// router's requireAuth expects a real login session's Bearer token, which
// the print page (agent/pages/ItineraryPrint.jsx) doesn't use — it
// authenticates with the short-lived pdfToken instead (requirePdfToken),
// scoped to exactly the one itinerary it's rendering. The token comes from
// GET /package-requests/:id/itinerary-print-token; the PDF is built in the
// agent's browser (frontend agent/lib/itineraryPdf.js).
const {
  publicReadLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

router.use(publicReadLimiter, requirePdfToken);
router.get('/:id/data', getItineraryDataForPdf);

module.exports = router;
