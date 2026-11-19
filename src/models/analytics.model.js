const {
  pool
} = require('../db/pool.js');

// Admin Analytics & Reporting (Task 19 — Screen 18, ANL-1). FD-only, same
// scoping every prior admin feature in this codebase has used since Task 13
// (source_type = 'fd_package' is the only booking source that actually
// exists — see bookingsAdmin.model.js's own comment).
//
// --- Revenue definition (read this before touching any query below) ---
// "Recognized revenue" = SUM(bookings.deposit_paid), never
// SUM(transactions.amount). Both revenue-recognition paths in this codebase
// keep bookings.deposit_paid correctly up to date:
//   - Self-service: paymentConfirmation.service.js#confirmPayment increments
//     it AND inserts a `transactions` row (real Cashfree webhook success or
//     an admin-approved NEFT slip only — never a guess).
//   - Manual admin bookings (Task 13): booking.service.js#createFdBooking
//     sets it directly at creation time from an admin-entered offline
//     deposit, WITHOUT ever inserting a `transactions` row (Task 13
//     deliberately never fabricates a payments/transactions record for that
//     path — see its own comments).
// Summing `transactions.amount` instead would silently under-count every
// manual booking's deposit. Deliberately using bookings.deposit_paid
// EXCLUSIVELY (never also summing transactions) is what avoids
// double-counting the same money through two sources.
//
// "Confirmed/successful" scope: every query below excludes bookings with
// status IN ('cancelled', 'waitlisted') from revenue (not from booking
// counts) — a cancelled booking's historical deposit isn't ongoing
// recognized revenue, and a waitlisted booking was never confirmed against
// a real seat. This codebase has no refund-reversal mechanism, so this
// status exclusion is the only available, non-invented way to scope
// "successful" records.
const REVENUE_STATUS_EXCLUSION = `b.status NOT IN ('cancelled', 'waitlisted', 'pending_payment')`;

// Which bookings count towards any statistic at all (counts, pax, booked
// value, revenue, breakdowns): unpaid ones are left out entirely — a booking
// still pending payment, a waitlisted one, or one cancelled without ever
// being paid (an expired seat hold — seatHold.service.js). Lots of agents
// start bookings at once and many never pay; counting those would skew
// every sales number. A cancelled booking that *was* paid still counts (it
// shows under cancellations). The only metric that looks at unpaid bookings
// is "abandoned" (ABANDONED_CONDITION), computed outside this scope.
const STATS_SCOPE = `(b.status NOT IN ('pending_payment', 'waitlisted') AND NOT (b.status = 'cancelled' AND b.deposit_paid <= 0))`;

