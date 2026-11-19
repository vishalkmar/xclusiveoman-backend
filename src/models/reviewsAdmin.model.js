const {
  pool
} = require('../db/pool.js');

// Admin Reviews Management (Task 21 — Item 33, Screen 33, REV-3/REV-4).
// Deliberately its own model rather than forced onto catalog.model.js's
// createCrudModel() — same reasoning Item 34's cms.model.js already
// documented: this needs status/rating/search filtering + pagination +ollup
// math the generic factory has no concept of. Reuses the exact
// {rows, total, page, pageSize} pagination shape and buildFilters/JOINS
// structure bookingsAdmin.model.js already established (Task 13), not a new
// pattern.

// bookings/fd_departure_dates/users are LEFT JOINs — they only add the
// reviewer (the booking's creator) and destination (the departure's
// location) to each row, and must never drop a review.
const JOINS = `
  FROM reviews r
  JOIN agencies a ON a.id = r.agency_id
  JOIN fd_packages fp ON fp.id = r.fd_package_id
  LEFT JOIN bookings b ON b.id = r.booking_id
  LEFT JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
  LEFT JOIN users u ON u.id = b.created_by_user_id
  WHERE 1=1
`;

const SELECT_COLUMNS = `
  r.*,
  a.name AS agency_name,
  fp.title AS package_title,
  fdd.location AS destination,
  u.full_name AS reviewer_name
`;

// Admin Reviews Management filters — all server-side:
//   status / rating: exact match
//   fdPackageId:     one FD package
//   destination:     exact fd_departure_dates.location
//   dateFrom/dateTo: submitted_at, dateTo inclusive of the whole day
//   search:          agency, package, destination, reviewer or review text
function buildFilters({ status, rating, search, fdPackageId, destination, dateFrom, dateTo }) {
  const clauses = [];
  const values = [];

  if (status) {
    clauses.push(`r.status = ?`);
    values.push(status);
  }
  if (rating) {
    clauses.push(`r.rating = ?`);
    values.push(Number(rating));
  }
  if (fdPackageId) {
    clauses.push(`r.fd_package_id = ?`);
    values.push(fdPackageId);
  }
  if (destination) {
    clauses.push(`fdd.location = ?`);
    values.push(destination);
  }
  if (dateFrom) {
    clauses.push(`r.submitted_at >= ?`);
    values.push(dateFrom);
  }
  if (dateTo) {
    clauses.push(`r.submitted_at < (? + INTERVAL 1 DAY)`);
    values.push(dateTo);
  }
  if (search) {
    const like = `%${search}%`;
    clauses.push(
      `(LOWER(a.name) LIKE LOWER(?) OR LOWER(fp.title) LIKE LOWER(?) OR LOWER(fdd.location) LIKE LOWER(?) OR LOWER(u.full_name) LIKE LOWER(?) OR LOWER(r.review_text) LIKE LOWER(?))`
    );
    values.push(like, like, like, like, like);
  }

  const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  return { where, values };
}

async function listReviewsForAdmin({ page, pageSize, ...filters } = {}) {
  const { where, values } = buildFilters(filters);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS count ${JOINS} ${where}`, values);
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${JOINS} ${where}
     ORDER BY r.submitted_at DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return { rows, total, page: currentPage, pageSize: limit };
}

module.exports.listReviewsForAdmin = listReviewsForAdmin;

// Headline numbers for the Reviews Management stat cards and Rating
// Overview — across every review, independent of the list's filters.
async function getReviewStatsForAdmin() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'needs_review'), 0) AS pending,
            COALESCE(SUM(status = 'published'), 0) AS published,
            COALESCE(SUM(status = 'hidden'), 0) AS hidden,
            ROUND(AVG(rating), 1) AS average_rating
     FROM reviews`
  );
  const { rows: ratingRows } = await pool.query(
    `SELECT rating, COUNT(*) AS count FROM reviews GROUP BY rating`
  );
  const byRating = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of ratingRows) byRating[row.rating] = Number(row.count);
  const s = rows[0];
  return {
    total: Number(s.total),
    pending: Number(s.pending),
    published: Number(s.published),
    hidden: Number(s.hidden),
    averageRating: s.average_rating == null ? 0 : Number(s.average_rating),
    byRating,
  };
}

module.exports.getReviewStatsForAdmin = getReviewStatsForAdmin;

// Options for the Destination and FD Package dropdowns — only values that
// actually appear on a review, so every option matches at least one row.
async function listReviewFilterOptions() {
  const [{ rows: destinationRows }, { rows: packageRows }] = await Promise.all([
    pool.query(
      `SELECT DISTINCT fdd.location AS value ${JOINS} AND fdd.location IS NOT NULL ORDER BY value`
    ),
    pool.query(
      `SELECT DISTINCT fp.id, fp.title ${JOINS} ORDER BY fp.title`
    ),
  ]);
  return {
    destinations: destinationRows.map((r) => r.value),
    packages: packageRows.map((r) => ({ id: r.id, title: r.title })),
  };
}

