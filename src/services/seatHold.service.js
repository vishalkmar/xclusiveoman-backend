const {
  pool
} = require('../db/pool.js');

const {
  incrementSeatsBooked
} = require('../models/fdPackages.model.js');

// Seat holds for unpaid FD bookings (0111_booking_seat_hold.sql).
//
// createFdBooking takes the booking's seats up front (or refuses the booking
// outright if they aren't free — there is no waitlist). While the booking has
// had no money at all (status 'pending_payment', deposit_paid 0) those seats
// are only *held*. The hold ends one of two ways:
//   - the payment completes -> the booking becomes balance_due/fully_paid
//     (paymentConfirmation.service.js) and keeps its seats, or
//   - it doesn't: Cashfree reports it failed / declined / dropped / expired,
//     the agent cancels, or it is still unpaid SEAT_HOLD_MINUTES after the
//     booking/"Pay" click (jobs/seatHoldRelease.job.js) -> the payment is
//     closed (payments.controller.js#closeUnpaidAttempt) and
//     releaseUnpaidBooking gives the seats back and cancels the booking.
// So nothing is left sitting in "pending": an expired booking is cancelled
// and the agent books again.
//
// Every change locks the booking row (SELECT ... FOR UPDATE) so a release
// and a confirmation can never interleave and double-count seats.

const SEAT_HOLD_MINUTES = 15;

module.exports.SEAT_HOLD_MINUTES = SEAT_HOLD_MINUTES;

class SeatsUnavailableError extends Error {
  constructor() {
    super('Not enough seats are left on this departure. Please reduce the number of travellers or choose another date.');
    this.status = 409;
    this.publicCode = 'seats_unavailable';
  }
}

module.exports.SeatsUnavailableError = SeatsUnavailableError;

class BookingExpiredError extends Error {
  constructor() {
    super('This booking has expired because payment was not completed, and its seats were released. Please book again.');
    this.status = 409;
    this.publicCode = 'booking_expired';
  }
}

module.exports.BookingExpiredError = BookingExpiredError;

// Hold condition: an FD booking with no money received yet.
function isUnpaidFdBooking(booking) {
  return (
    booking &&
    booking.fd_departure_date_id &&
    booking.status === 'pending_payment' &&
    Number(booking.deposit_paid) <= 0
  );
}

async function lockBooking(client, bookingId) {
  const { rows } = await client.query('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
  return rows[0] || null;
}

module.exports.lockBooking = lockBooking;

// Inside the caller's transaction, with the booking row already locked:
// takes the booking's seats back if they were released. Only reached for a
// payment that lands after its booking expired — rare, since every release
// closes the Cashfree order first. The money is already taken by then, so
// the seats are taken even past capacity (and logged) rather than leaving a
// paid booking with no seats; admins can see and resolve the oversell.
async function reacquireSeats(client, booking) {
  if (Number(booking.seats_held)) return;
  const taken = await incrementSeatsBooked(client, booking.fd_departure_date_id, booking.pax);
  if (!taken) {
    await client.query('UPDATE fd_departure_dates SET seats_booked = seats_booked + ? WHERE id = ?', [
      booking.pax,
      booking.fd_departure_date_id,
    ]);
    console.error(
      `[seatHold] Booking ${booking.id} paid after its seats were released and resold — departure ${booking.fd_departure_date_id} is now over capacity by up to ${booking.pax}`
    );
  }
  await client.query('UPDATE bookings SET seats_held = 1 WHERE id = ?', [booking.id]);
}

module.exports.reacquireSeats = reacquireSeats;

// Called before a payment starts. `expires` true -> the hold lapses
// SEAT_HOLD_MINUTES from now (Cashfree checkout); false -> no time limit
// (NEFT slip awaiting admin verification). Throws BookingExpiredError for a
// booking whose hold already ended — it can't be paid any more.
async function holdSeatsForPayment(bookingId, { expires }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = await lockBooking(client, bookingId);
    if (booking?.status === 'cancelled' && Number(booking.deposit_paid) <= 0) {
      await client.query('ROLLBACK');
      throw new BookingExpiredError();
    }
    if (isUnpaidFdBooking(booking) && Number(booking.seats_held)) {
      await client.query(
        expires
          ? 'UPDATE bookings SET seat_hold_expires_at = now() + INTERVAL ? MINUTE WHERE id = ?'
          : 'UPDATE bookings SET seat_hold_expires_at = NULL WHERE id = ?',
        expires ? [SEAT_HOLD_MINUTES, bookingId] : [bookingId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports.holdSeatsForPayment = holdSeatsForPayment;

// Ends an unpaid FD booking's hold: gives its seats back to the departure
// and cancels the booking. Callers close the payment attempt first
// (payments.controller.js#closeUnpaidAttempt). Safe to call for any
// booking, any number of times: does nothing unless the booking is unpaid,
// still holds seats, and has no NEFT slip awaiting verification. Returns
// true when the booking was actually released.
async function releaseUnpaidBooking(bookingId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const booking = await lockBooking(client, bookingId);
    if (!isUnpaidFdBooking(booking) || !Number(booking.seats_held)) {
      await client.query('COMMIT');
      return false;
    }
    const { rows: neft } = await client.query(
      `SELECT 1 FROM payments WHERE booking_id = ? AND status = 'pending_verification' LIMIT 1`,
      [bookingId]
    );
    if (neft.length) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      'UPDATE fd_departure_dates SET seats_booked = GREATEST(seats_booked - ?, 0) WHERE id = ?',
      [booking.pax, booking.fd_departure_date_id]
    );
    await client.query(
      `UPDATE bookings SET seats_held = 0, seat_hold_expires_at = NULL, status = 'cancelled', updated_at = now() WHERE id = ?`,
      [bookingId]
    );
    await client.query('COMMIT');
    console.log(`[seatHold] Released ${booking.pax} seat(s) and cancelled unpaid booking ${bookingId}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports.releaseUnpaidBooking = releaseUnpaidBooking;

// Unpaid FD bookings whose hold has lapsed.
async function listExpiredSeatHolds() {
  const { rows } = await pool.query(
    `SELECT id FROM bookings
     WHERE seats_held = 1 AND status = 'pending_payment' AND deposit_paid <= 0
       AND seat_hold_expires_at IS NOT NULL AND seat_hold_expires_at < now()`
  );
  return rows.map((r) => r.id);
}

module.exports.listExpiredSeatHolds = listExpiredSeatHolds;
