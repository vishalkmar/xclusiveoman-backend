const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');
const { visaLabelSql } = require('./visa.model.js');

// Visa fee payments (0127_visa_payments.sql). State changes are guarded
// updates — each only applies from the states it's allowed to leave, and
// returns the updated row only when it actually changed something (rowCount,
// see src/db/pool.js), so a re-delivered webhook or a double click can never
// confirm (or close) the same payment twice.

const OPEN = "('pending', 'awaiting_payment')";

async function findVisaPaymentById(id) {
  const { rows } = await pool.query('SELECT * FROM visa_payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findVisaPaymentById = findVisaPaymentById;

async function findVisaPaymentByOrderId(orderId) {
  const { rows } = await pool.query('SELECT * FROM visa_payments WHERE cashfree_order_id = ?', [orderId]);
  return rows[0] || null;
}

module.exports.findVisaPaymentByOrderId = findVisaPaymentByOrderId;

async function listPaymentsForApplication(applicationId) {
  const { rows } = await pool.query('SELECT * FROM visa_payments WHERE application_id = ? ORDER BY created_at DESC', [
    applicationId,
  ]);
  return rows;
}

module.exports.listPaymentsForApplication = listPaymentsForApplication;

async function createVisaPayment({
  applicationId,
  agencyId,
  userId,
  amount,
  pricePerPerson,
  travellers,
  method,
  status,
  cashfreeOrderId = null,
  gatewayCurrency = null,
  gatewayAmount = null,
  fxRate = null,
  neftSlipUrl = null,
  neftReference = null,
}) {
  const id = newId();
  await pool.query(
    `INSERT INTO visa_payments
       (id, application_id, agency_id, created_by_user_id, amount, price_per_person, travellers, method, status,
        cashfree_order_id, gateway_currency, gateway_amount, fx_rate, neft_slip_url, neft_reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      applicationId,
      agencyId,
      userId,
      amount,
      pricePerPerson,
      travellers,
      method,
      status,
      cashfreeOrderId,
      gatewayCurrency,
      gatewayAmount,
      fxRate,
      neftSlipUrl,
      neftReference || null,
    ]
  );
  return findVisaPaymentById(id);
}

module.exports.createVisaPayment = createVisaPayment;

async function guardedUpdate(id, setSql, values, fromSql) {
  const { rowCount } = await pool.query(`UPDATE visa_payments SET ${setSql}, updated_at = now() WHERE id = ? AND status IN ${fromSql}`, [
    ...values,
    id,
  ]);
  return rowCount ? findVisaPaymentById(id) : null;
}

module.exports.markVisaPaymentAwaiting = (id) => guardedUpdate(id, "status = 'awaiting_payment'", [], OPEN);
module.exports.markVisaPaymentCancelled = (id) => guardedUpdate(id, "status = 'cancelled'", [], OPEN);
module.exports.markVisaPaymentFailed = (id) => guardedUpdate(id, "status = 'failed'", [], OPEN);

// From an open Cashfree attempt or a NEFT slip awaiting verification.
// `amount`/`gatewayAmountPaid` only for Cashfree (INR paid, converted back).
module.exports.markVisaPaymentConfirmed = (id, { cashfreePaymentId, verifiedByUserId, amount, gatewayAmountPaid } = {}) =>
  guardedUpdate(
    id,
    `status = 'confirmed', paid_at = now(),
     amount = COALESCE(?, amount),
     gateway_amount_paid = COALESCE(?, gateway_amount_paid),
     cashfree_payment_id = COALESCE(?, cashfree_payment_id),
     verified_by_user_id = COALESCE(?, verified_by_user_id),
     verified_at = CASE WHEN ? IS NOT NULL THEN now() ELSE verified_at END`,
    [amount ?? null, gatewayAmountPaid ?? null, cashfreePaymentId || null, verifiedByUserId || null, verifiedByUserId || null],
    "('pending', 'awaiting_payment', 'pending_verification')"
  );

module.exports.markVisaPaymentRejected = (id, { verifiedByUserId, reason }) =>
  guardedUpdate(
    id,
    "status = 'rejected', verified_by_user_id = ?, verified_at = now(), rejection_reason = ?",
    [verifiedByUserId, reason || null],
    "('pending_verification')"
  );

// Open Cashfree attempts of an application (normally at most one).
async function listOpenCashfreeAttempts(applicationId) {
  const { rows } = await pool.query(
    `SELECT * FROM visa_payments WHERE application_id = ? AND method = 'cashfree' AND status IN ${OPEN} ORDER BY created_at DESC`,
    [applicationId]
  );
  return rows;
}

module.exports.listOpenCashfreeAttempts = listOpenCashfreeAttempts;

// ---- Application status ---------------------------------------------------

// draft -> payment_review (NEFT slip waiting for verification)
async function markApplicationPaymentReview(applicationId) {
  const { rowCount } = await pool.query(
    `UPDATE visa_applications SET status = 'payment_review' WHERE id = ? AND status = 'draft'`,
    [applicationId]
  );
  return rowCount > 0;
}

module.exports.markApplicationPaymentReview = markApplicationPaymentReview;

// payment_review -> draft (NEFT slip rejected: pay again)
async function reopenApplication(applicationId) {
  await pool.query(`UPDATE visa_applications SET status = 'draft' WHERE id = ? AND status = 'payment_review'`, [applicationId]);
}

module.exports.reopenApplication = reopenApplication;

// draft | payment_review -> submitted (paid)
async function markApplicationSubmitted(applicationId, amount) {
  const { rowCount } = await pool.query(
    `UPDATE visa_applications
     SET status = 'submitted', paid_amount = ?, paid_at = now(), submitted_at = now()
     WHERE id = ? AND status IN ('draft', 'payment_review')`,
    [amount, applicationId]
  );
  return rowCount > 0;
}

module.exports.markApplicationSubmitted = markApplicationSubmitted;

// ---- Admin lists ------------------------------------------------------------

const ADMIN_SELECT = `
  SELECT vp.*, ag.name AS agency_name, u.full_name AS created_by_name,
         ${visaLabelSql()}, va.status AS application_status
  FROM visa_payments vp
  JOIN agencies ag ON ag.id = vp.agency_id
  JOIN visa_applications va ON va.id = vp.application_id
  LEFT JOIN visa_types vt ON vt.id = va.visa_type_id
  LEFT JOIN visa_categories vc ON vc.id = va.visa_category_id
  LEFT JOIN users u ON u.id = vp.created_by_user_id`;

// Transaction Ledger: every visa payment that moved (or is moving) money —
// confirmed, awaiting NEFT verification, or rejected. Open/abandoned card
// attempts aren't money movements and are left out.
async function listVisaTransactions({ method, status, dateFrom } = {}) {
  const clauses = ["vp.status IN ('confirmed', 'pending_verification', 'rejected')"];
  const values = [];
  if (method) {
    clauses.push('vp.method = ?');
    values.push(method);
  }
  if (status) {
    clauses.push('vp.status = ?');
    values.push(status);
  }
  if (dateFrom) {
    clauses.push('vp.created_at >= ?');
    values.push(dateFrom);
  }
  const { rows } = await pool.query(`${ADMIN_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY vp.created_at DESC`, values);
  return rows;
}

module.exports.listVisaTransactions = listVisaTransactions;

async function listVisaNeftPending() {
  const { rows } = await pool.query(
    `${ADMIN_SELECT} WHERE vp.method = 'neft' AND vp.status = 'pending_verification' ORDER BY vp.created_at`
  );
  return rows;
}

module.exports.listVisaNeftPending = listVisaNeftPending;

// Agent's own payment history (Payment & Transaction History).
async function listAgencyVisaPayments(agencyId) {
  const { rows } = await pool.query(
    `${ADMIN_SELECT} WHERE vp.agency_id = ? AND vp.status IN ('confirmed', 'pending_verification', 'rejected')
     ORDER BY vp.created_at DESC`,
    [agencyId]
  );
  return rows;
}

module.exports.listAgencyVisaPayments = listAgencyVisaPayments;

// ---- Revenue ------------------------------------------------------------------

// Confirmed visa money in [dateFrom, dateTo], by the day it was paid.
const PAID_IN_RANGE = "vp.status = 'confirmed' AND DATE(vp.paid_at) BETWEEN ? AND ?";

async function getVisaRevenueKpis({ dateFrom, dateTo }) {
  const [{ rows: paid }, { rows: pending }, { rows: unpaid }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(vp.amount), 0) AS collected, COUNT(*) AS payments, COALESCE(SUM(vp.travellers), 0) AS travellers,
              COALESCE(SUM(vp.method = 'cashfree'), 0) AS card_payments, COALESCE(SUM(vp.method = 'neft'), 0) AS neft_payments,
              COALESCE(SUM(CASE WHEN vp.method = 'cashfree' THEN vp.amount ELSE 0 END), 0) AS card_amount,
              COALESCE(SUM(CASE WHEN vp.method = 'neft' THEN vp.amount ELSE 0 END), 0) AS neft_amount
       FROM visa_payments vp WHERE ${PAID_IN_RANGE}`,
      [dateFrom, dateTo]
    ),
    // NEFT slips submitted in the range and still waiting on verification.
    pool.query(
      `SELECT COALESCE(SUM(vp.amount), 0) AS amount, COUNT(*) AS payments
       FROM visa_payments vp
       WHERE vp.status = 'pending_verification' AND DATE(vp.created_at) BETWEEN ? AND ?`,
      [dateFrom, dateTo]
    ),
    // Applications started in the range and not paid (yet).
    pool.query(
      `SELECT COUNT(*) AS applications
       FROM visa_applications va
       WHERE va.status = 'draft' AND DATE(va.created_at) BETWEEN ? AND ?`,
      [dateFrom, dateTo]
    ),
  ]);
  const p = paid[0];
  const collected = Number(p.collected);
  const payments = Number(p.payments);
  return {
    collected,
    payments,
    travellers: Number(p.travellers),
    averagePerApplication: payments ? collected / payments : 0,
    cardAmount: Number(p.card_amount),
    neftAmount: Number(p.neft_amount),
    cardPayments: Number(p.card_payments),
    neftPayments: Number(p.neft_payments),
    pendingVerification: Number(pending[0].amount),
    pendingVerificationCount: Number(pending[0].payments),
    unpaidApplications: Number(unpaid[0].applications),
  };
}

module.exports.getVisaRevenueKpis = getVisaRevenueKpis;

function bucketExpr(granularity) {
  if (granularity === 'day') return `DATE_FORMAT(vp.paid_at, '%Y-%m-%d')`;
  if (granularity === 'week') return `DATE_FORMAT(DATE_SUB(DATE(vp.paid_at), INTERVAL WEEKDAY(vp.paid_at) DAY), '%Y-%m-%d')`;
  return `DATE_FORMAT(vp.paid_at, '%Y-%m-01')`;
}

async function getVisaRevenueTrend({ dateFrom, dateTo }, granularity) {
  const { rows } = await pool.query(
    `SELECT ${bucketExpr(granularity)} AS bucket, COALESCE(SUM(vp.amount), 0) AS revenue, COUNT(*) AS applications,
            COALESCE(SUM(vp.travellers), 0) AS travellers
     FROM visa_payments vp WHERE ${PAID_IN_RANGE}
     GROUP BY bucket`,
    [dateFrom, dateTo]
  );
  return new Map(rows.map((r) => [r.bucket, { revenue: Number(r.revenue), applications: Number(r.applications), travellers: Number(r.travellers) }]));
}

module.exports.getVisaRevenueTrend = getVisaRevenueTrend;

// Collected per group (visa type, category or agency) in a range.
async function getVisaRevenueGroup({ dateFrom, dateTo }, { idColumn, nameColumn, join = '' }) {
  const { rows } = await pool.query(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name, COALESCE(SUM(vp.amount), 0) AS revenue, COUNT(*) AS applications,
            COALESCE(SUM(vp.travellers), 0) AS travellers
     FROM visa_payments vp
     JOIN visa_applications va ON va.id = vp.application_id
     ${join}
     WHERE ${PAID_IN_RANGE}
     GROUP BY ${idColumn}, ${nameColumn}
     ORDER BY revenue DESC`,
    [dateFrom, dateTo]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, revenue: Number(r.revenue), applications: Number(r.applications), travellers: Number(r.travellers) }));
}

module.exports.getVisaRevenueGroup = getVisaRevenueGroup;

async function firstVisaPaymentDay() {
  const { rows } = await pool.query(`SELECT DATE_FORMAT(MIN(paid_at), '%Y-%m-%d') AS first_day FROM visa_payments WHERE status = 'confirmed'`);
  return rows[0]?.first_day || null;
}

module.exports.firstVisaPaymentDay = firstVisaPaymentDay;
