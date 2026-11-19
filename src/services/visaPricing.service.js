const {
  getSetting,
  setSetting
} = require('../models/appSettings.model.js');

// Visa price — ONE per-person price for every visa type and category, set by
// the admin in Payments → Package Controller → Visa. Stored in app_settings
// like the FD pre-booking / platform-fee settings (prebooking.service.js).
// Until the admin saves a price (or if it's cleared) the default applies.
const SETTING_KEY = 'visa_price';
const DEFAULT_VISA_PRICE = 8;

module.exports.DEFAULT_VISA_PRICE = DEFAULT_VISA_PRICE;

async function getVisaPrice() {
  const stored = await getSetting(SETTING_KEY);
  const price = stored?.pricePerPerson;
  return { pricePerPerson: price == null || !Number.isFinite(Number(price)) ? DEFAULT_VISA_PRICE : Number(price) };
}

module.exports.getVisaPrice = getVisaPrice;

async function saveVisaPrice({ pricePerPerson }, updatedByUserId) {
  await setSetting(
    SETTING_KEY,
    { pricePerPerson: pricePerPerson == null ? null : Math.round(pricePerPerson * 1000) / 1000 },
    updatedByUserId
  );
  return getVisaPrice();
}

async function getVisaPackagePrice(pkg) {
  const global = await getVisaPrice();
  return pkg?.price_mode === 'custom' && pkg.custom_price != null ? Number(pkg.custom_price) : global.pricePerPerson;
}

module.exports.saveVisaPrice = saveVisaPrice;
module.exports.getVisaPackagePrice = getVisaPackagePrice;
