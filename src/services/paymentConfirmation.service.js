const {
  pool
} = require('../db/pool.js');

const {
  findBookingById
} = require('../models/bookings.model.js');

const {
  insertTransaction
} = require('../models/payments.model.js');

const {
  lockBooking,
  reacquireSeats
} = require('./seatHold.service.js');

const {
  findUserById
} = require('../models/users.model.js');

const {
  sendEmail
} = require('./email.service.js');

const {
  buildNotificationEmailHtml
} = require('./emailTemplate.service.js');

const {
  env
} = require('../config/env.js');

const {
  getIo
} = require('../sockets/index.js');

const {
  createNotification
} = require('./notification.service.js');

const {
  formatMoney
} = require('../utils/currency.js');

// Writes the payment onto the booking under its row lock, so it can't
// interleave with a seat release. A payment that lands after its unpaid
// booking already expired (seatHold.service.js — its seats released, the
// booking cancelled) revives the booking and takes the seats back.
async function applyBookingPayment(bookingId, status, newDepositPaid, newBalanceDue) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockBooking(client, bookingId);
    if (locked?.fd_departure_date_id && !Number(locked.seats_held) && Number(locked.deposit_paid) <= 0) {
      await reacquireSeats(client, locked);
    }
    await client.query(
      `UPDATE bookings SET status = ?, deposit_paid = ?, balance_due = ?, seat_hold_expires_at = NULL, updated_at = now() WHERE id = ?`,
      [status, newDepositPaid, newBalanceDue, bookingId]
    );
    await client.query('COMMIT');
    return status;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function confirmPayment(payment) {
  const booking = await findBookingById(payment.booking_id);
  if (!booking) return;

  // Whether this payment leaves a balance still owed or settles the booking
  // in full — computed up front so both the transaction record and the
  // booking's own status agree on the same word (previously the transaction
  // always said 'confirmed' regardless of completeness, and partial payments
  // pushed the booking itself to 'confirmed' too, indistinguishable from a
  // fully-settled one).
  const newDepositPaid = Number(booking.deposit_paid) + Number(payment.amount);
  const newBalanceDue = Math.max(0, Number(booking.total_price) - newDepositPaid);
  const status = newBalanceDue <= 0 ? 'fully_paid' : 'balance_due';

  try {
    await insertTransaction({
      agencyId: booking.agency_id,
      bookingId: booking.id,
      paymentId: payment.id,
      amount: payment.amount,
      method: payment.method,
      status,
      totalPrice: booking.total_price,
      amountPaidToDate: newDepositPaid,
    });
  } catch (err) {
    // MySQL's duplicate-key error code (ER_DUP_ENTRY), replacing Postgres' '23505'
    // — same transactions(payment_id) unique index, different driver's error shape.
    if (err.code === 'ER_DUP_ENTRY') return; // already processed by an earlier delivery
    throw err;
  }

  // Also revives a booking whose hold expired before this payment landed
  // (see applyBookingPayment).
  const bookingStatus = await applyBookingPayment(booking.id, status, newDepositPaid, newBalanceDue);

  const creator = await findUserById(booking.created_by_user_id);
  if (creator) {
    const statusLabel = status === 'fully_paid' ? 'Fully paid' : 'Balance due';
    const bookingUrl = `${env.agentPortalUrl}/bookings/${booking.id}`;
    const { html, attachments } = buildNotificationEmailHtml({
      heading: 'Payment received',
      paragraphs: [
        `Hi ${creator.full_name || 'there'}, we've received your payment for booking ${booking.id.slice(0, 8).toUpperCase()}.`,
        newBalanceDue > 0
          ? `A balance of ${formatMoney(newBalanceDue)} is still due on this booking.`
          : 'This booking is now fully paid — thank you.',
      ],
      highlight: { label: 'Amount received', value: formatMoney(payment.amount) },
      details: [
        { label: 'Booking', value: booking.package_title || booking.id },
        { label: 'Payment method', value: { cashfree: 'Card (Cashfree)', neft: 'NEFT bank transfer', credit_terms: 'Credit terms' }[payment.method] || payment.method },
        { label: 'Total booking value', value: formatMoney(booking.total_price) },
        { label: 'Paid to date', value: formatMoney(newDepositPaid) },
        { label: 'Balance remaining', value: formatMoney(newBalanceDue) },
        { label: 'Booking status', value: statusLabel },
      ],
      ctaLabel: 'View booking',
      ctaUrl: bookingUrl,
    });
    await sendEmail({
      to: creator.email,
      subject: 'Payment received — Xclusive Oman',
      text: `We've received your payment of ${formatMoney(payment.amount)} for booking ${booking.id}. Balance remaining: ${formatMoney(newBalanceDue)}. Booking status: ${statusLabel}. View it at ${bookingUrl}`,
      html,
      attachments,
    });
  }

  const io = getIo();
  io?.to(`agency:${booking.agency_id}`).emit('booking:status_changed', {
    bookingId: booking.id,
    status: bookingStatus,
  });
  // Fast UI signal for the Payment page / return page (spec M). Webhook + the
  // GET /api/payments/:id poll remain the authoritative / fallback paths.
  io?.to(`agency:${booking.agency_id}`).emit('payment:status_changed', {
    bookingId: booking.id,
    paymentId: payment.id,
    status: 'confirmed',
  });
  // Persisted via createNotification so it carries id/createdAt/isRead like
  // every other bell notification (and survives a page refresh).
  if (creator) {
    try {
      await createNotification({
        recipientUserId: creator.id,
        recipientRole: creator.role,
        type: 'payment_confirmed',
        title: 'Payment confirmed',
        message: `${formatMoney(payment.amount)} received — booking ${status === 'fully_paid' ? 'fully paid' : 'balance due'}.`,
        referenceType: 'booking',
        referenceId: booking.id,
      });
    } catch (err) {
      console.error(`[paymentConfirmation] Failed to create notification for booking ${booking.id}`, err);
    }
  }
}

module.exports.confirmPayment = confirmPayment;
