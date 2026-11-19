const { refreshFeeRatesSafe } = require('../services/fdPackageFeeRate.service.js');
const {
  listFdPackagePrebooking,
  updateFdPackagePrebooking,
  updateFdPackagePlatformFee
} = require('../models/fdPackages.model.js');

const {
  getFdPrebookingSettings,
  saveFdPrebookingSettings,
  getFdPlatformFeeSettings,
  saveFdPlatformFeeSettings
} = require('../services/prebooking.service.js');

// Admin Payments → Package Controller (admin/pages/PackageController.jsx):
// the global FD pre-booking switch + percentage, and each FD package's
// override of it. See prebooking.service.js for how they combine.
function firstImage(row) {
  if (row.hero_image_url) return row.hero_image_url;
  const images = typeof row.images === 'string' ? JSON.parse(row.images || '[]') : row.images;
  return Array.isArray(images) && images.length ? images[0] : null;
}

function toPublicPackagePrebooking(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    imageUrl: firstImage(row),
    prebookingMode: row.prebooking_mode,
    prebookingPercentage: row.prebooking_percentage == null ? null : Number(row.prebooking_percentage),
    platformFeeMode: row.platform_fee_mode || 'global',
    platformFeePercentage: row.platform_fee_percentage == null ? null : Number(row.platform_fee_percentage),
    updatedAt: row.prebooking_updated_at,
    updatedByName: row.prebooking_updated_by_name || null,
    nextDepartureDate: row.next_departure_date || null,
  };
}

async function get(req, res, next) {
  try {
    const [settings, platformFee, packages] = await Promise.all([getFdPrebookingSettings(), getFdPlatformFeeSettings(), listFdPackagePrebooking()]);
    res.json({ settings, platformFee, packages: packages.map(toPublicPackagePrebooking) });
  } catch (err) {
    next(err);
  }
}

module.exports.get = get;

async function updateSettings(req, res, next) {
  try {
    const settings = await saveFdPrebookingSettings(req.body, req.user.id);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

module.exports.updateSettings = updateSettings;

// Kept separate from pre-booking settings so a platform-fee save can never
// alter the deposit rule that controls what agents pay at booking time.
async function updatePlatformFeeSettings(req, res, next) {
  try {
    const platformFee = await saveFdPlatformFeeSettings(req.body, req.user.id);
    // Every package on the global fee has a new price now.
    await refreshFeeRatesSafe();
    res.json({ platformFee });
  } catch (err) {
    next(err);
  }
}

module.exports.updatePlatformFeeSettings = updatePlatformFeeSettings;

async function updatePackage(req, res, next) {
  try {
    const [row] = await updateFdPackagePrebooking(req.params.id, req.body, req.user.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ package: toPublicPackagePrebooking(row) });
  } catch (err) {
    next(err);
  }
}

module.exports.updatePackage = updatePackage;

// Same change applied to every selected package at once.
async function updatePackages(req, res, next) {
  try {
    const { ids, ...setting } = req.body;
    const rows = await updateFdPackagePrebooking(ids, setting, req.user.id);
    res.json({ packages: rows.map(toPublicPackagePrebooking) });
  } catch (err) {
    next(err);
  }
}

module.exports.updatePackages = updatePackages;

async function updatePackagePlatformFee(req, res, next) {
  try {
    const [row] = await updateFdPackagePlatformFee(req.params.id, req.body, req.user.id);
    await refreshFeeRatesSafe([req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ package: toPublicPackagePrebooking(row) });
  } catch (err) { next(err); }
}

module.exports.updatePackagePlatformFee = updatePackagePlatformFee;

async function updatePackagesPlatformFee(req, res, next) {
  try {
    const { ids, ...setting } = req.body;
    const rows = await updateFdPackagePlatformFee(ids, setting, req.user.id);
    await refreshFeeRatesSafe(ids);
    res.json({ packages: rows.map(toPublicPackagePrebooking) });
  } catch (err) { next(err); }
}

module.exports.updatePackagesPlatformFee = updatePackagesPlatformFee;
