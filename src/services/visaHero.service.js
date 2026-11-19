const { getSetting, setSetting } = require('../models/appSettings.model.js');

// The agent Visa page's hero image — ONE image, set by the admin in Visa
// Setup. Not part of any visa package. Stored in app_settings like the visa
// price (visaPricing.service.js). null = none (the page shows its plain
// header).
const SETTING_KEY = 'visa_hero';

async function getVisaHero() {
  const stored = await getSetting(SETTING_KEY);
  return { imageUrl: stored?.imageUrl || null, updatedAt: stored?.updatedAt || null };
}

module.exports.getVisaHero = getVisaHero;

async function saveVisaHero(imageUrl, updatedByUserId) {
  await setSetting(SETTING_KEY, { imageUrl: imageUrl || null, updatedAt: new Date().toISOString() }, updatedByUserId);
  return getVisaHero();
}

module.exports.saveVisaHero = saveVisaHero;
