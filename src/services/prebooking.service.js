const {
  getSetting,
  setSetting
} = require('../models/appSettings.model.js');

// FD pre-booking (deposit) rule, set by the admin in Payments → Package
// Controller (0108_fd_prebooking_settings.sql). A global on/off + percentage,
// which each FD package either follows ('global') or overrides ('none' =
// full amount up front, 'custom' = its own percentage).
const SETTING_KEY = 'fd_prebooking';
const DEFAULT_SETTINGS = { enabled: true, percentage: 10 };

async function getFdPrebookingSettings() {
  const stored = await getSetting(SETTING_KEY);
  return {
    enabled: stored?.enabled ?? DEFAULT_SETTINGS.enabled,
    percentage: Number(stored?.percentage ?? DEFAULT_SETTINGS.percentage),
  };
}

module.exports.getFdPrebookingSettings = getFdPrebookingSettings;

async function saveFdPrebookingSettings({ enabled, percentage }, updatedByUserId) {
  await setSetting(SETTING_KEY, { enabled, percentage }, updatedByUserId);
  return getFdPrebookingSettings();
}

module.exports.saveFdPrebookingSettings = saveFdPrebookingSettings;

// The percentage of the total an agent pays now to hold seats on this
// package, or null when there's no pre-booking (the full amount is due).
function resolvePrebookingPercentage(fdPackage, settings) {
  const mode = fdPackage.prebooking_mode || 'global';
  if (mode === 'none') return null;
  if (mode === 'custom') {
    const pct = Number(fdPackage.prebooking_percentage);
    return Number.isFinite(pct) && pct > 0 ? pct : null;
  }
  return settings.enabled ? settings.percentage : null;
}

module.exports.resolvePrebookingPercentage = resolvePrebookingPercentage;

const PLATFORM_FEE_KEY = 'fd_platform_fee';
const DEFAULT_PLATFORM_FEE = { enabled: true, percentage: 4 };

async function getFdPlatformFeeSettings() {
  const stored = await getSetting(PLATFORM_FEE_KEY);
  return {
    enabled: stored?.enabled ?? DEFAULT_PLATFORM_FEE.enabled,
    percentage: Number(stored?.percentage ?? DEFAULT_PLATFORM_FEE.percentage),
  };
}

module.exports.getFdPlatformFeeSettings = getFdPlatformFeeSettings;

async function saveFdPlatformFeeSettings({ enabled, percentage }, updatedByUserId) {
  await setSetting(PLATFORM_FEE_KEY, { enabled, percentage }, updatedByUserId);
  return getFdPlatformFeeSettings();
}

module.exports.saveFdPlatformFeeSettings = saveFdPlatformFeeSettings;

function resolvePlatformFeePercentage(fdPackage, settings) {
  const mode = fdPackage.platform_fee_mode || 'global';
  if (mode === 'none') return 0;
  if (mode === 'custom') {
    const pct = Number(fdPackage.platform_fee_percentage);
    return Number.isFinite(pct) && pct > 0 ? pct : 0;
  }
  return settings.enabled ? settings.percentage : 0;
}

function applyPlatformFee(ratePerPax, percentage) {
  const rate = Number(ratePerPax) || 0;
  // Two decimal places, matching how amounts are shown - never rounded to a
  // whole number.
  return Math.round((rate + (rate * Number(percentage || 0)) / 100) * 100) / 100;
}

module.exports.resolvePlatformFeePercentage = resolvePlatformFeePercentage;
module.exports.applyPlatformFee = applyPlatformFee;