// Placeholders are plain `?` under MySQL (positional, not numbered like
// Postgres's $1/$2), so unlike the original these helpers no longer need to
// thread a startIndex/next counter through the caller — clause order and
// values-array push order just have to match, which they already do
// everywhere these are used (clause is always interpolated in the same
// order its values were pushed).
function buildAgencyFilters({ agencyId, country }) {
  const clauses = [];
  const values = [];
  if (agencyId) {
    clauses.push(`b.agency_id = ?`);
    values.push(agencyId);
  }
  if (country) {
    clauses.push(`a.country = ?`);
    values.push(country);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', values };
}

// Generic `column LIKE %search%` filter — column is always a fixed literal
// the caller passes (e.g. 'a.name', 'fp.title'), never user input, so this
// is safe to interpolate; only the search term itself goes through a bound
// parameter.
function buildSearchFilter(column, search) {
  const trimmed = (search || '').trim();
  if (!trimmed) return { clause: '', values: [] };
  return { clause: `AND ${column} LIKE ?`, values: [`%${trimmed}%`] };
}

function buildDateFilters({ dateFrom, dateTo }) {
  const clauses = [];
  const values = [];
  if (dateFrom) {
    clauses.push(`b.created_at >= ?`);
    values.push(dateFrom);
  }
  if (dateTo) {
    // Inclusive of the whole end day, same convention packageRequestsAdmin.model.js uses.
    clauses.push(`b.created_at < (? + INTERVAL 1 DAY)`);
    values.push(dateTo);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', values };
}

async function getSummary({ dateFrom, dateTo, agencyId, country } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const agencyFilters = buildAgencyFilters({ agencyId, country });
  const values = [...dateFilters.values, ...agencyFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} ${dateFilters.clause} ${agencyFilters.clause}`;

  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*) AS total_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS total_revenue,
       COUNT(CASE WHEN ${REVENUE_STATUS_EXCLUSION} AND b.deposit_paid > 0 THEN 1 END) AS revenue_booking_count
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     ${where}`,
    values
  );

  // Sales mix — bookings.created_via (self_service vs manual_admin), per
  // this file's own top comment on why this dimension was chosen over
  // transaction.method (incomplete for manual bookings) or source_type
  // (always 'fd_package' today, so not a meaningful "mix" at all).
  const { rows: salesMixRows } = await pool.query(
    `SELECT
       b.created_via,
       COUNT(*) AS booking_count,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     ${where}
     GROUP BY b.created_via`,
    values
  );

  // Total agencies — snapshot of approved agencies, date-filtered by their
  // own created_at when a range is given (same range, applied to a
  // different table's own timestamp — agencies has no relationship to
  // bookings.created_at).
  const agencyDateClauses = [];
  const agencyDateValues = [];
  if (dateFrom) {
    agencyDateClauses.push(`created_at >= ?`);
    agencyDateValues.push(dateFrom);
  }
  if (dateTo) {
    agencyDateClauses.push(`created_at < (? + INTERVAL 1 DAY)`);
    agencyDateValues.push(dateTo);
  }
  const agencyWhere = ['status = \'approved\'', ...agencyDateClauses].join(' AND ');
  const { rows: agencyRows } = await pool.query(`SELECT COUNT(*) AS total_agencies FROM agencies WHERE ${agencyWhere}`, agencyDateValues);

  const totalRevenue = Number(totals[0].total_revenue);
  const totalBookings = Number(totals[0].total_bookings);
  const revenueBookingCount = Number(totals[0].revenue_booking_count);

  return {
    totalBookings,
    totalRevenue,
    averageBookingValue: revenueBookingCount > 0 ? totalRevenue / revenueBookingCount : 0,
    totalAgencies: Number(agencyRows[0].total_agencies),
    // Profit margin is deliberately never computed — see this file's own
    // header comment / analytics.controller.js's own comment for why no
    // cost-basis field exists anywhere in this schema for FD bookings.
    profitMargin: {
      available: false,
      reason: 'FD packages have no reliable cost-basis field in the current schema — only the sell price (rate_per_pax) is stored, never an admin-entered net cost. Profit margin cannot be calculated without inventing a cost figure, so it is intentionally omitted rather than shown as a fabricated percentage.',
    },
    salesMix: salesMixRows.map((r) => ({
      createdVia: r.created_via,
      bookingCount: Number(r.booking_count),
      revenue: Number(r.revenue),
    })),
  };
}

module.exports.getSummary = getSummary;

async function getRevenueByMonth({ dateFrom, dateTo, agencyId, country }) {
  const agencyFilters = buildAgencyFilters({ agencyId, country });
  const values = [dateFrom, dateTo, ...agencyFilters.values];

  const { rows } = await pool.query(
    `SELECT
       DATE_FORMAT(b.created_at, '%Y-%m-01') AS month_start,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COUNT(*) AS booking_count
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE}
       AND b.created_at >= ?
       AND b.created_at < (? + INTERVAL 1 DAY)
       ${agencyFilters.clause}
     GROUP BY 1`,
    values
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

module.exports.getRevenueByMonth = getRevenueByMonth;

async function getTopAgencies({ dateFrom, dateTo, agencyId, country, search, page, pageSize } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const agencyFilters = buildAgencyFilters({ agencyId, country });
  const searchFilters = buildSearchFilter('a.name', search);
  const values = [...dateFilters.values, ...agencyFilters.values, ...searchFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} ${dateFilters.clause} ${agencyFilters.clause} ${searchFilters.clause}`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(DISTINCT a.id) AS count
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     ${where}`,
    values
  );
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const { rows } = await pool.query(
    `SELECT
       a.id AS agency_id,
       a.name AS agency_name,
       a.country,
       COUNT(*) AS booking_count,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     ${where}
     GROUP BY a.id, a.name, a.country
     ORDER BY revenue DESC, booking_count DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return {
    rows: rows.map((r) => ({
      agencyId: r.agency_id,
      agencyName: r.agency_name,
      country: r.country,
      bookingCount: Number(r.booking_count),
      revenue: Number(r.revenue),
    })),
    total,
    page: currentPage,
    pageSize: limit,
  };
}

module.exports.getTopAgencies = getTopAgencies;

// Admin Revenue page (separate from this same file's Analytics summary
// above) — By Package tab. Same shape/pagination as getTopAgencies, grouped
// by fd_package instead of agency. FD-only for the same reason every other
// query in this file is (see the header comment) — package_request/mice_rfq
// bookings don't exist yet, so there is no non-FD revenue to break out here.
async function getRevenueByPackage({ dateFrom, dateTo, country, search, page, pageSize } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const countryFilters = buildAgencyFilters({ country });
  const searchFilters = buildSearchFilter('fp.title', search);
  const values = [...dateFilters.values, ...countryFilters.values, ...searchFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} ${dateFilters.clause} ${countryFilters.clause} ${searchFilters.clause}`;

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(DISTINCT fp.id) AS count
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
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
     JOIN agencies a ON a.id = b.agency_id
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

module.exports.getRevenueByPackage = getRevenueByPackage;

// Admin Revenue page — Payments Collected vs Outstanding tab. Distinct from
// "recognized revenue" above (bookings.deposit_paid alone): this also sums
// total_price (what was actually booked) and balance_due (what's still owed)
// so collection efficiency is visible, not just money already in hand.
// Same REVENUE_STATUS_EXCLUSION scope (cancelled/waitlisted bookings carry
// no ongoing collectible balance), but the by-status breakdown below is
// deliberately NOT scoped by it — an admin reviewing payment status needs to
// see cancelled/waitlisted counts too, same convention getSummary's own
// booking counts (as opposed to its revenue sums) already follow.
async function getPaymentsOverview({ dateFrom, dateTo, agencyId, country, status, search } = {}) {
  const dateFilters = buildDateFilters({ dateFrom, dateTo });
  const agencyFilters = buildAgencyFilters({ agencyId, country });
  const searchFilters = buildSearchFilter('a.name', search);
  // status is a plain equality filter (not LIKE) — the bookings.status enum
  // itself (validation/schemas.js's bookingStatusEnum on the backend, same
  // list this file's own STATUS_LABEL on the frontend maps) is the only
  // valid input space, bound as a parameter same as every other filter here.
  const statusFilters = status ? { clause: `AND b.status = ?`, values: [status] } : { clause: '', values: [] };
  const values = [...dateFilters.values, ...agencyFilters.values, ...searchFilters.values, ...statusFilters.values];
  const where = `WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} ${dateFilters.clause} ${agencyFilters.clause} ${searchFilters.clause} ${statusFilters.clause}`;

  const { rows: totals } = await pool.query(
    `SELECT
       COUNT(*) AS total_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.total_price ELSE 0 END), 0) AS total_booked_value,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS total_collected,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.balance_due ELSE 0 END), 0) AS total_outstanding
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
     ${where}`,
    values
  );

  const { rows: statusRows } = await pool.query(
    `SELECT b.status, COUNT(*) AS count
     FROM bookings b
     JOIN agencies a ON a.id = b.agency_id
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

// ---------------------------------------------------------------------------
// Admin Revenue page — detailed revenue analysis (Overview tab + the
// /admin/revenue/analysis page). One call returns everything those views
// render, all scoped by the same filter set so every number on the page
// agrees with every other:
//   - KPIs for the selected range AND a comparison range (by default the
//     equal-length period immediately before; the caller can pass its own
//     prevFrom/prevTo, which is how the page's Compare mode works)
//   - a revenue trend bucketed by day / week (Mon-start) / month, with the
//     comparison range's buckets aligned by index for a "prev period" overlay
//   - abandoned bookings (status pending_payment with nothing paid — someone
//     started a booking and never completed payment) per bucket, with a
//     per-package breakdown
//   - top packages / agencies (with their comparison-period revenue), and
//     breakdowns by country, status and sales channel (created_via)
// Same revenue definition as the rest of this file (deposit_paid,
// REVENUE_STATUS_EXCLUSION). Profit/margin is still deliberately absent —
// see getSummary's profitMargin note.
// Started but never paid: still pending, or cancelled with nothing paid (an
// expired seat hold). Outside STATS_SCOPE by definition, so the queries that
// report it run unscoped (analysisWhere's `scoped: false`) and wrap every
// other aggregate in a CASE WHEN on STATS_SCOPE themselves.
const ABANDONED_CONDITION = `(b.deposit_paid <= 0 AND b.status IN ('pending_payment', 'cancelled'))`;
const ANALYSIS_GRANULARITIES = ['day', 'week', 'month'];

const ANALYSIS_FROM = `
  FROM bookings b
  JOIN agencies a ON a.id = b.agency_id
  LEFT JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
  LEFT JOIN fd_packages fp ON fp.id = fdd.fd_package_id`;

// Every non-date filter the analysis page offers. Columns are fixed
// literals; only the filter values are bound.
function buildAnalysisFilters({ country, agencyId, packageId, createdVia, status, search }) {
  const clauses = [];
  const values = [];
  if (country) {
    clauses.push('a.country = ?');
    values.push(country);
  }
  if (agencyId) {
    clauses.push('b.agency_id = ?');
    values.push(agencyId);
  }
  if (packageId) {
    clauses.push('fp.id = ?');
    values.push(packageId);
  }
  if (createdVia) {
    clauses.push('b.created_via = ?');
    values.push(createdVia);
  }
  if (status) {
    clauses.push('b.status = ?');
    values.push(status);
  }
  const trimmed = (search || '').trim();
  if (trimmed) {
    clauses.push('(a.name LIKE ? OR fp.title LIKE ?)');
    values.push(`%${trimmed}%`, `%${trimmed}%`);
  }
  return { clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '', values };
}

function analysisWhere(range, filters, { scoped = true } = {}) {
  const dates = buildDateFilters(range);
  return {
    where: `WHERE b.source_type = 'fd_package' ${scoped ? `AND ${STATS_SCOPE}` : ''} ${dates.clause} ${filters.clause}`,
    values: [...dates.values, ...filters.values],
  };
}

function bucketExpr(granularity) {
  if (granularity === 'day') return `DATE_FORMAT(b.created_at, '%Y-%m-%d')`;
  if (granularity === 'week') return `DATE_FORMAT(DATE_SUB(DATE(b.created_at), INTERVAL WEEKDAY(b.created_at) DAY), '%Y-%m-%d')`;
  return `DATE_FORMAT(b.created_at, '%Y-%m-01')`;
}

// Pure-UTC date helpers — every range here is a calendar date string, never
// a moment in time, so no local-timezone offset should ever shift it.
function parseYmd(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function ymdUtc(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function daysBetween(from, to) {
  return Math.round((parseYmd(to) - parseYmd(from)) / 86400000) + 1;
}

function bucketStart(date, granularity) {
  if (granularity === 'day') return new Date(date);
  if (granularity === 'week') return addDays(date, -((date.getUTCDay() + 6) % 7));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function listBuckets(dateFrom, dateTo, granularity) {
  const buckets = [];
  const end = parseYmd(dateTo);
  let cursor = bucketStart(parseYmd(dateFrom), granularity);
  while (cursor <= end) {
    buckets.push(ymdUtc(cursor));
    if (granularity === 'day') cursor = addDays(cursor, 1);
    else if (granularity === 'week') cursor = addDays(cursor, 7);
    else cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return buckets;
}

// 'auto' (or anything unrecognized) picks by range length; an explicit
// choice that would produce an unreadable number of buckets is coarsened.
function resolveGranularity(requested, dateFrom, dateTo) {
  const days = daysBetween(dateFrom, dateTo);
  let g = ANALYSIS_GRANULARITIES.includes(requested) ? requested : days <= 31 ? 'day' : days <= 180 ? 'week' : 'month';
  if (g === 'day' && days > 366) g = 'week';
  if (g === 'week' && days > 7 * 260) g = 'month';
  return g;
}

async function getAnalysisKpis(range, filters) {
  // Unscoped so abandoned bookings are visible; everything else is limited
  // to STATS_SCOPE per aggregate.
  const { where, values } = analysisWhere(range, filters, { scoped: false });
  const { rows } = await pool.query(
    `SELECT
       COUNT(CASE WHEN ${STATS_SCOPE} THEN 1 END) AS total_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COUNT(CASE WHEN ${REVENUE_STATUS_EXCLUSION} AND b.deposit_paid > 0 THEN 1 END) AS revenue_bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.total_price ELSE 0 END), 0) AS booked_value,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.balance_due ELSE 0 END), 0) AS outstanding,
       COALESCE(SUM(CASE WHEN ${STATS_SCOPE} THEN b.pax ELSE 0 END), 0) AS total_pax,
       COUNT(CASE WHEN ${ABANDONED_CONDITION} THEN 1 END) AS abandoned_count,
       COALESCE(SUM(CASE WHEN ${ABANDONED_CONDITION} THEN b.total_price ELSE 0 END), 0) AS abandoned_value,
       COUNT(CASE WHEN ${STATS_SCOPE} AND b.status = 'cancelled' THEN 1 END) AS cancelled_count,
       COALESCE(SUM(CASE WHEN ${STATS_SCOPE} AND b.status = 'cancelled' THEN b.total_price ELSE 0 END), 0) AS cancelled_value,
       COUNT(CASE WHEN ${STATS_SCOPE} THEN b.refund_requested_amount END) AS refund_request_count,
       COALESCE(SUM(CASE WHEN ${STATS_SCOPE} THEN b.refund_requested_amount END), 0) AS refund_requested_amount,
       COUNT(DISTINCT CASE WHEN ${STATS_SCOPE} THEN b.agency_id END) AS active_agencies,
       COUNT(DISTINCT CASE WHEN ${STATS_SCOPE} THEN fp.id END) AS active_packages
     ${ANALYSIS_FROM}
     ${where}`,
    values
  );
  const r = rows[0];
  const revenue = Number(r.revenue);
  const revenueBookings = Number(r.revenue_bookings);
  const totalBookings = Number(r.total_bookings);
  const bookedValue = Number(r.booked_value);
  const refundRequestedAmount = Number(r.refund_requested_amount);
  return {
    totalRevenue: revenue,
    // Refund requests are a record of what agents asked for, not a payout
    // (see migration 0088), so this is "revenue if every open request were
    // honored" — labelled as such on the page.
    netRevenue: Math.max(0, revenue - refundRequestedAmount),
    bookedValue,
    outstanding: Number(r.outstanding),
    totalBookings,
    revenueBookings,
    averageBookingValue: revenueBookings > 0 ? revenue / revenueBookings : 0,
    totalPax: Number(r.total_pax),
    averagePaxPerBooking: totalBookings > 0 ? Number(r.total_pax) / totalBookings : 0,
    collectionRate: bookedValue > 0 ? revenue / bookedValue : 0,
    abandonedCount: Number(r.abandoned_count),
    abandonedValue: Number(r.abandoned_value),
    // Share of every booking attempt that was abandoned — totalBookings no
    // longer includes the abandoned ones, so they're added back here.
    abandonmentRate:
      totalBookings + Number(r.abandoned_count) > 0
        ? Number(r.abandoned_count) / (totalBookings + Number(r.abandoned_count))
        : 0,
    cancelledCount: Number(r.cancelled_count),
    cancelledValue: Number(r.cancelled_value),
    refundRequestCount: Number(r.refund_request_count),
    refundRequestedAmount,
    activeAgencies: Number(r.active_agencies),
    activePackages: Number(r.active_packages),
  };
}

async function getAnalysisTrendRows(range, filters, granularity) {
  const { where, values } = analysisWhere(range, filters, { scoped: false });
  const { rows } = await pool.query(
    `SELECT
       ${bucketExpr(granularity)} AS bucket,
       COUNT(CASE WHEN ${STATS_SCOPE} THEN 1 END) AS bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.total_price ELSE 0 END), 0) AS booked_value,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.balance_due ELSE 0 END), 0) AS outstanding,
       COALESCE(SUM(CASE WHEN ${STATS_SCOPE} THEN b.pax ELSE 0 END), 0) AS pax,
       COUNT(CASE WHEN ${ABANDONED_CONDITION} THEN 1 END) AS abandoned,
       COALESCE(SUM(CASE WHEN ${ABANDONED_CONDITION} THEN b.total_price ELSE 0 END), 0) AS abandoned_value
     ${ANALYSIS_FROM}
     ${where}
     GROUP BY 1`,
    values
  );
  const map = new Map();
  for (const r of rows) {
    map.set(String(r.bucket).slice(0, 10), {
      bookings: Number(r.bookings),
      revenue: Number(r.revenue),
      bookedValue: Number(r.booked_value),
      outstanding: Number(r.outstanding),
      pax: Number(r.pax),
      abandoned: Number(r.abandoned),
      abandonedValue: Number(r.abandoned_value),
    });
  }
  return map;
}

async function getAbandonedByPackage(range, filters, granularity) {
  const { where, values } = analysisWhere(range, filters, { scoped: false });
  const { rows } = await pool.query(
    `SELECT ${bucketExpr(granularity)} AS bucket, COALESCE(fp.title, 'Unknown package') AS package_title, COUNT(*) AS count
     ${ANALYSIS_FROM}
     ${where} AND ${ABANDONED_CONDITION}
     GROUP BY 1, 2
     ORDER BY count DESC`,
    values
  );
  const map = new Map();
  for (const r of rows) {
    const key = String(r.bucket).slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ packageTitle: r.package_title, count: Number(r.count) });
  }
  return map;
}

async function queryBreakdownRows(range, filters, { idColumn, nameColumn, countryColumn, limit }) {
  const { where, values } = analysisWhere(range, filters, { scoped: false });
  const { rows } = await pool.query(
    `SELECT
       ${idColumn} AS id,
       ${nameColumn} AS name,
       ${countryColumn || 'NULL'} AS country,
       COUNT(CASE WHEN ${STATS_SCOPE} THEN 1 END) AS bookings,
       COALESCE(SUM(CASE WHEN ${STATS_SCOPE} THEN b.pax ELSE 0 END), 0) AS pax,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.total_price ELSE 0 END), 0) AS booked_value,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.balance_due ELSE 0 END), 0) AS outstanding,
       COUNT(CASE WHEN ${ABANDONED_CONDITION} THEN 1 END) AS abandoned
     ${ANALYSIS_FROM}
     ${where}
     GROUP BY 1, 2, 3
     ORDER BY revenue DESC, bookings DESC
     LIMIT ?`,
    [...values, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    bookings: Number(r.bookings),
    pax: Number(r.pax),
    revenue: Number(r.revenue),
    bookedValue: Number(r.booked_value),
    outstanding: Number(r.outstanding),
    abandoned: Number(r.abandoned),
  }));
}

// Grouped revenue per `idColumn` for the range, plus (when a comparison
// range is given) each row's comparison-period revenue. Rows that only
// earned in the comparison period are appended with zero current figures —
// "sold last month, nothing this month" is exactly what a comparison should
// surface, not hide.
async function getAnalysisBreakdown(range, prevRange, filters, { idColumn, nameColumn, countryColumn, limit = 10 }) {
  const opts = { idColumn, nameColumn, countryColumn, limit };
  const [rows, prevRows] = await Promise.all([
    queryBreakdownRows(range, filters, opts),
    prevRange ? queryBreakdownRows(prevRange, filters, opts) : Promise.resolve([]),
  ]);
  const prevById = new Map(prevRows.map((r) => [r.id, r]));
  const currentIds = new Set(rows.map((r) => r.id));
  const zero = { bookings: 0, pax: 0, revenue: 0, bookedValue: 0, outstanding: 0, abandoned: 0 };

  const withPrev = (r) => ({
    ...r,
    prevRevenue: prevRange ? prevById.get(r.id)?.revenue ?? 0 : null,
    prevBookings: prevRange ? prevById.get(r.id)?.bookings ?? 0 : null,
  });

  return [
    ...rows.map(withPrev),
    ...prevRows
      .filter((r) => !currentIds.has(r.id))
      .map((r) => withPrev({ id: r.id, name: r.name, country: r.country, ...zero })),
  ];
}

async function getAnalysisGroup(range, filters, column) {
  const { where, values } = analysisWhere(range, filters);
  const { rows } = await pool.query(
    `SELECT ${column} AS group_key,
       COUNT(*) AS bookings,
       COALESCE(SUM(CASE WHEN ${REVENUE_STATUS_EXCLUSION} THEN b.deposit_paid ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(b.total_price), 0) AS value
     ${ANALYSIS_FROM}
     ${where}
     GROUP BY 1
     ORDER BY revenue DESC, bookings DESC`,
    values
  );
  return rows.map((r) => ({ key: r.group_key, bookings: Number(r.bookings), revenue: Number(r.revenue), value: Number(r.value) }));
}

// Filter dropdown options — every package/agency/country that has at least
// one FD booking, independent of the selected range so the dropdowns don't
// reshuffle while the admin changes the period.
async function getAnalysisOptions() {
  const [{ rows: packages }, { rows: agencies }, { rows: countries }] = await Promise.all([
    pool.query(
      `SELECT DISTINCT fp.id, fp.title
       ${ANALYSIS_FROM}
       WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} AND fp.id IS NOT NULL
       ORDER BY fp.title`
    ),
    pool.query(
      `SELECT DISTINCT a.id, a.name
       ${ANALYSIS_FROM}
       WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE}
       ORDER BY a.name`
    ),
    pool.query(
      `SELECT DISTINCT a.country
       ${ANALYSIS_FROM}
       WHERE b.source_type = 'fd_package' AND ${STATS_SCOPE} AND a.country IS NOT NULL AND a.country <> ''
       ORDER BY a.country`
    ),
  ]);
  return {
    packages: packages.map((r) => ({ id: r.id, title: r.title })),
    agencies: agencies.map((r) => ({ id: r.id, name: r.name })),
    countries: countries.map((r) => r.country),
  };
}

async function getRevenueAnalysis({
  dateFrom,
  dateTo,
  prevFrom,
  prevTo,
  granularity,
  country,
  agencyId,
  packageId,
  createdVia,
  status,
  search,
  includeOptions,
  breakdownLimit,
} = {}) {
  const filters = buildAnalysisFilters({ country, agencyId, packageId, createdVia, status, search });
  const today = ymdUtc(new Date());

  // "All time" — start at the first matching booking (or today if none).
  let from = dateFrom;
  if (!from) {
    const { where, values } = analysisWhere({}, filters);
    const { rows } = await pool.query(
      `SELECT DATE_FORMAT(MIN(b.created_at), '%Y-%m-%d') AS first_day ${ANALYSIS_FROM} ${where}`,
      values
    );
    from = rows[0].first_day || today;
  }
  const to = dateTo || today;
  const range = { dateFrom: from, dateTo: to };

  // Comparison range: explicit, else the same-length period right before.
  // "All time" has no meaningful previous period.
  let prevRange = null;
  if (prevFrom && prevTo) prevRange = { dateFrom: prevFrom, dateTo: prevTo };
  else if (dateFrom) {
    const len = daysBetween(from, to);
    const pTo = addDays(parseYmd(from), -1);
    prevRange = { dateFrom: ymdUtc(addDays(pTo, -(len - 1))), dateTo: ymdUtc(pTo) };
  }

  const g = resolveGranularity(granularity, from, to);
  // Top-10 by default (Overview); the By Package / By Agent tabs ask for up
  // to 100 so they can list and paginate every row.
  const limit = Math.max(1, Math.min(100, Number(breakdownLimit) || 10));

  const [current, previous, trendMap, prevTrendMap, abandonedMap, topPackages, topAgencies, byCountry, byStatus, byChannel, options] =
    await Promise.all([
      getAnalysisKpis(range, filters),
      prevRange ? getAnalysisKpis(prevRange, filters) : Promise.resolve(null),
      getAnalysisTrendRows(range, filters, g),
      prevRange ? getAnalysisTrendRows(prevRange, filters, g) : Promise.resolve(new Map()),
      getAbandonedByPackage(range, filters, g),
      getAnalysisBreakdown(range, prevRange, filters, { idColumn: 'fp.id', nameColumn: "COALESCE(fp.title, 'Unknown package')", limit }),
      getAnalysisBreakdown(range, prevRange, filters, { idColumn: 'a.id', nameColumn: 'a.name', countryColumn: 'a.country', limit }),
      getAnalysisGroup(range, filters, "COALESCE(NULLIF(a.country, ''), 'Unknown')"),
      getAnalysisGroup(range, filters, 'b.status'),
      getAnalysisGroup(range, filters, 'b.created_via'),
      includeOptions ? getAnalysisOptions() : Promise.resolve(null),
    ]);

  const buckets = listBuckets(from, to, g);
  const prevBuckets = prevRange ? listBuckets(prevRange.dateFrom, prevRange.dateTo, g) : [];
  const empty = { bookings: 0, revenue: 0, bookedValue: 0, outstanding: 0, pax: 0, abandoned: 0, abandonedValue: 0 };
  const trend = buckets.map((bucket, i) => {
    const cur = trendMap.get(bucket) || empty;
    const prevBucket = prevBuckets[i];
    const prev = prevBucket ? prevTrendMap.get(prevBucket) || empty : null;
    return {
      bucket,
      ...cur,
      abandonedByPackage: abandonedMap.get(bucket) || [],
      prevBucket: prevBucket || null,
      prevRevenue: prev ? prev.revenue : null,
      prevBookings: prev ? prev.bookings : null,
    };
  });

  return {
    range,
    previousRange: prevRange,
    granularity: g,
    kpis: { current, previous },
    trend,
    topPackages,
    topAgencies,
    byCountry: byCountry.map(({ key, ...r }) => ({ country: key, ...r })),
    byStatus: byStatus.map(({ key, ...r }) => ({ status: key, ...r })),
    byChannel: byChannel.map(({ key, ...r }) => ({ createdVia: key, ...r })),
    ...(options ? { options } : {}),
  };
}

module.exports.getRevenueAnalysis = getRevenueAnalysis;

// ---- Visa fee revenue (Revenue page → Visa tab) ------------------------------
// Confirmed visa_payments (0127_visa_payments.sql) by the day they were paid,
// with the same range / comparison / bucket rules as getRevenueAnalysis so
// the tabs line up. Row shapes reuse the booking analysis keys the shared
// revenue components read (bookings = applications paid, pax = travellers).
async function getVisaRevenueAnalysis({ dateFrom, dateTo, prevFrom, prevTo, granularity } = {}) {
  const visa = require('./visaPayments.model.js');
  const today = ymdUtc(new Date());
  const from = dateFrom || (await visa.firstVisaPaymentDay()) || today;
  const to = dateTo || today;
  const range = { dateFrom: from, dateTo: to };

  let prevRange = null;
  if (prevFrom && prevTo) prevRange = { dateFrom: prevFrom, dateTo: prevTo };
  else if (dateFrom) {
    const len = daysBetween(from, to);
    const pTo = addDays(parseYmd(from), -1);
    prevRange = { dateFrom: ymdUtc(addDays(pTo, -(len - 1))), dateTo: ymdUtc(pTo) };
  }
  const g = resolveGranularity(granularity, from, to);

  // Older applications group by visa type/category; package-based ones
  // (0130) by their copied package details — "30-day visa", then
  // "30-day visa · Single-Entry".
  const visaJoins =
    'LEFT JOIN visa_types vt ON vt.id = va.visa_type_id LEFT JOIN visa_categories vc ON vc.id = va.visa_category_id';
  const typeName = "COALESCE(vt.name, CONCAT(va.package_duration_days, '-day visa'))";
  const categoryName = `CONCAT(${typeName}, ' · ', COALESCE(vc.name, va.package_entry_type))`;
  const byTypeCols = { idColumn: `COALESCE(vt.id, ${typeName})`, nameColumn: typeName, join: visaJoins };
  const byCategoryCols = { idColumn: `COALESCE(vc.id, ${categoryName})`, nameColumn: categoryName, join: visaJoins };
  const byAgencyCols = { idColumn: 'ag.id', nameColumn: 'ag.name', join: 'JOIN agencies ag ON ag.id = vp.agency_id' };

  const [current, previous, trendMap, prevTrendMap, byType, prevByType, byCategory, byAgency, prevByAgency] = await Promise.all([
    visa.getVisaRevenueKpis(range),
    prevRange ? visa.getVisaRevenueKpis(prevRange) : Promise.resolve(null),
    visa.getVisaRevenueTrend(range, g),
    prevRange ? visa.getVisaRevenueTrend(prevRange, g) : Promise.resolve(new Map()),
    visa.getVisaRevenueGroup(range, byTypeCols),
    prevRange ? visa.getVisaRevenueGroup(prevRange, byTypeCols) : Promise.resolve([]),
    visa.getVisaRevenueGroup(range, byCategoryCols),
    visa.getVisaRevenueGroup(range, byAgencyCols),
    prevRange ? visa.getVisaRevenueGroup(prevRange, byAgencyCols) : Promise.resolve([]),
  ]);

  const buckets = listBuckets(from, to, g);
  const prevBuckets = prevRange ? listBuckets(prevRange.dateFrom, prevRange.dateTo, g) : [];
  const empty = { revenue: 0, applications: 0, travellers: 0 };
  const trend = buckets.map((bucket, i) => {
    const cur = trendMap.get(bucket) || empty;
    const prevBucket = prevBuckets[i];
    const prev = prevBucket ? prevTrendMap.get(prevBucket) || empty : null;
    return {
      bucket,
      revenue: cur.revenue,
      bookedValue: cur.revenue,
      bookings: cur.applications,
      pax: cur.travellers,
      prevBucket: prevBucket || null,
      prevRevenue: prev ? prev.revenue : null,
      prevBookings: prev ? prev.applications : null,
    };
  });

  const withPrev = (rows, prevRows) => {
    const prevById = new Map(prevRows.map((r) => [r.id, r.revenue]));
    return rows.map((r) => ({ ...r, bookings: r.applications, pax: r.travellers, prevRevenue: prevRange ? prevById.get(r.id) || 0 : null }));
  };

  return {
    range,
    previousRange: prevRange,
    granularity: g,
    kpis: { current, previous },
    trend,
    byType: withPrev(byType, prevByType),
    byCategory: byCategory.map((r) => ({ ...r, bookings: r.applications, pax: r.travellers })),
    byAgency: withPrev(byAgency, prevByAgency),
    byMethod: [
      { method: 'cashfree', revenue: current.cardAmount, bookings: current.cardPayments },
      { method: 'neft', revenue: current.neftAmount, bookings: current.neftPayments },
    ],
  };
}

module.exports.getVisaRevenueAnalysis = getVisaRevenueAnalysis;
