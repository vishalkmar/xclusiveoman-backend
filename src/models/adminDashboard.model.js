const { pool } = require("../db/pool.js");

// Bookings that count towards dashboard stats — same rule as
// analytics.model.js's STATS_SCOPE: unpaid bookings (pending payment,
// waitlisted, or cancelled without ever being paid) are left out.
const STATS_SCOPE = "(status NOT IN ('pending_payment', 'waitlisted') AND NOT (status = 'cancelled' AND deposit_paid <= 0))";

async function getAdminDashboardStats() {
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  const dailyStart = new Date(todayUtc);
  dailyStart.setUTCDate(dailyStart.getUTCDate() - 29);
  const dailyEnd = new Date(todayUtc);
  dailyEnd.setUTCDate(dailyEnd.getUTCDate() + 1);
  const toYmd = (date) => date.toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM agencies) AS agent_count,
      (SELECT COUNT(*) FROM fd_packages WHERE status <> 'archived') AS fd_package_count,
      (SELECT COUNT(*) FROM reviews) AS review_count,
      (SELECT COUNT(*) FROM mice_rfqs) AS mice_count,
      (
        SELECT COUNT(*)
        FROM package_requests
        WHERE status <> 'draft'
      ) AS quote_count,
      (
        SELECT COUNT(*)
        FROM bookings
        WHERE source_type = 'fd_package'
          AND ${STATS_SCOPE}
      ) AS booking_count,
      (
        SELECT COUNT(*)
        FROM bookings
        WHERE source_type = 'fd_package'
          AND deposit_paid > 0
          AND status NOT IN ('cancelled', 'waitlisted')
      ) AS paid_booking_count,
      (
        SELECT COALESCE(SUM(deposit_paid), 0)
        FROM bookings
        WHERE source_type = 'fd_package'
          AND status NOT IN ('cancelled', 'waitlisted')
          AND created_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(
            CURRENT_DATE() + INTERVAL 1 MONTH,
            '%Y-%m-01'
          )
      ) AS revenue_this_month,
      (
        SELECT COUNT(*)
        FROM bookings
        WHERE source_type = 'fd_package'
          AND ${STATS_SCOPE}
          AND created_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          AND created_at < DATE_FORMAT(
            CURRENT_DATE() + INTERVAL 1 MONTH,
            '%Y-%m-01'
          )
      ) AS bookings_this_month,
      (
        SELECT COALESCE(SUM(refund_requested_amount), 0)
        FROM bookings
        WHERE source_type = 'fd_package'
          AND refund_requested_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
          AND refund_requested_at < DATE_FORMAT(
            CURRENT_DATE() + INTERVAL 1 MONTH,
            '%Y-%m-01'
          )
      ) AS refund_requests_this_month,
      (
        SELECT COUNT(*)
        FROM package_requests
        WHERE status IN ('submitted', 'assigned', 'costed', 'published', 'revision_requested')
      ) + (
        SELECT COUNT(*)
        FROM mice_rfqs
        WHERE status IN (
          'submitted',
          'rfp_dispatched',
          'supplier_responses_pending',
          'supplier_responses_received',
          'costed',
          'published',
          'revision_requested',
          'negotiating'
        )
      ) AS pending_quote_mice_count
  `);

  const [dailyResult, statusResult] = await Promise.all([
    pool.query(
      `SELECT
         DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
         COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'waitlisted') THEN deposit_paid ELSE 0 END), 0) AS revenue
       FROM bookings
       WHERE source_type = 'fd_package'
         AND created_at >= ?
         AND created_at < ?
       GROUP BY day
       ORDER BY day`,
      [toYmd(dailyStart), toYmd(dailyEnd)]
    ),
    pool.query(
      `SELECT
         COUNT(CASE WHEN status IN ('deposit_paid', 'confirmed', 'balance_due', 'fully_paid', 'completed') THEN 1 END) AS confirmed_count,
         COUNT(CASE WHEN status IN ('amendment_requested', 'cancellation_requested') THEN 1 END) AS pending_count
       FROM bookings
       WHERE source_type = 'fd_package'
         AND ${STATS_SCOPE}`
    ),
  ]);

  const dailyByDate = new Map(
    dailyResult.rows.map((row) => [row.day, Number(row.revenue)])
  );
  const revenueByDay = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(dailyStart);
    day.setUTCDate(day.getUTCDate() + index);
    const date = toYmd(day);
    return { date, revenue: dailyByDate.get(date) || 0 };
  });

  const stats = rows[0];
  const statusCounts = statusResult.rows[0];
  const bookingsThisMonth = Number(stats.bookings_this_month);
  const revenueThisMonth = Number(stats.revenue_this_month);
  return {
    agentCount: Number(stats.agent_count),
    fdPackageCount: Number(stats.fd_package_count),
    reviewCount: Number(stats.review_count),
    miceCount: Number(stats.mice_count),
    quoteCount: Number(stats.quote_count),
    bookingCount: Number(stats.booking_count),
    paidBookingCount: Number(stats.paid_booking_count),
    bookingsThisMonth,
    revenueThisMonth,
    averageBookingValue:
      bookingsThisMonth > 0 ? revenueThisMonth / bookingsThisMonth : 0,
    refundRequestedAmount: Number(stats.refund_requests_this_month),
    grossProfitAvailable: false,
    revenueByDay,
    bookingStatusCounts: [
      { status: "confirmed", count: Number(statusCounts.confirmed_count) },
      {
        status: "pending_payment",
        count: Number(statusCounts.pending_count),
      },
    ],
    pendingQuoteMiceCount: Number(stats.pending_quote_mice_count),
  };
}

module.exports.getAdminDashboardStats = getAdminDashboardStats;
