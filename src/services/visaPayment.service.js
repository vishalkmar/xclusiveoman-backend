const { getOrder, getOrderPayments, terminateOrder } = require('./cashfree.service.js');
const { fromGatewayCurrency } = require('./fx.service.js');
const { createNotification } = require('./notification.service.js');
const { getIo } = require('../sockets/index.js');
const { addVisaEvent } = require('../models/visaProcessing.model.js');
const { listStaffByRole } = require('../models/users.model.js');
const { formatMoney } = require('../utils/currency.js');
const {
  findVisaPaymentById,
  markVisaPaymentConfirmed,
  markVisaPaymentCancelled,
  markVisaPaymentFailed,
  markApplicationSubmitted,
} = require('../models/visaPayments.model.js');

// Visa fee payment lifecycle — the visa counterpart of the booking payment
// flow in payments.controller.js, without seat holds or deposits: one
// payment covers the whole fee (price per person × travellers) and, once
// confirmed, submits the application.
//
// Confirmation only ever comes from Cashfree itself (webhook, or a live
// order check when the agent returns / polls) or from an admin approving a
// NEFT slip. Every state change is a guarded update (visaPayments.model.js),
// so a re-delivered webhook can't confirm twice.

const TERMINAL = new Set(['confirmed', 'failed', 'cancelled', 'rejected', 'pending_verification']);
// Cashfree payment_status values that mean money may still arrive.
const IN_PROGRESS = new Set(['SUCCESS', 'PENDING']);

function emitStatus(payment) {
  getIo()?.to(`agency:${payment.agency_id}`).emit('visa:payment_status', {
    applicationId: payment.application_id,
    paymentId: payment.id,
    status: payment.status,
  });
}

// Cashfree reports the INR it collected; credit the OMR equivalent at the
// rate locked when the order was opened.
function receivedInOmr(payment, gatewayAmountPaid) {
  if (!payment.fx_rate || !payment.gateway_currency) return {};
  const paid = Number(gatewayAmountPaid ?? payment.gateway_amount);
  if (!Number.isFinite(paid) || paid <= 0) return {};
  if (payment.gateway_amount != null && Math.abs(paid - Number(payment.gateway_amount)) > 0.01) {
    console.warn(`[visaPayment] paid ${paid} ${payment.gateway_currency} differs from order ${payment.gateway_amount} (payment ${payment.id})`);
  }
  return { amount: fromGatewayCurrency(paid, payment.fx_rate), gatewayAmountPaid: paid };
}

// Paid: the request starts its admin tracking timeline (visa_application_
// events) and the visa desk (ops / super admins) hears about it. Best-effort.
async function trackSubmitted(payment) {
  try {
    await addVisaEvent({
      applicationId: payment.application_id,
      event: 'submitted',
      message: `Visa fee ${formatMoney(payment.amount)} paid by ${payment.method === 'neft' ? 'NEFT' : 'card'} for ${payment.travellers} traveller(s).`,
      actorUserId: payment.method === 'neft' ? payment.verified_by_user_id || null : null,
    });
    const staff = (await Promise.all(['ops_admin', 'super_admin'].map(listStaffByRole)))
      .flat()
      .filter((u) => u.status === 'active');
    await Promise.all(
      staff.map((u) =>
        createNotification({
          recipientUserId: u.id,
          recipientRole: u.role,
          type: 'visa_request_submitted',
          title: 'New visa request',
          message: `Visa request ${payment.application_id.slice(0, 8).toUpperCase()} — ${payment.travellers} traveller(s) paid and ready to process.`,
          referenceType: 'visa_request',
          referenceId: payment.application_id,
        })
      )
    );
  } catch (err) {
    console.error('[visaPayment] tracking/notify failed', err.message);
  }
}

/**
 * Marks a payment confirmed and submits its application. Returns the
 * confirmed row, or null if it was already confirmed (or can't be).
 */
async function confirmVisaPayment(payment, { cashfreePaymentId, verifiedByUserId, gatewayAmountPaid } = {}) {
  const confirmed = await markVisaPaymentConfirmed(payment.id, {
    cashfreePaymentId,
    verifiedByUserId,
    ...(payment.method === 'cashfree' ? receivedInOmr(payment, gatewayAmountPaid) : {}),
  });
  if (!confirmed) return null;
  await markApplicationSubmitted(confirmed.application_id, confirmed.amount);
  emitStatus(confirmed);
  await trackSubmitted(confirmed);
  try {
    await createNotification({
      recipientUserId: confirmed.created_by_user_id,
      type: 'visa_payment_confirmed',
      title: 'Visa application submitted',
      message: `Payment of ${formatMoney(confirmed.amount)} received for ${confirmed.travellers} traveller(s). Your visa application has been submitted.`,
      referenceType: 'visa_application',
      referenceId: confirmed.application_id,
    });
  } catch (err) {
    console.error('[visaPayment] notification failed', err.message);
  }
  return confirmed;
}

