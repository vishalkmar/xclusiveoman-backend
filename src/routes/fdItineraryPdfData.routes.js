const {
  Router
} = require('express');

const {
  getDepartureDataForPdf
} = require('../controllers/departures.controller.js');

const {
  requireFdPdfToken
} = require('../middleware/auth.js');

// Same "separate router/mount, separate auth" reasoning as
// itineraryPdfData.routes.js: departures.routes.js's requireAuth expects a
// real login session's Bearer token, which the print page
// (agent/pages/DepartureItineraryPrint.jsx) doesn't use — it authenticates
// with the short-lived FD pdfToken instead (requireFdPdfToken), scoped to
// exactly the one departure it's rendering. The token comes from
// GET /departures/:id/itinerary-print-token; the PDF is built in the
// agent's browser (frontend agent/lib/itineraryPdf.js).
const {
  publicReadLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

router.use(publicReadLimiter, requireFdPdfToken);
router.get('/:id/data', getDepartureDataForPdf);

module.exports = router;
