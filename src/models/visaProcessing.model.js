const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');
const { visaLabelSql } = require('./visa.model.js');

// Admin visa processing (0128_visa_processing.sql): the admin Visa Status
// list, the per-agency Visa Requests cards, one request's detail, and the
// per-traveller visa decisions (issue / remove / reject) with their
// tracking events. Drafts are never shown to the admin — an application
// appears once the agent has paid (or sent an NEFT slip for) it.

// Statuses the admin can act on (upload/remove/reject visas). Drafts and
// unpaid NEFT applications ('payment_review') aren't paid for yet.
const WORKABLE = "('submitted', 'processing', 'approved', 'rejected')";

// Traveller tallies per application, joined onto every admin read.
const COUNTS = `
  SELECT application_id,
         COUNT(*) AS travellers,
         SUM(visa_status = 'issued') AS issued,
         SUM(visa_status = 'rejected') AS rejected,
         GROUP_CONCAT(full_name ORDER BY position SEPARATOR '|') AS traveller_names
  FROM visa_applicants GROUP BY application_id`;

const ADMIN_SELECT = `
  SELECT va.*,
         ${visaLabelSql()},
         vc.processing_time AS visa_category_processing_time,
         ag.name AS agency_name, ag.country AS agency_country, ag.logo_asset_url AS agency_logo_url,
         u.full_name AS created_by_name, u.email AS created_by_email, u.phone AS created_by_phone,
         COALESCE(c.travellers, 0) AS travellers,
         COALESCE(c.issued, 0) AS visas_issued,
         COALESCE(c.rejected, 0) AS visas_rejected,
         c.traveller_names
  FROM visa_applications va
  JOIN agencies ag ON ag.id = va.agency_id
  LEFT JOIN visa_types vt ON vt.id = va.visa_type_id
  LEFT JOIN visa_categories vc ON vc.id = va.visa_category_id
  LEFT JOIN users u ON u.id = va.created_by_user_id
  LEFT JOIN (${COUNTS}) c ON c.application_id = va.id`;

// When an application was applied for: paid/submitted, else created.
const APPLIED_AT = 'COALESCE(va.submitted_at, va.created_at)';

// Shared WHERE for the Visa Status list and its status counts.
function filterClauses({ agencyId, days, search, status } = {}) {
  const clauses = ["va.status <> 'draft'"];
  const values = [];
  if (status) {
    clauses.push('va.status = ?');
    values.push(status);
  }
  if (agencyId) {
    clauses.push('va.agency_id = ?');
    values.push(agencyId);
  }
  const d = Number(days);
  if (Number.isInteger(d) && d > 0) {
    clauses.push(`${APPLIED_AT} >= (NOW() - INTERVAL ? DAY)`);
    values.push(d);
  }
  const q = String(search || '').trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(
      '(va.id LIKE ? OR ag.name LIKE ? OR u.full_name LIKE ? OR vt.name LIKE ? OR vc.name LIKE ? OR c.traveller_names LIKE ?)'
    );
    values.push(`${q}%`, like, like, like, like, like);
  }
  return { where: clauses.join(' AND '), values };
}

