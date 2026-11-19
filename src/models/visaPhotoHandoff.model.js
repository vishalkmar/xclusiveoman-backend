const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');

// "Scan with phone" links (0131_visa_photo_handoffs.sql). Only the token's
// hash is stored; the raw token lives in the QR code alone.

const HANDOFF_MINUTES = 15;

module.exports.HANDOFF_MINUTES = HANDOFF_MINUTES;

// A new link for one traveller. Any earlier open link for the same traveller
// stops working, so only the newest QR code is live.
async function createHandoff({ applicationId, applicantId, agencyId, userId, tokenHash }) {
  await pool.query(
    `UPDATE visa_photo_handoffs SET status = 'cancelled'
     WHERE applicant_id = ? AND status IN ('pending', 'opened')`,
    [applicantId]
  );
  const id = newId();
  await pool.query(
    `INSERT INTO visa_photo_handoffs (id, application_id, applicant_id, agency_id, created_by_user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, now() + INTERVAL ${Number(HANDOFF_MINUTES)} MINUTE)`,
    [id, applicationId, applicantId, agencyId, userId, tokenHash]
  );
  return findHandoffForAgency(id, agencyId);
}

module.exports.createHandoff = createHandoff;

// `expired` / `seconds_left` come from the database clock, the same clock
// that set expires_at (so a server timezone difference can't skew them).
const HANDOFF_SELECT = `SELECT h.*, (h.expires_at <= now()) AS expired,
         GREATEST(TIMESTAMPDIFF(SECOND, now(), h.expires_at), 0) AS seconds_left
  FROM visa_photo_handoffs h`;

async function findHandoffForAgency(id, agencyId) {
  const { rows } = await pool.query(`${HANDOFF_SELECT} WHERE h.id = ? AND h.agency_id = ?`, [id, agencyId]);
  return rows[0] || null;
}

module.exports.findHandoffForAgency = findHandoffForAgency;

async function findHandoffByTokenHash(tokenHash) {
  const { rows } = await pool.query(`${HANDOFF_SELECT} WHERE h.token_hash = ?`, [tokenHash]);
  return rows[0] || null;
}

module.exports.findHandoffByTokenHash = findHandoffByTokenHash;

async function markHandoffOpened(id) {
  await pool.query(
    `UPDATE visa_photo_handoffs SET status = 'opened', opened_at = COALESCE(opened_at, now())
     WHERE id = ? AND status = 'pending'`,
    [id]
  );
}

module.exports.markHandoffOpened = markHandoffOpened;

async function markHandoffCompleted(id) {
  await pool.query(
    `UPDATE visa_photo_handoffs SET status = 'completed', completed_at = now()
     WHERE id = ? AND status IN ('pending', 'opened')`,
    [id]
  );
}

module.exports.markHandoffCompleted = markHandoffCompleted;

async function cancelHandoff(id, agencyId) {
  await pool.query(
    `UPDATE visa_photo_handoffs SET status = 'cancelled'
     WHERE id = ? AND agency_id = ? AND status IN ('pending', 'opened')`,
    [id, agencyId]
  );
}

module.exports.cancelHandoff = cancelHandoff;
