const {
  getSummary,
  getRevenueByMonth,
  getTopAgencies,
  getRevenueByPackage,
  getPaymentsOverview,
  getRevenueAnalysis,
  getVisaRevenueAnalysis
} = require('../models/analytics.model.js');

// Admin Analytics & Reporting (Task 19 — Screen 18, ANL-1). Mounted at
// /api/admin/analytics, requireRole('ops_admin', 'super_admin') per the
// doc's own §12.11 route annotation. Every number returned here comes from
// a real MySQL aggregation in analytics.model.js — no client-side
// reconstruction, no mock data. See that file's own header comment for the
// exact revenue definition and why transactions.amount is never summed.

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

async function summary(req, res, next) {
  try {
    const { dateFrom, dateTo, agencyId, country } = req.query;
    const data = await getSummary({ dateFrom, dateTo, agencyId, country });
    res.json({ range: { dateFrom: dateFrom || null, dateTo: dateTo || null }, ...data });
  } catch (err) {
    next(err);
  }
}

module.exports.summary = summary;

async function revenueByMonth(req, res, next) {
  try {
    const { agencyId, country } = req.query;
    let { dateFrom, dateTo } = req.query;

    if (!dateFrom || !dateTo) {
      const now = new Date();
      const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
      dateFrom = dateFrom || toYmd(defaultFrom);
      dateTo = dateTo || toYmd(now);
    }

    const months = await getRevenueByMonth({ dateFrom, dateTo, agencyId, country });
    res.json({ range: { dateFrom, dateTo }, months });
  } catch (err) {
    next(err);
  }
}

module.exports.revenueByMonth = revenueByMonth;

async function topAgencies(req, res, next) {
  try {
    const { dateFrom, dateTo, agencyId, country, search, page, pageSize } = req.query;
    const { rows, total, page: currentPage, pageSize: limit } = await getTopAgencies({
      dateFrom,
      dateTo,
      agencyId,
      country,
      search,
      page,
      pageSize,
    });

    res.json({
      range: { dateFrom: dateFrom || null, dateTo: dateTo || null },
      agencies: rows,
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.topAgencies = topAgencies;

// Admin Revenue page's By Package tab.
async function revenueByPackage(req, res, next) {
  try {
    const { dateFrom, dateTo, country, search, page, pageSize } = req.query;
    const { rows, total, page: currentPage, pageSize: limit } = await getRevenueByPackage({
      dateFrom,
      dateTo,
      country,
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

module.exports.revenueByPackage = revenueByPackage;

// Admin Revenue page's Payments Collected vs Outstanding tab.
async function paymentsOverview(req, res, next) {
  try {
    const { dateFrom, dateTo, agencyId, country, status, search } = req.query;
    const data = await getPaymentsOverview({ dateFrom, dateTo, agencyId, country, status, search });
    res.json({ range: { dateFrom: dateFrom || null, dateTo: dateTo || null }, ...data });
  } catch (err) {
    next(err);
  }
}

module.exports.paymentsOverview = paymentsOverview;

// Admin Revenue page — Overview tab and the Detailed Revenue Analysis page.
// See analytics.model.js#getRevenueAnalysis for what's returned.
async function revenueAnalysis(req, res, next) {
  try {
    const { dateFrom, dateTo, prevFrom, prevTo, granularity, country, agencyId, packageId, createdVia, status, search, includeOptions, breakdownLimit } =
      req.query;
    const data = await getRevenueAnalysis({
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
      includeOptions: includeOptions === '1' || includeOptions === 'true',
      breakdownLimit,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

module.exports.revenueAnalysis = revenueAnalysis;

// Admin Revenue page — Visa tab (visa fees collected).
async function visaRevenue(req, res, next) {
  try {
    const { dateFrom, dateTo, prevFrom, prevTo, granularity } = req.query;
    res.json(await getVisaRevenueAnalysis({ dateFrom, dateTo, prevFrom, prevTo, granularity }));
  } catch (err) {
    next(err);
  }
}

module.exports.visaRevenue = visaRevenue;