module.exports.listReviewFilterOptions = listReviewFilterOptions;

async function findReviewByIdForAdmin(id) {
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLUMNS} ${JOINS} AND r.id = ?`,
    [id]
  );
  return rows[0] || null;
}

module.exports.findReviewByIdForAdmin = findReviewByIdForAdmin;

async function createAdminReview({ fdPackageId, rating, reviewText, userId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: packages } = await client.query("SELECT id FROM fd_packages WHERE id = ? AND status = 'published'", [fdPackageId]);
    if (!packages[0]) { await client.query('ROLLBACK'); return null; }
    const { rows: agencies } = await client.query("SELECT id FROM agencies WHERE status = 'approved' ORDER BY created_at LIMIT 1");
    if (!agencies[0]) throw new Error('An approved agency is required to create a review.');
    const bookingId = require('../utils/id.js').newId();
    await client.query(`INSERT INTO bookings (id, source_type, source_id, agency_id, created_by_user_id, pax, total_price, deposit_paid, balance_due, status, created_via) VALUES (?, 'fd_package', ?, ?, ?, 1, 0, 0, 0, 'completed', 'manual_admin')`, [bookingId, fdPackageId, agencies[0].id, userId]);
    const reviewId = require('../utils/id.js').newId();
    await client.query(`INSERT INTO reviews (id, booking_id, fd_package_id, agency_id, rating, review_text, status) VALUES (?, ?, ?, ?, ?, ?, 'published')`, [reviewId, bookingId, fdPackageId, agencies[0].id, rating, reviewText || null]);
    await rollupPackageRating(client, fdPackageId);
    await client.query('COMMIT');
    return findReviewByIdForAdmin(reviewId);
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}

module.exports.createAdminReview = createAdminReview;

async function listPublishedPackagesForReview(search = '') {
  const term = String(search || '').trim();
  const where = term ? ' AND LOWER(title) LIKE LOWER(?)' : '';
  const values = term ? [`%${term}%`] : [];
  const { rows } = await pool.query(`SELECT id, title, type, hero_image_url, duration, category, short_description FROM fd_packages WHERE status = 'published'${where} ORDER BY title`, values);
  return rows;
}

module.exports.listPublishedPackagesForReview = listPublishedPackagesForReview;

// Recomputes fd_packages.rating/review_count from `published` reviews only
// (REV-4 — hidden/needs_review reviews must never affect the average) and
// writes both columns, all within the given transaction client. ROUND(...,
// 2) matches the task's own worked example (5,4,4 -> 4.33) — fd_packages.
// rating is a bare NUMERIC with no declared scale (checked via
// information_schema before writing this), so nothing at the column level
// forces rounding; this is an explicit, deliberate choice, not a DB
// constraint. COUNT/AVG naturally return 0/NULL over zero rows, which
// COALESCE turns into exactly the documented 0/0 case.
async function rollupPackageRating(client, fdPackageId) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS review_count, ROUND(AVG(rating), 2) AS avg_rating
     FROM reviews WHERE fd_package_id = ? AND status = 'published'`,
    [fdPackageId]
  );
  const { review_count: reviewCount, avg_rating: avgRating } = rows[0];
  // Postgres' explicit ::numeric/::integer casts on these two COALESCE(...)
  // targets dropped — that requirement was Postgres inferring a shared type
  // for $1/$2 from the untyped `0` literal shared by both COALESCE calls in
  // one statement (see cms.model.js#createCmsPage's own comment for the same
  // class of gotcha); MySQL has no such cross-parameter type inference, so
  // COALESCE(?, 0) just resolves against each target column's own type here.
  await client.query(
    `UPDATE fd_packages SET rating = COALESCE(?, 0), review_count = COALESCE(?, 0), updated_at = now() WHERE id = ?`,
    [avgRating, reviewCount, fdPackageId]
  );
}

async function setReviewStatus(id, status) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query('SELECT * FROM reviews WHERE id = ? FOR UPDATE', [id]);
    const existing = existingRows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }

    if (existing.status === status) {
      await client.query('ROLLBACK');
      return { review: existing, changed: false };
    }

    await client.query('UPDATE reviews SET status = ? WHERE id = ?', [status, id]);
    const { rows: updatedRows } = await client.query('SELECT * FROM reviews WHERE id = ?', [id]);
    const updated = updatedRows[0];

    await rollupPackageRating(client, updated.fd_package_id);

    await client.query('COMMIT');
    return { review: updated, changed: true, previousStatus: existing.status };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports.setReviewStatus = setReviewStatus;
