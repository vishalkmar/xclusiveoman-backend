const {
  pool
} = require('../db/pool.js');

async function findBookingById(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findBookingById = findBookingById;

// Separate from findBookingById (SELECT *) rather than joining there — both
// bookings and fd_departure_dates have their own `id` column, so a blanket
// join would silently clobber one under the other's alias for the 6+
// existing callers that don't expect it.
async function findBookingWithDepartureDate(id) {
  const { rows } = await pool.query(
    `SELECT b.*, dd.date AS departure_date
     FROM bookings b
     LEFT JOIN fd_departure_dates dd ON dd.id = b.fd_departure_date_id
     WHERE b.id = ?`,
    [id]
  );
  return rows[0] || null;
}

module.exports.findBookingWithDepartureDate = findBookingWithDepartureDate;

async function findBookingBySource(sourceType, sourceId) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE source_type = ? AND source_id = ? LIMIT 1',
    [sourceType, sourceId]
  );
  return rows[0] || null;
}

module.exports.findBookingBySource = findBookingBySource;

async function listAgencyBookings(agencyId) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE agency_id = ? ORDER BY created_at DESC',
    [agencyId]
  );
  return rows;
}

module.exports.listAgencyBookings = listAgencyBookings;

async function updateBookingStatus(id, status, extra = {}) {
  const setClauses = ['status = ?', 'updated_at = now()'];
  const values = [status];

  if (extra.depositPaid !== undefined) {
    setClauses.push(`deposit_paid = ?`);
    values.push(extra.depositPaid);
  }

  if (extra.refundRequestedAmount !== undefined) {
    setClauses.push('refund_requested_amount = ?', 'refund_requested_at = now()');
    values.push(extra.refundRequestedAmount);
  }

  if (extra.refundReason !== undefined) {
    setClauses.push('refund_reason = ?');
    values.push(extra.refundReason);
  }

  values.push(id);
  await pool.query(
    `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ?`,
    values
  );
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.updateBookingStatus = updateBookingStatus;

async function listBookingTravelers(bookingId) {
  const { rows } = await pool.query('SELECT * FROM booking_travelers WHERE booking_id = ?', [bookingId]);
  return rows;
}

module.exports.listBookingTravelers = listBookingTravelers;