module.exports.confirmVisaPayment = confirmVisaPayment;

async function confirmFromPaidOrder(payment, order) {
  const attempts = await getOrderPayments(payment.cashfree_order_id);
  const ok = attempts.find((a) => a.payment_status === 'SUCCESS');
  await confirmVisaPayment(payment, {
    cashfreePaymentId: ok?.cf_payment_id ? String(ok.cf_payment_id) : null,
    gatewayAmountPaid: ok?.payment_amount ?? order.order_amount,
  });
  return (await findVisaPaymentById(payment.id)) || payment;
}

/**
 * Ends an unpaid Cashfree attempt ('failed' | 'cancelled'). The order is
 * checked first: a PAID order is confirmed instead, an ACTIVE one terminated
 * (a terminated order can't be paid later). If Cashfree can't be reached the
 * attempt is left as is — the webhook or the next check decides.
 */
async function closeVisaAttempt(payment, finalStatus, { order: knownOrder } = {}) {
  if (TERMINAL.has(payment.status)) return payment;
  if (payment.method === 'cashfree' && payment.cashfree_order_id) {
    const order = knownOrder || (await getOrder(payment.cashfree_order_id));
    if (!order) return payment;
    if (order.order_status === 'PAID') return confirmFromPaidOrder(payment, order);
    if (order.order_status === 'ACTIVE') {
      const { terminated } = await terminateOrder(payment.cashfree_order_id);
      if (!terminated) return payment;
    }
  }
  const closed = finalStatus === 'failed' ? await markVisaPaymentFailed(payment.id) : await markVisaPaymentCancelled(payment.id);
  if (!closed) return (await findVisaPaymentById(payment.id)) || payment;
  emitStatus(closed);
  return closed;
}

module.exports.closeVisaAttempt = closeVisaAttempt;

/**
 * Live check against Cashfree for an open attempt (webhook slow/missed).
 * `leftCheckout`: the agent is back on the return page — an ACTIVE order
 * with no successful or pending attempt means they cancelled/closed it.
 */
async function reconcileVisaPayment(payment, { leftCheckout = false } = {}) {
  if (payment.method !== 'cashfree' || !payment.cashfree_order_id || TERMINAL.has(payment.status)) return payment;
  const order = await getOrder(payment.cashfree_order_id);
  if (!order) return payment;
  if (order.order_status === 'PAID') return confirmFromPaidOrder(payment, order);
  if (order.order_status === 'EXPIRED' || order.order_status === 'TERMINATED') return closeVisaAttempt(payment, 'cancelled', { order });
  if (order.order_status === 'ACTIVE' && leftCheckout) {
    const attempts = await getOrderPayments(payment.cashfree_order_id);
    if (attempts.some((a) => IN_PROGRESS.has(a.payment_status))) return payment;
    const declined = attempts.some((a) => a.payment_status === 'FAILED');
    return closeVisaAttempt(payment, declined ? 'failed' : 'cancelled', { order });
  }
  return payment;
}

module.exports.reconcileVisaPayment = reconcileVisaPayment;

/**
 * Cashfree webhook for a visa order (payments.controller.js#cashfreeWebhook
 * hands over orders it doesn't know). Never throws.
 */
async function handleVisaWebhook(payment, { paymentStatus, orderStatus, eventType, cashfreePaymentId, gatewayAmountPaid }) {
  try {
    if (TERMINAL.has(payment.status)) return;
    const isSuccess = paymentStatus === 'SUCCESS' || orderStatus === 'PAID' || eventType === 'PAYMENT_SUCCESS_WEBHOOK';
    const isFailed = paymentStatus === 'FAILED' || eventType === 'PAYMENT_FAILED_WEBHOOK';
    const isDropped = paymentStatus === 'USER_DROPPED' || paymentStatus === 'CANCELLED' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK';
    const isExpired = orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED' || eventType === 'ORDER_EXPIRED';
    if (isSuccess) await confirmVisaPayment(payment, { cashfreePaymentId, gatewayAmountPaid });
    else if (isFailed || isDropped || isExpired) await closeVisaAttempt(payment, isFailed ? 'failed' : 'cancelled');
  } catch (err) {
    console.error('[visaPayment] webhook processing error', err);
  }
}

module.exports.handleVisaWebhook = handleVisaWebhook;
