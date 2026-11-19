const {
  Router
} = require('express');

const departuresController = require('../controllers/departures.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const {
  validateBody,
  createBookingSchema
} = require('../validation/schemas.js');

const {
  bookingLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

router.get('/', departuresController.listDepartures);
router.get('/:id', departuresController.getDeparture);
// DepartureDetail.jsx's "Download Itinerary": token for
// DepartureItineraryPrint.jsx; the PDF itself is built in the browser.
router.get('/:id/itinerary-print-token', departuresController.getDepartureItineraryPrintToken);
router.get('/:id/enquire', bookingLimiter, departuresController.enquireNow);
router.post('/:id/bookings', bookingLimiter, validateBody(createBookingSchema), departuresController.createBooking);

module.exports = router;
