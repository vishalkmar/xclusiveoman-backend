const cron = require('node-cron');

const {
  listExpiredSeatHolds,
  releaseUnpaidBooking
} = require('../services/seatHold.service.js');

const {
  findActiveCashfreePayment
} = require('../models/payments.model.js');

const {
  findBookingById
} = require('../models/bookings.model.js');

const {
  closeUnpaidAttempt
} = require('../controllers/payments.controller.js');

const {
  getIo
} = require('../sockets/index.js');

// Seat hold release — every 30 seconds, same node-cron as the other jobs
// here. An unpaid FD booking holds its seats for SEAT_HOLD_MINUTES
// (seatHold.service.js) from booking / the last "Pay" click; once that
// lapses with nothing paid, the hold ends: the open payment attempt (if any)
// is closed as cancelled and the booking's seats are released and the
// booking cancelled — nothing is left sitting in "pending".
//
// closeUnpaidAttempt checks the attempt with Cashfree first, so a payment
// that actually succeeded (webhook late) is confirmed instead, and one it
// can't safely close (Cashfree unreachable, payment mid-flight) is left for
// the next tick.
//
// A restart loses nothing: the hold's expiry lives on the bookings row, and
// the next tick picks up whatever has lapsed. `running` only stops two
// overlapping ticks in the same process; the release itself is idempotent
// under a row lock.
let running = false;

async function releaseExpiredSeatHolds() {
  if (running) return;
  running = true;
  try {
    const bookingIds = await listExpiredSeatHolds();
    for (const bookingId of bookingIds) {
      try {
        const booking = await findBookingById(bookingId);
        if (!booking) continue;
        const payment = await findActiveCashfreePayment(bookingId);
        if (payment) {
          await closeUnpaidAttempt(payment, booking, 'cancelled');
        } else if (await releaseUnpaidBooking(bookingId)) {
          getIo()?.to(`agency:${booking.agency_id}`).emit('booking:status_changed', { bookingId, status: 'cancelled' });
        }
      } catch (err) {
        console.error(`[seatHoldRelease] Failed for booking ${bookingId}`, err);
      }
    }
  } catch (err) {
    console.error('[seatHoldRelease] Failed to run', err);
  } finally {
    running = false;
  }
}

module.exports.releaseExpiredSeatHolds = releaseExpiredSeatHolds;

function startSeatHoldReleaseScheduler() {
  cron.schedule('*/30 * * * * *', () => {
    releaseExpiredSeatHolds().catch((err) => console.error('[seatHoldRelease] Unexpected error', err));
  });
}

module.exports.startSeatHoldReleaseScheduler = startSeatHoldReleaseScheduler;
