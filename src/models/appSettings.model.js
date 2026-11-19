const {
  pool
} = require('../db/pool.js');

// Portal-wide admin settings (0108_fd_prebooking_settings.sql), one JSON value
// per key.
async function getSetting(key) {
  const { rows } = await pool.query('SELECT setting_value FROM app_settings WHERE setting_key = ?', [key]);
  if (!rows[0]) return null;
  const value = rows[0].setting_value;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

module.exports.getSetting = getSetting;

async function setSetting(key, value, updatedByUserId) {
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by_user_id, updated_at)
     VALUES (?, ?, ?, now())
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
       updated_by_user_id = VALUES(updated_by_user_id), updated_at = now()`,
    [key, JSON.stringify(value), updatedByUserId || null]
  );
  return getSetting(key);
}

module.exports.setSetting = setSetting;
