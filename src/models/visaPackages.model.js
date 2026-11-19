const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');

// Visa packages (0129_visa_packages.sql) — admin-made visa cards.

async function listVisaPackages({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM visa_packages ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, duration_days, created_at`
  );
  return rows;
}

module.exports.listVisaPackages = listVisaPackages;

async function findVisaPackageById(id) {
  const { rows } = await pool.query('SELECT * FROM visa_packages WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findVisaPackageById = findVisaPackageById;

async function createVisaPackage({ durationDays, entryType, validForDays, maxStayDays, imageUrl, isActive = true, sortOrder = 0, priceMode, priceMethod, customPrice = null }) {
  priceMode = priceMethod || priceMode || 'global';
  const id = newId();
  await pool.query(
    `INSERT INTO visa_packages (id, duration_days, entry_type, valid_for_days, max_stay_days, image_url, price_mode, custom_price, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, durationDays, entryType, validForDays, maxStayDays, imageUrl, priceMode, priceMode === 'custom' ? customPrice : null, isActive ? 1 : 0, sortOrder]
  );
  return findVisaPackageById(id);
}

module.exports.createVisaPackage = createVisaPackage;

async function updateVisaPackage(id, { durationDays, entryType, validForDays, maxStayDays, imageUrl, isActive, sortOrder, priceMode, priceMethod, customPrice }) {
  priceMode = priceMethod || priceMode;
  await pool.query(
    `UPDATE visa_packages
     SET duration_days = ?, entry_type = ?, valid_for_days = ?, max_stay_days = ?,
         image_url = COALESCE(?, image_url), price_mode = COALESCE(?, price_mode), custom_price = CASE WHEN ? = 'custom' THEN ? ELSE NULL END,
         is_active = COALESCE(?, is_active), sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [durationDays, entryType, validForDays, maxStayDays, imageUrl ?? null, priceMode ?? null, priceMode ?? null, customPrice ?? null, isActive == null ? null : isActive ? 1 : 0, sortOrder ?? null, id]
  );
  return findVisaPackageById(id);
}

module.exports.updateVisaPackage = updateVisaPackage;

async function deleteVisaPackage(id) {
  const { rowCount } = await pool.query('DELETE FROM visa_packages WHERE id = ?', [id]);
  return rowCount > 0;
}

module.exports.deleteVisaPackage = deleteVisaPackage;
