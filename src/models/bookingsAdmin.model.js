const {
  pool
} = require('../db/pool.js');

// Admin Bookings & Documents (Task 13 — Screen 22, Manual Booking Flow).
// FD-only by construction, same scoping rule as fdOperations.model.js: this
// list is source_type='fd_package' only — package_request/mice_rfq bookings
// don't exist yet anywhere in this codebase (see Task 13's own audit), so
// this filter costs nothing today and stops a future FIT/MICE bookings row
// from silently appearing in an FD-shaped table before this page is taught
// how to render one. Shows both created_via values (self_service and
// manual_admin) — an admin managing bookings needs to see all of them, not
// just the ones they personally created.

const JOINS = `
  FROM bookings b
  JOIN agencies a ON a.id = b.agency_id
  JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
  JOIN fd_packages fp ON fp.id = fdd.fd_package_id
  JOIN users u ON u.id = b.created_by_user_id
  WHERE b.source_type = 'fd_package'
`;

const SELECT_COLUMNS = `
  b.*,
  a.name AS agency_name,
  fp.id AS fd_package_id,
  fp.title AS package_title,
  fdd.date AS departure_date,
  fdd.location AS departure_location,
  u.full_name AS created_by_name
`;

// `agencyIds` (plural, array) is the Team Portal's Relationship Manager
// scoping (bookingsAdmin.routes.js's own `scopeToOwnAgencyBooking` comment) —
// distinct from `agencyId` (singular), the existing admin UI's own
// single-agency filter dropdown. Both can be present; each is its own
// independent AND'd clause.
//
// The Package tab's own filters (admin BookingsDocuments.jsx):
//   - packageSearch: package title or departure location only — unlike
//     `search`, which also matches the agency name for the Payments tab.
//   - destination: exact fd_departure_dates.location.
//   - packageType: exact fd_packages.theme (FD_THEMES on the frontend).
//   - departureFrom/departureTo: the trip's departure date (fdd.date), not
//     when the booking was made (dateFrom/dateTo filter created_at).
function buildFilters({
  status,
  agencyId,
  agencyIds,
  search,
  packageSearch,
  destination,
  packageType,
  dateFrom,
  dateTo,
  departureFrom,
  departureTo,
}) {
  const clauses = [];
  const values = [];

  if (status) {
    clauses.push(`b.status = ?`);
    values.push(status);
  }
  if (agencyId) {
    clauses.push(`b.agency_id = ?`);
    values.push(agencyId);
  }
  if (agencyIds) {
    clauses.push(`b.agency_id IN (?)`);
    values.push(agencyIds);
  }
  if (search) {
    clauses.push(`(LOWER(a.name) LIKE LOWER(?) OR LOWER(fp.title) LIKE LOWER(?))`);
    values.push(`%${search}%`, `%${search}%`);
  }
  if (packageSearch) {
    clauses.push(`(LOWER(fp.title) LIKE LOWER(?) OR LOWER(fdd.location) LIKE LOWER(?))`);
    values.push(`%${packageSearch}%`, `%${packageSearch}%`);
  }
  if (destination) {
    clauses.push(`fdd.location = ?`);
    values.push(destination);
  }
  if (packageType) {
    clauses.push(`fp.theme = ?`);
    values.push(packageType);
  }
  if (departureFrom) {
    clauses.push(`fdd.date >= ?`);
    values.push(departureFrom);
  }
  if (departureTo) {
    clauses.push(`fdd.date <= ?`);
    values.push(departureTo);
  }
  // Same inclusive-end-day convention as analytics.model.js's own
  // buildDateFilters — dateTo covers the whole calendar day, not just 00:00.
  if (dateFrom) {
    clauses.push(`b.created_at >= ?`);
    values.push(dateFrom);
  }
  if (dateTo) {
    clauses.push(`b.created_at < (? + INTERVAL 1 DAY)`);
    values.push(dateTo);
  }

  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  return { where, values };
}

async function listBookingsForAdmin({ page, pageSize, ...filters } = {}) {
  const { where, values } = buildFilters(filters);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS count ${JOINS} ${where}`, values);
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${JOINS} ${where}
     ORDER BY b.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return { rows, total, page: currentPage, pageSize: limit };
}

module.exports.listBookingsForAdmin = listBookingsForAdmin;

// Options for the Package tab's Destination / Package Type dropdowns —
// only values that actually appear on a booking, so every option returns
// at least one row. `agencyIds` is the same Relationship Manager scoping
// listBookingsForAdmin takes.
async function listBookingFilterOptions({ agencyIds } = {}) {
  const { where, values } = buildFilters({ agencyIds });
  const [{ rows: destinationRows }, { rows: typeRows }] = await Promise.all([
    pool.query(
      `SELECT DISTINCT fdd.location AS value ${JOINS} ${where} AND fdd.location IS NOT NULL ORDER BY value`,
      values
    ),
    pool.query(
      `SELECT DISTINCT fp.theme AS value ${JOINS} ${where} AND fp.theme IS NOT NULL AND fp.theme <> '' ORDER BY value`,
      values
    ),
  ]);
  return {
    destinations: destinationRows.map((r) => r.value),
    packageTypes: typeRows.map((r) => r.value),
  };
}

module.exports.listBookingFilterOptions = listBookingFilterOptions;

async function findBookingDetailForAdmin(bookingId) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS}
     ${JOINS} AND b.id = ?`,
    [bookingId]
  );
  return rows[0] || null;
}

module.exports.findBookingDetailForAdmin = findBookingDetailForAdmin;
