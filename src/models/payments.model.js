const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

async function createPayment(
  {
    bookingId,
    amount,
    method,
    status,
    cashfreeOrderId,
    neftSlipUrl,
    neftReference,
    clientAttemptToken,
    gatewayCurrency,
    gatewayAmount,
    fxRate,
  }
) {
  // active_cashfree_key (0074_payment_lifecycle_constraints.sql) is a
  // generated column MySQL computes itself from method/status/booking_id —
  // it must never appear in an explicit column/value list here.
  const id = newId();
  await pool.query(
    `INSERT INTO payments (id, booking_id, amount, method, status, cashfree_order_id, neft_slip_url, neft_reference, client_attempt_token,
                           gateway_currency, gateway_amount, fx_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      bookingId,
      amount,
      method,
      status,
      cashfreeOrderId || null,
      neftSlipUrl || null,
      neftReference || null,
      clientAttemptToken || null,
      gatewayCurrency || null,
      gatewayAmount ?? null,
      fxRate ?? null,
    ]
  );
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0];
}

module.exports.createPayment = createPayment;

async function findPaymentById(id) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findPaymentById = findPaymentById;

async function findPaymentByCashfreeOrderId(orderId) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE cashfree_order_id = ?', [orderId]);
  return rows[0] || null;
}

module.exports.findPaymentByCashfreeOrderId = findPaymentByCashfreeOrderId;

async function findPaymentByClientAttemptToken(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE client_attempt_token = ?', [token]);
  return rows[0] || null;
}

module.exports.findPaymentByClientAttemptToken = findPaymentByClientAttemptToken;

async function findActiveCashfreePayment(bookingId) {
  const { rows } = await pool.query(
    `SELECT * FROM payments
     WHERE booking_id = ? AND method = 'cashfree'
       AND status IN ('pending', 'awaiting_payment', 'awaiting_confirmation')
     ORDER BY created_at DESC
     LIMIT 1`,
    [bookingId]
  );
  return rows[0] || null;
}

module.exports.findActiveCashfreePayment = findActiveCashfreePayment;

// --- Lifecycle transitions. Each is guarded so a terminal payment
// (confirmed / failed / cancelled) can never be moved to another state, and
// so NEFT rows (pending_verification) are untouched by the Cashfree
// transitions. Each returns the updated row, or null when the guard blocked
// the change. ---
//
// None of these can reuse "the same WHERE clause" for a follow-up SELECT
// (the pattern used elsewhere in this port for RETURNING-less UPDATEs) —
// every guard here is a condition on the very `status` column the UPDATE
// itself changes, so after a successful transition the row would no longer
// match its own guard (e.g. markPaymentCancelled's `status IN
// (...non-terminal...)` guard is never true once status is actually
// 'cancelled'). So these instead check `rowCount` — src/db/pool.js's adapter
// normalizes mysql2's ResultSetHeader.affectedRows into this same field pg
// used to return, 0 when the WHERE guard blocked the update, >0 when it
// went through.

const NON_TERMINAL = "('pending', 'awaiting_payment', 'awaiting_confirmation')";

async function markPaymentAwaitingPayment(id) {
  const { rowCount } = await pool.query(
    `UPDATE payments SET status = 'awaiting_payment', updated_at = now()
     WHERE id = ? AND status IN ('pending', 'awaiting_payment')`,
    [id]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentAwaitingPayment = markPaymentAwaitingPayment;

async function markPaymentAwaitingConfirmation(id, { cashfreePaymentId } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE payments
     SET status = 'awaiting_confirmation',
         cashfree_payment_id = COALESCE(?, cashfree_payment_id),
         updated_at = now()
     WHERE id = ? AND status IN ${NON_TERMINAL}`,
    [cashfreePaymentId || null, id]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentAwaitingConfirmation = markPaymentAwaitingConfirmation;

async function markPaymentCancelled(id) {
  const { rowCount } = await pool.query(
    `UPDATE payments SET status = 'cancelled', updated_at = now()
     WHERE id = ? AND status IN ${NON_TERMINAL}`,
    [id]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentCancelled = markPaymentCancelled;

async function markPaymentFailed(id) {
  const { rowCount } = await pool.query(
    `UPDATE payments SET status = 'failed', updated_at = now()
     WHERE id = ? AND status IN ${NON_TERMINAL}`,
    [id]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentFailed = markPaymentFailed;

// `amount` / `gatewayAmountPaid` are only passed for a Cashfree payment: the
// INR amount Cashfree reported, and that amount converted back to OMR.
async function markPaymentConfirmed(id, { cashfreePaymentId, verifiedByUserId, amount, gatewayAmountPaid } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE payments
     SET status = 'confirmed', paid_at = now(),
         amount = COALESCE(?, amount),
         gateway_amount_paid = COALESCE(?, gateway_amount_paid),
         cashfree_payment_id = COALESCE(?, cashfree_payment_id),
         verified_by_user_id = COALESCE(?, verified_by_user_id),
         verified_at = CASE WHEN ? IS NOT NULL THEN now() ELSE verified_at END,
         updated_at = now()
     WHERE id = ? AND status <> 'confirmed'`,
    [
      amount ?? null,
      gatewayAmountPaid ?? null,
      cashfreePaymentId || null,
      verifiedByUserId || null,
      verifiedByUserId || null,
      id,
    ]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentConfirmed = markPaymentConfirmed;

async function markPaymentRejected(id, verifiedByUserId) {
  await pool.query(
    `UPDATE payments
     SET status = 'failed', verified_by_user_id = ?, verified_at = now(), updated_at = now()
     WHERE id = ?`,
    [verifiedByUserId, id]
  );
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.markPaymentRejected = markPaymentRejected;

async function listNeftPending() {
  const { rows } = await pool.query(
    `SELECT payments.*, bookings.agency_id, agencies.name AS agency_name
     FROM payments
     JOIN bookings ON bookings.id = payments.booking_id
     JOIN agencies ON agencies.id = bookings.agency_id
     WHERE payments.method = 'neft' AND payments.status = 'pending_verification'
     ORDER BY payments.created_at`
  );
  return rows;
}

module.exports.listNeftPending = listNeftPending;

async function insertTransaction(
  {
    agencyId,
    bookingId,
    paymentId,
    amount,
    method,
    status,
    totalPrice,
    amountPaidToDate,
  }
) {
  const id = newId();
  // reminder — Balance Due Reminder cron's own trigger (see
  // jobs/balanceDueReminder.job.js): true exactly when this payment still
  // leaves a balance (amountPaidToDate hasn't caught up to totalPrice yet).
  // A payment that settles the booking in full leaves it false, same as a
  // fresh row always starts.
  const reminder = Number(amountPaidToDate) !== Number(totalPrice);
  await pool.query(
    `INSERT INTO transactions (id, agency_id, booking_id, payment_id, amount, method, status, total_price, amount_paid_to_date, reminder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, agencyId, bookingId, paymentId, amount, method, status, totalPrice, amountPaidToDate, reminder]
  );
  const { rows } = await pool.query('SELECT * FROM transactions WHERE id = ?', [id]);
  return rows[0];
}

module.exports.insertTransaction = insertTransaction;

// Balance Due Reminder cron. Joins back to the *live* bookings/fd_packages
// rows (not this transaction's own frozen total_price/amount_paid_to_date
// snapshot — see 0086_transactions_amount_tracking.sql's own comment on why
// those two columns are audit-only, never re-read as a source of truth) so
// the email always shows what's actually owed right now, even if a later
// payment moved the balance since this particular transaction happened.
async function listTransactionsNeedingReminder() {
  const { rows } = await pool.query(
    `SELECT
       t.id AS transaction_id,
       b.id AS booking_id, b.created_by_user_id, b.balance_due, b.balance_due_date, b.status AS booking_status,
       fp.title AS package_title
     FROM transactions t
     JOIN bookings b ON b.id = t.booking_id
     JOIN fd_departure_dates fdd ON fdd.id = b.fd_departure_date_id
     JOIN fd_packages fp ON fp.id = fdd.fd_package_id
     WHERE t.reminder = true`
  );
  return rows;
}

module.exports.listTransactionsNeedingReminder = listTransactionsNeedingReminder;

async function clearTransactionReminder(id) {
  await pool.query(`UPDATE transactions SET reminder = false WHERE id = ?`, [id]);
}

module.exports.clearTransactionReminder = clearTransactionReminder;

async function listAgencyTransactions(agencyId) {
  const { rows } = await pool.query(
    `SELECT transactions.*, bookings.source_type
     FROM transactions
     JOIN bookings ON bookings.id = transactions.booking_id
     WHERE transactions.agency_id = ?
     ORDER BY transactions.created_at DESC`,
    [agencyId]
  );
  return rows;
}

module.exports.listAgencyTransactions = listAgencyTransactions;

async function listAllTransactions({ method, status, dateFrom } = {}) {
  const clauses = [];
  const values = [];

  if (method) {
    clauses.push(`transactions.method = ?`);
    values.push(method);
  }
  if (status) {
    clauses.push(`transactions.status = ?`);
    values.push(status);
  }
  if (dateFrom) {
    clauses.push(`transactions.created_at >= ?`);
    values.push(dateFrom);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT transactions.*, agencies.name AS agency_name
     FROM transactions
     JOIN agencies ON agencies.id = transactions.agency_id
     ${where}
     ORDER BY transactions.created_at DESC`,
    values
  );
  return rows;
}

module.exports.listAllTransactions = listAllTransactions;
