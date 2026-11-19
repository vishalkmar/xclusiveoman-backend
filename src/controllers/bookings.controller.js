const {
  findBookingWithDepartureDate,
  listAgencyBookings,
  listBookingTravelers,
  updateBookingStatus
} = require('../models/bookings.model.js');

const REFUND_INELIGIBLE_STATUSES = new Set([
  'cancellation_requested',
  'cancelled',
  'completed',
  'waitlisted',
]);

// Refund window is measured against days until departure, not days since
// booking — a booking made yesterday for a departure next month is still
// refund-eligible, one made months ago for a departure next week is not.
function computeRefundEligibility(booking) {
  if (REFUND_INELIGIBLE_STATUSES.has(booking.status)) {
    return { eligible: false, reason: 'booking_not_active' };
  }
  if (Number(booking.deposit_paid) <= 0) {
    return { eligible: false, reason: 'no_payment_made' };
  }
  if (!booking.departure_date) {
    return { eligible: false, reason: 'no_departure_date' };
  }
  const departureDate = new Date(booking.departure_date);
  const daysUntilDeparture = Math.ceil((departureDate.getTime() - Date.now()) / 86400000);
  if (daysUntilDeparture <= 3) {
    return { eligible: false, reason: 'too_close_to_departure' };
  }
  return { eligible: true, reason: null };
}

function toPublicBooking(b) {
  const depositDue = Number(b.deposit_due);
  // What's still due right now to hold the seat: the part-payment figure
  // fixed at booking time (0077 — full price within 15 days of departure,
  // otherwise a flat deposit) minus whatever's already been paid. Drops to
  // zero once that first payment lands; the payment screen charges this,
  // not the whole balance.
  const amountDueNow = Math.max(0, depositDue - Number(b.deposit_paid));
  return {
    id: b.id,
    sourceType: b.source_type,
    sourceId: b.source_id,
    pax: b.pax,
    totalPrice: Number(b.total_price),
    depositPaid: Number(b.deposit_paid),
    balanceDue: Number(b.balance_due),
    balanceDueDate: b.balance_due_date,
    depositDue,
    amountDueNow,
    remainingBalance: Math.max(0, Number(b.balance_due) - amountDueNow),
    status: b.status,
    createdAt: b.created_at,
    // When an unpaid FD booking's seats are released (null once paid/cancelled).
    // serverNow lets the payment page's countdown ignore the client's clock.
    seatHoldExpiresAt: b.seat_hold_expires_at ? new Date(b.seat_hold_expires_at).toISOString() : null,
    serverNow: new Date().toISOString(),
  };
}

async function getBooking(req, res, next) {
  try {
    const booking = await findBookingWithDepartureDate(req.params.id);
    if (!booking || booking.agency_id !== req.user.agency_id) {
      return res.status(404).json({ error: 'not_found' });
    }
    const travelers = await listBookingTravelers(booking.id);
    const { eligible, reason } = computeRefundEligibility(booking);
    res.json({
      booking: {
        ...toPublicBooking(booking),
        travelers: travelers.map((t) => ({ name: t.name, passportNo: t.passport_no })),
        departureDate: booking.departure_date,
        refundEligible: eligible,
        refundIneligibleReason: reason,
        refundRequestedAt: booking.refund_requested_at,
        refundRequestedAmount: booking.refund_requested_amount === null ? null : Number(booking.refund_requested_amount),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getBooking = getBooking;

async function requestRefund(req, res, next) {
  try {
    const booking = await findBookingWithDepartureDate(req.params.id);
    if (!booking || booking.agency_id !== req.user.agency_id) {
      return res.status(404).json({ error: 'not_found' });
    }
    const { eligible, reason } = computeRefundEligibility(booking);
    if (!eligible) {
      return res.status(409).json({ error: 'refund_not_eligible', reason });
    }
    const updated = await updateBookingStatus(booking.id, 'cancellation_requested', {
      refundRequestedAmount: Number(booking.deposit_paid),
      refundReason: req.body.reason || null,
    });
    res.json({
      booking: {
        ...toPublicBooking(updated),
        refundRequestedAt: updated.refund_requested_at,
        refundRequestedAmount: Number(updated.refund_requested_amount),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.requestRefund = requestRefund;

async function listMyBookings(req, res, next) {
  try {
    const rows = await listAgencyBookings(req.user.agency_id);
    res.json({ bookings: rows.map(toPublicBooking) });
  } catch (err) {
    next(err);
  }
}

module.exports.listMyBookings = listMyBookings;