async function listAdminApplications({ agencyId, days, search, status, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const { where, values } = filterClauses({ agencyId, days, search, status });
  // Status counts ignore the status filter itself (they label the tabs).
  const forCounts = filterClauses({ agencyId, days, search });
  const [{ rows }, { rows: totalRows }, { rows: countRows }] = await Promise.all([
    pool.query(`${ADMIN_SELECT} WHERE ${where} ORDER BY ${APPLIED_AT} DESC LIMIT ? OFFSET ?`, [
      ...values,
      size,
      (current - 1) * size,
    ]),
    pool.query(`SELECT COUNT(*) AS total FROM (${ADMIN_SELECT} WHERE ${where}) x`, values),
    pool.query(
      `SELECT x.status, COUNT(*) AS n FROM (${ADMIN_SELECT} WHERE ${forCounts.where}) x GROUP BY x.status`,
      forCounts.values
    ),
  ]);
  const total = Number(totalRows[0]?.total || 0);
  const statusCounts = Object.fromEntries(countRows.map((r) => [r.status, Number(r.n)]));
  return {
    rows,
    total,
    statusCounts,
    allTotal: Object.values(statusCounts).reduce((s, n) => s + n, 0),
    page: current,
    pageSize: size,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

module.exports.listAdminApplications = listAdminApplications;

// Visa Requests cards: one per agency that has applied, with how many visas
// were delivered and how many are still to do. "Left" counts only paid
// applications' undecided travellers; unpaid NEFT ones are counted apart.
async function listAgencyVisaSummaries() {
  const { rows } = await pool.query(
    `SELECT va.agency_id, ag.name AS agency_name, ag.country AS agency_country, ag.logo_asset_url AS agency_logo_url,
            COUNT(*) AS applications,
            SUM(va.status IN ('submitted', 'processing')) AS open_applications,
            SUM(va.status = 'payment_review') AS awaiting_payment,
            COALESCE(SUM(CASE WHEN va.status <> 'payment_review' THEN c.travellers ELSE 0 END), 0) AS travellers,
            COALESCE(SUM(c.issued), 0) AS issued,
            COALESCE(SUM(c.rejected), 0) AS rejected,
            COALESCE(SUM(CASE WHEN va.status IN ('submitted', 'processing')
                              THEN c.travellers - c.issued - c.rejected ELSE 0 END), 0) AS pending,
            MAX(${APPLIED_AT}) AS last_applied_at
     FROM visa_applications va
     JOIN agencies ag ON ag.id = va.agency_id
     LEFT JOIN (${COUNTS}) c ON c.application_id = va.id
     WHERE va.status <> 'draft'
     GROUP BY va.agency_id, ag.name, ag.country, ag.logo_asset_url
     ORDER BY pending DESC, last_applied_at DESC`
  );
  return rows;
}

module.exports.listAgencyVisaSummaries = listAgencyVisaSummaries;

// One agency's requests (newest first) — the agency card's page.
async function listAgencyApplications(agencyId) {
  const { rows } = await pool.query(`${ADMIN_SELECT} WHERE va.agency_id = ? AND va.status <> 'draft' ORDER BY ${APPLIED_AT} DESC`, [
    agencyId,
  ]);
  return rows;
}

module.exports.listAgencyApplications = listAgencyApplications;

async function findAdminApplication(id) {
  const { rows } = await pool.query(`${ADMIN_SELECT} WHERE va.id = ? AND va.status <> 'draft'`, [id]);
  return rows[0] || null;
}

module.exports.findAdminApplication = findAdminApplication;

// Every traveller of several applications, for the agency page's cards.
async function listApplicantsForApplications(applicationIds) {
  if (!applicationIds.length) return [];
  const { rows } = await pool.query(
    `SELECT * FROM visa_applicants WHERE application_id IN (${applicationIds.map(() => '?').join(', ')})
     ORDER BY application_id, position`,
    applicationIds
  );
  return rows;
}

module.exports.listApplicantsForApplications = listApplicantsForApplications;

// ---- Tracking ------------------------------------------------------------------

async function addVisaEvent({ applicationId, applicantId = null, event, message = null, actorUserId = null }) {
  await pool.query(
    `INSERT INTO visa_application_events (id, application_id, applicant_id, event, message, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), applicationId, applicantId, event, message, actorUserId]
  );
}

module.exports.addVisaEvent = addVisaEvent;

async function listVisaEvents(applicationId) {
  const { rows } = await pool.query(
    `SELECT e.*, u.full_name AS actor_name, u.role AS actor_role, p.full_name AS applicant_name
     FROM visa_application_events e
     LEFT JOIN users u ON u.id = e.actor_user_id
     LEFT JOIN visa_applicants p ON p.id = e.applicant_id
     WHERE e.application_id = ?
     ORDER BY e.created_at DESC, e.id DESC`,
    [applicationId]
  );
  return rows;
}

module.exports.listVisaEvents = listVisaEvents;

// ---- Decisions -------------------------------------------------------------------

// submitted -> processing. Returns true when it changed the status.
async function startProcessing(applicationId) {
  const { rowCount } = await pool.query(
    `UPDATE visa_applications SET status = 'processing', processing_started_at = COALESCE(processing_started_at, NOW())
     WHERE id = ? AND status = 'submitted'`,
    [applicationId]
  );
  return rowCount > 0;
}

module.exports.startProcessing = startProcessing;

async function issueApplicantVisa(applicantId, { url, name, type, number, validUntil, userId }) {
  await pool.query(
    `UPDATE visa_applicants
     SET visa_status = 'issued', visa_document_url = ?, visa_document_name = ?, visa_document_type = ?,
         visa_number = ?, visa_valid_until = ?, visa_issued_at = NOW(), visa_issued_by_user_id = ?,
         visa_rejection_reason = NULL
     WHERE id = ?`,
    [url, name || null, type || null, number || null, validUntil || null, userId, applicantId]
  );
}

module.exports.issueApplicantVisa = issueApplicantVisa;

// Back to undecided (visa removed, or a rejection undone).
async function resetApplicantVisa(applicantId) {
  await pool.query(
    `UPDATE visa_applicants
     SET visa_status = 'pending', visa_document_url = NULL, visa_document_name = NULL, visa_document_type = NULL,
         visa_number = NULL, visa_valid_until = NULL, visa_issued_at = NULL, visa_issued_by_user_id = NULL,
         visa_rejection_reason = NULL
     WHERE id = ?`,
    [applicantId]
  );
}

module.exports.resetApplicantVisa = resetApplicantVisa;

async function rejectApplicantVisa(applicantId, reason) {
  await pool.query(
    `UPDATE visa_applicants
     SET visa_status = 'rejected', visa_rejection_reason = ?, visa_document_url = NULL, visa_document_name = NULL,
         visa_document_type = NULL, visa_number = NULL, visa_valid_until = NULL, visa_issued_at = NULL,
         visa_issued_by_user_id = NULL
     WHERE id = ?`,
    [reason, applicantId]
  );
}

module.exports.rejectApplicantVisa = rejectApplicantVisa;

// Every still-undecided traveller of the application -> rejected.
async function rejectPendingApplicants(applicationId, reason) {
  await pool.query(
    `UPDATE visa_applicants SET visa_status = 'rejected', visa_rejection_reason = ?
     WHERE application_id = ? AND visa_status = 'pending'`,
    [reason, applicationId]
  );
}

module.exports.rejectPendingApplicants = rejectPendingApplicants;

// Re-derives the application status from its travellers after a decision:
//   any undecided   -> processing (a finished one re-opens)
//   all decided     -> approved when at least one visa was issued, else rejected
// Returns { from, to } (to === from when nothing changed).
async function settleApplicationStatus(applicationId, { reason = null } = {}) {
  const { rows } = await pool.query(
    `SELECT va.status,
            COUNT(p.id) AS travellers,
            SUM(p.visa_status = 'issued') AS issued,
            SUM(p.visa_status = 'pending') AS pending
     FROM visa_applications va
     LEFT JOIN visa_applicants p ON p.application_id = va.id
     WHERE va.id = ?
     GROUP BY va.id, va.status`,
    [applicationId]
  );
  const row = rows[0];
  if (!row) return null;
  const from = row.status;
  const pending = Number(row.pending || 0);
  const issued = Number(row.issued || 0);
  const to = pending > 0 ? 'processing' : issued > 0 ? 'approved' : 'rejected';
  if (to === from) return { from, to };
  if (to === 'processing') {
    await pool.query(
      `UPDATE visa_applications SET status = 'processing', processing_started_at = COALESCE(processing_started_at, NOW()),
              completed_at = NULL, rejection_reason = NULL
       WHERE id = ? AND status IN ${WORKABLE}`,
      [applicationId]
    );
  } else {
    await pool.query(
      `UPDATE visa_applications SET status = ?, processing_started_at = COALESCE(processing_started_at, NOW()),
              completed_at = NOW(), rejection_reason = ?
       WHERE id = ? AND status IN ${WORKABLE}`,
      [to, to === 'rejected' ? reason : null, applicationId]
    );
  }
  return { from, to };
}

module.exports.settleApplicationStatus = settleApplicationStatus;

module.exports.WORKABLE_STATUSES = ['submitted', 'processing', 'approved', 'rejected'];
