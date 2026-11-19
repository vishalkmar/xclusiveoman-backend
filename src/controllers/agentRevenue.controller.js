const {
  getSummary,
  getSpendByMonth,
  getSpendByPackage,
  getPaymentsOverview
} = require('../models/agentRevenue.model.js');

// Agent Portal Revenue page. Mounted under /bookings/revenue (bookings.routes.js,
// requireAuth + requireRole('agency_owner', 'agency_staff') already applied
// there), so req.user is always the authenticated agent. agencyId is always
// req.user.agency_id — never read from req.query/req.body — so there is no
// way for an agent to request another agency's numbers.

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

async function summary(req, res, next) {
  try {
    const { dateFrom, dateTo } = req.query;
    const data = await getSummary({ agencyId: req.user.agency_id, dateFrom, dateTo });
    res.json({ range: { dateFrom: dateFrom || null, dateTo: dateTo || null }, ...data });
  } catch (err) {
    next(err);
  }
}

module.exports.summary = summary;

async function spendByMonth(req, res, next) {
  try {
    let { dateFrom, dateTo } = req.query;

    if (!dateFrom || !dateTo) {
      const now = new Date();
      const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
      dateFrom = dateFrom || toYmd(defaultFrom);
      dateTo = dateTo || toYmd(now);
    }

    const months = await getSpendByMonth({ agencyId: req.user.agency_id, dateFrom, dateTo });
    res.json({ range: { dateFrom, dateTo }, months });
  } catch (err) {
    next(err);
  }
}

module.exports.spendByMonth = spendByMonth;

async function spendByPackage(req, res, next) {
  try {
    const { dateFrom, dateTo, search, page, pageSize } = req.query;
    const { rows, total, page: currentPage, pageSize: limit } = await getSpendByPackage({
      agencyId: req.user.agency_id,
      dateFrom,
      dateTo,
      search,
      page,
      pageSize,
    });

    res.json({
      range: { dateFrom: dateFrom || null, dateTo: dateTo || null },
      packages: rows,
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.spendByPackage = spendByPackage;

async function paymentsOverview(req, res, next) {
  try {
    const { dateFrom, dateTo, status } = req.query;
    const data = await getPaymentsOverview({ agencyId: req.user.agency_id, dateFrom, dateTo, status });
    res.json({ range: { dateFrom: dateFrom || null, dateTo: dateTo || null }, ...data });
  } catch (err) {
    next(err);
  }
}

module.exports.paymentsOverview = paymentsOverview;
