const { pool } = require('../db/pool.js');

const {
  listItineraryForPackage,
  resolveRatePerPax,
  loadCatalogPools,
} = require('../models/fdPackages.model.js');

const {
  getFdPlatformFeeSettings,
  resolvePlatformFeePercentage,
  applyPlatformFee,
} = require('./prebooking.service.js');

// Keeps fd_packages.rate_with_fee / platform_fee_applied (0121) in step with
// what an agent would be quoted: the package's rate at the baseline headcount
// plus its platform fee (global setting, per-package override, or none).

function feeFieldsFor(row, items, pools, settings) {
  const net = resolveRatePerPax(row, items, pools);
  const percentage = resolvePlatformFeePercentage(row, settings);
  return { rateWithFee: applyPlatformFee(net, percentage), percentage };
}

function isStale(row, fields) {
  return (
    row.rate_with_fee == null ||
    row.platform_fee_applied == null ||
    Math.abs(Number(row.rate_with_fee) - fields.rateWithFee) > 0.0005 ||
    Math.abs(Number(row.platform_fee_applied) - fields.percentage) > 0.005
  );
}

// Writes the figures for one already-loaded row when they differ from what's
// stored, and mirrors them onto the row object so the caller can serialize it.
// Deliberately leaves updated_at alone: a recompute isn't an admin edit.
async function syncRowFeeRate(row, items, pools, settings) {
  const fields = feeFieldsFor(row, items, pools, settings);
  if (isStale(row, fields)) {
    await pool.query(
      'UPDATE fd_packages SET rate_with_fee = ?, platform_fee_applied = ? WHERE id = ?',
      [fields.rateWithFee, fields.percentage, row.id]
    );
    row.rate_with_fee = fields.rateWithFee;
    row.platform_fee_applied = fields.percentage;
  }
  return fields;
}

module.exports.syncRowFeeRate = syncRowFeeRate;

// Recomputes the given package ids, or every non-archived package when none
// are given (the global fee setting changed).
async function refreshFeeRates(ids) {
  const list = Array.isArray(ids) ? ids : ids ? [ids] : null;
  let rows;
  if (list) {
    if (list.length === 0) return 0;
    const placeholders = list.map(() => '?').join(', ');
    ({ rows } = await pool.query(`SELECT * FROM fd_packages WHERE id IN (${placeholders})`, list));
  } else {
    ({ rows } = await pool.query("SELECT * FROM fd_packages WHERE status <> 'archived'"));
  }
  if (rows.length === 0) return 0;

  const [pools, settings] = await Promise.all([loadCatalogPools(), getFdPlatformFeeSettings()]);
  for (const row of rows) {
    const { items } = await listItineraryForPackage(row.id);
    await syncRowFeeRate(row, items, pools, settings);
  }
  return rows.length;
}

module.exports.refreshFeeRates = refreshFeeRates;

// Same, but never lets a pricing refresh fail the admin action that triggered
// it - the next list/get read recomputes anyway.
async function refreshFeeRatesSafe(ids) {
  try {
    return await refreshFeeRates(ids);
  } catch (err) {
    console.error('[fdFeeRate] refresh failed', err);
    return 0;
  }
}

module.exports.refreshFeeRatesSafe = refreshFeeRatesSafe;
