const {
  pool
} = require('../db/pool.js');

// Agent Portal Revenue page — mirrors admin/analytics.model.js's own
// revenue definition and query shapes, but every function here is always
// scoped to exactly one agency. `agencyId` is never client-suppliable —
// the controller always injects it from req.user.agency_id (the
// authenticated agent's own session), so one agency can never see another
// agency's numbers. FD-only for the same reason analytics.model.js is:
// package_request/mice_rfq bookings don't exist yet anywhere in this
// codebase (see bookingsAdmin.model.js's own comment).
//
// "Revenue" here reads as this agency's own spend with Xclusive Oman (what
// they've booked and paid), not money the agency earns — same
// deposit_paid/total_price/balance_due fields and the same "recognized
// revenue = deposit_paid, cancelled/waitlisted excluded from money sums but
// not from booking counts" definition analytics.model.js's own header
// comment documents at length; not repeated here verbatim to avoid the two
// drifting apart in wording while staying identical in practice.
const REVENUE_STATUS_EXCLUSION = `b.status NOT IN ('cancelled', 'waitlisted', 'pending_payment')`;

// Bookings that count towards any of this agency's numbers at all — same
// rule as analytics.model.js's STATS_SCOPE: unpaid bookings (pending
// payment, waitlisted, or cancelled without ever being paid) are left out.
const STATS_SCOPE = `(b.status NOT IN ('pending_payment', 'waitlisted') AND NOT (b.status = 'cancelled' AND b.deposit_paid <= 0))`;

function buildDateFilters({ dateFrom, dateTo }) {
  const clauses = [];
  const values = [];
  if (dateFrom) {
    clauses.push(`b.created_at >= ?`);
    values.push(dateFrom);
  }
  if (dateTo) {
    clauses.push(`b.created_at < (? + INTERVAL 1 DAY)`);
    values.push(dateTo);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', values };
}

// column is always a fixed literal the caller passes (never user input) —
// only the search term itself goes through a bound parameter.
function buildSearchFilter(column, search) {
  const trimmed = (search || '').trim();
  if (!trimmed) return { clause: '', values: [] };
  return { clause: `AND ${column} LIKE ?`, values: [`%${trimmed}%`] };
}

async function getSummary({ agencyId, dateFrom, dateTo } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const values = [agencyId, ...dateFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} AND b.agency_id = ? ${dateFilters.clause}`;

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS total_paid,
       COUNT(CASE WHEN ${REVENUE_STATUS_EXCLUSION} AND b.deposit_paid > 0 THEN 1 END) AS paid_booking_count
     FROM bookings b
     ${where}`,
    values
  );

  const totalPaid = Number(rows[0].total_paid);
  const paidBookingCount = Number(rows[0].paid_booking_count);

  return {
    totalBookings: Number(rows[0].total_bookings),
    totalPaid,
    averageBookingValue: paidBookingCount > 0 ? totalPaid / paidBookingCount : 0,
  };
}

module.exports.getSummary = getSummary;

async function getSpendByMonth({ agencyId, dateFrom, dateTo }) {
  const { rows } = await pool.query(
    `SELECT
       DATE_FORMAT(b.created_at, '%Y-%m-01') AS month_start,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COUNT(*) AS booking_count
     FROM bookings b
     WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE}
       AND b.agency_id = ?
       AND b.created_at >= ?
       AND b.created_at < (? + INTERVAL 1 DAY)
     GROUP BY 1`,
    [agencyId, dateFrom, dateTo]
  );

  const byMonth = new Map();
  for (const r of rows) {
    const key = r.month_start instanceof Date ? r.month_start.toISOString().slice(0, 10) : String(r.month_start).slice(0, 10);
    byMonth.set(key, { revenue: Number(r.revenue), bookingCount: Number(r.booking_count) });
  }

  const months = [];
  const cursor = new Date(Date.UTC(
    new Date(dateFrom).getUTCFullYear(),
    new Date(dateFrom).getUTCMonth(),
    1
  ));
  const end = new Date(Date.UTC(
    new Date(dateTo).getUTCFullYear(),
    new Date(dateTo).getUTCMonth(),
    1
  ));
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    const bucket = byMonth.get(key);
    months.push({
      month: key,
      revenue: bucket ? bucket.revenue : 0,
      bookingCount: bucket ? bucket.bookingCount : 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

module.exports.getSpendByMonth = getSpendByMonth;

async function getSpendByPackage({ agencyId, dateFrom, dateTo, search, page, pageSize } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const searchFilters = buildSearchFilter('fp.title', search);
  const values = [agencyId, ...dateFilters.values, ...searchFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} AND b.agency_id = ? ${dateFilters.clause} ${searchFilters.clause}`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(DISTINCT fp.id) AS count
     FROM bookings b
     JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
     JOIN fd_packages fp ON fp.id = fdd.fd_package_id
     ${where}`,
    values
  );
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const { rows } = await pool.query(
    `SELECT
       fp.id AS package_id,
       fp.title AS package_title,
       COUNT(*) AS booking_count,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue
     FROM bookings b
     JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
     JOIN fd_packages fp ON fp.id = fdd.fd_package_id
     ${where}
     GROUP BY fp.id, fp.title
     ORDER BY revenue DESC, booking_count DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return {
    rows: rows.map((r) => ({
      packageId: r.package_id,
      packageTitle: r.package_title,
      bookingCount: Number(r.booking_count),
      revenue: Number(r.revenue),
    })),
    total,
    page: currentPage,
    pageSize: limit,
  };
}

module.exports.getSpendByPackage = getSpendByPackage;

async function getPaymentsOverview({ agencyId, dateFrom, dateTo, status } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const statusFilters = status ? { clause: `AND b.status = ?`, values: [status] } : { clause: '', values: [] };
  const values = [agencyId, ...dateFilters.values, ...statusFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} AND b.agency_id = ? ${dateFilters.clause} ${statusFilters.clause}`;

  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*) AS total_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.total_price ELSE 0 END), 0) AS total_booked_value,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS total_collected,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.balance_due ELSE 0 END), 0) AS total_outstanding
     FROM bookings b
     ${where}`,
    values
  );

  const { rows: statusRows } = await pool.query(
    `SELECT b.status, COUNT(*) AS count
     FROM bookings b
     ${where}
     GROUP BY b.status`,
    values
  );

  const totalBookedValue = Number(totals[0].total_booked_value);
  const totalCollected = Number(totals[0].total_collected);

  return {
    totalBookings: Number(totals[0].total_bookings),
    totalBookedValue,
    totalCollected,
    totalOutstanding: Number(totals[0].total_outstanding),
    collectionRate: totalBookedValue > 0 ? totalCollected / totalBookedValue : 0,
    byStatus: statusRows.map((r) => ({ status: r.status, count: Number(r.count) })),
  };
}

module.exports.getPaymentsOverview = getPaymentsOverview;
