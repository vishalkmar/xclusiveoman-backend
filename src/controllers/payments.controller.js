const {
  createOrder,
  verifyWebhookSignature,
  getOrder,
  getOrderPayments,
  terminateOrder
} = require('../services/cashfree.service.js');

const {
  toGatewayCurrency,
  fromGatewayCurrency
} = require('../services/fx.service.js');

const {
  uploadBuffer
} = require('../services/cloudinary.service.js');

const {
  confirmPayment
} = require('../services/paymentConfirmation.service.js');

const {
  holdSeatsForPayment,
  releaseUnpaidBooking,
  SEAT_HOLD_MINUTES
} = require('../services/seatHold.service.js');

const {
  sendEmail
} = require('../services/email.service.js');

const {
  buildNotificationEmailHtml
} = require('../services/emailTemplate.service.js');

const {
  env
} = require('../config/env.js');

const {
  getIo
} = require('../sockets/index.js');

const {
  createPayment,
  findPaymentById,
  findPaymentByCashfreeOrderId,
  findPaymentByClientAttemptToken,
  findActiveCashfreePayment,
  markPaymentAwaitingPayment,
  markPaymentAwaitingConfirmation,
  markPaymentCancelled,
  markPaymentFailed,
  markPaymentConfirmed,
  markPaymentRejected,
  listNeftPending,
  listAgencyTransactions,
  listAllTransactions
} = require('../models/payments.model.js');

const {
  findBookingById
} = require('../models/bookings.model.js');

const {
  findVisaPaymentByOrderId,
  listAgencyVisaPayments
} = require('../models/visaPayments.model.js');

const {
  handleVisaWebhook
} = require('../services/visaPayment.service.js');

const {
  findUserById,
  listStaffByRole
} = require('../models/users.model.js');

const {
  createNotification
} = require('../services/notification.service.js');

const {
  formatMoney
} = require('../utils/currency.js');

// A payment in one of these states is done — never move it to another state
// (spec A). Used to short-circuit the webhook, reconciliation and abort.
const TERMINAL_PAYMENT_STATUSES = new Set(['confirmed', 'failed', 'cancelled', 'pending_verification']);

// How long a freshly-created Cashfree order is considered reusable before a
// new "Pay" click supersedes it instead (spec C).
// Short on purpose: a Cashfree order now expires with the seat hold (15 min),
// so an older order is replaced by a fresh one (and a fresh hold) rather than
// resumed with only minutes left.
const REUSE_WINDOW_MS = 2 * 60 * 1000;

function toPublicPayment(p) {
  return {
    id: p.id,
    bookingId: p.booking_id,
    amount: Number(p.amount),
    method: p.method,
    status: p.status,
    neftSlipUrl: p.neft_slip_url,
    neftReference: p.neft_reference,
    gatewayCurrency: p.gateway_currency || null,
    gatewayAmount: p.gateway_amount != null ? Number(p.gateway_amount) : null,
    gatewayAmountPaid: p.gateway_amount_paid != null ? Number(p.gateway_amount_paid) : null,
    fxRate: p.fx_rate != null ? Number(p.fx_rate) : null,
    paidAt: p.paid_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    agencyName: p.agency_name,
  };
}

function toPublicTransaction(t) {
  return {
    id: t.id,
    agencyId: t.agency_id,
    agencyName: t.agency_name,
    bookingId: t.booking_id,
    amount: Number(t.amount),
    method: t.method,
    status: t.status,
    totalPrice: Number(t.total_price),
    amountPaidToDate: Number(t.amount_paid_to_date),
    invoiceUrl: t.invoice_url,
    voucherUrl: t.voucher_url,
    createdAt: t.created_at,
  };
}

async function assertOwnsBooking(req, res, bookingId) {
  const booking = await findBookingById(bookingId);
  if (!booking || booking.agency_id !== req.user.agency_id) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return booking;
}

// Part-payment guard (0077_booking_deposit_due.sql). The first payment on a
// booking must clear "amount due now" — the full price within 15 days of
// departure, otherwise the flat deposit — and no payment may exceed what's
// still outstanding. Returns a message string to reject with, or null if
// `amount` is acceptable. Kept here (not the zod schema) because the bounds
// depend on the specific booking's state, not just the shape of the input.
function rejectPaymentAmount(booking, amount) {
  const EPSILON = 0.01; // NUMERIC round-trips as a float; don't reject a legit exact payment on the 15th decimal
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 'Enter a valid payment amount.';

  const balanceDue = Number(booking.balance_due);
  if (amt > balanceDue + EPSILON) {
    return `That is more than the outstanding balance of ${balanceDue}.`;
  }

  const amountDueNow = Math.max(0, Number(booking.deposit_due) - Number(booking.deposit_paid));
  if (amountDueNow > 0 && amt + EPSILON < amountDueNow) {
    return `A payment of at least ${amountDueNow} is required to confirm this booking.`;
  }
  return null;
}

// Ends an unpaid booking's seat hold (seatHold.service.js — releases its
// seats and cancels it; a no-op for bookings that already have money in).
// Never throws: callers include the webhook, which must always ack.
async function releaseHoldQuietly(bookingId, agencyId) {
  try {
    if (await releaseUnpaidBooking(bookingId)) {
      getIo()?.to(`agency:${agencyId}`).emit('booking:status_changed', { bookingId, status: 'cancelled' });
    }
  } catch (err) {
    console.error(`[seatHold] Failed to release booking ${bookingId}`, err);
  }
}

// Fast UI signal (spec M). Webhook + GET /api/payments/:id polling stay the
// authoritative / fallback mechanisms — this is best-effort on top.
async function emitPaymentStatusChanged({ agencyId, bookingId, paymentId, status }) {
  let aId = agencyId;
  if (!aId && bookingId) {
    const booking = await findBookingById(bookingId);
    aId = booking?.agency_id;
  }
  if (!aId) return;
  getIo()?.to(`agency:${aId}`).emit('payment:status_changed', { bookingId, paymentId, status });
}

// Shared "Cashfree says paid" path — webhook SUCCESS, live reconciliation, and
// (for NEFT, which skips the awaiting_confirmation hop) admin approval all run
// through here. markPaymentConfirmed is atomic: it returns a row only for the
// call that actually flipped pending -> confirmed, so a re-delivered webhook
// never reaches confirmPayment twice.
// Cashfree reports what was paid in the order's currency (INR). Convert it
// back to OMR with the rate locked when the order was opened, so the booking
// is credited in OMR. Rows without an fx_rate (pre-conversion orders) are
// left as-is.
function receivedInOmr(payment, gatewayAmountPaid) {
  if (!payment.fx_rate || !payment.gateway_currency) return {};
  const paid = Number(gatewayAmountPaid ?? payment.gateway_amount);
  if (!Number.isFinite(paid) || paid <= 0) return {};
  if (payment.gateway_amount != null && Math.abs(paid - Number(payment.gateway_amount)) > 0.01) {
    console.warn(
      `cashfree paid amount ${paid} ${payment.gateway_currency} differs from order amount ${payment.gateway_amount} (payment ${payment.id})`
    );
  }
  return { amount: fromGatewayCurrency(paid, payment.fx_rate), gatewayAmountPaid: paid };
}

async function advanceToConfirmed(payment, { cashfreePaymentId, verifiedByUserId, agencyId, gatewayAmountPaid } = {}) {
  const awaiting = await markPaymentAwaitingConfirmation(payment.id, { cashfreePaymentId });
  if (awaiting) {
    await emitPaymentStatusChanged({
      agencyId,
      bookingId: payment.booking_id,
      paymentId: payment.id,
      status: 'awaiting_confirmation',
    });
  }
  const confirmed = await markPaymentConfirmed(payment.id, {
    cashfreePaymentId,
    verifiedByUserId,
    ...receivedInOmr(payment, gatewayAmountPaid),
  });
  if (confirmed) {
    await confirmPayment(confirmed); // emits its own 'confirmed' + booking:status_changed
    return confirmed;
  }
  return null;
}

// Cashfree payment_status values that mean money may still arrive.
const IN_PROGRESS_ATTEMPT_STATUSES = new Set(['SUCCESS', 'PENDING']);

async function confirmFromPaidOrder(payment, booking, order) {
  const attempts = await getOrderPayments(payment.cashfree_order_id);
  const ok = attempts.find((a) => a.payment_status === 'SUCCESS');
  await advanceToConfirmed(payment, {
    cashfreePaymentId: ok?.cf_payment_id ? String(ok.cf_payment_id) : null,
    agencyId: booking.agency_id,
    gatewayAmountPaid: ok?.payment_amount ?? order.order_amount,
  });
  return (await findPaymentById(payment.id)) || payment;
}

// The one way a payment attempt ends without money — declined/failed,
// cancelled or closed in checkout, aborted on the Payment page, expired, or
// still unpaid when the seat hold lapses. Moves the payment out of
// "pending" for good (`finalStatus`: 'failed' | 'cancelled') and ends the
// booking's seat hold (seats released, unpaid booking cancelled).
//
// For a Cashfree attempt the order is checked and closed first: a PAID
// order is confirmed instead, and an ACTIVE one is terminated — Cashfree
// refuses to terminate an order that has been paid, and a terminated order
// can't be paid later (not even by retrying inside the same checkout), so
// nothing is ever released for money that's on its way. If the order can't
// be checked or closed (Cashfree unreachable, or a payment mid-flight),
// nothing changes and the webhook / next timeout tick decides. Returns the
// latest payment row.
async function closeUnpaidAttempt(payment, booking, finalStatus, { order: knownOrder } = {}) {
  if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) return payment;

  if (payment.method === 'cashfree' && payment.cashfree_order_id) {
    const order = knownOrder || (await getOrder(payment.cashfree_order_id));
    if (!order) return payment;
    if (order.order_status === 'PAID') return confirmFromPaidOrder(payment, booking, order);
    if (order.order_status === 'ACTIVE') {
      const { terminated } = await terminateOrder(payment.cashfree_order_id);
      if (!terminated) return payment;
    }
  }

  const closed = finalStatus === 'failed' ? await markPaymentFailed(payment.id) : await markPaymentCancelled(payment.id);
  if (!closed) return (await findPaymentById(payment.id)) || payment; // went terminal under us
  await releaseHoldQuietly(payment.booking_id, booking.agency_id);
  await emitPaymentStatusChanged({
    agencyId: booking.agency_id,
    bookingId: payment.booking_id,
    paymentId: payment.id,
    status: closed.status,
  });
  return closed;
}

module.exports.closeUnpaidAttempt = closeUnpaidAttempt;

// Live check against Cashfree for a still-open attempt — the fallback when a
// webhook is slow or missed (spec I). Advances local state and returns the
// latest payment row.
//
// `leftCheckout`: the agent is back from Cashfree's checkout (the return
// page). Cancelling there — or closing it before choosing a payment method —
// leaves the order ACTIVE and often sends no webhook at all (USER_DROPPED
// only fires once a method was tried). If no attempt on the order succeeded
// or is still pending, the attempt is closed right away (failed, if a
// declined attempt is on record, else cancelled).
async function reconcileCashfreePayment(payment, booking, { leftCheckout = false } = {}) {
  if (payment.method !== 'cashfree' || !payment.cashfree_order_id) return payment;
  if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) return payment;

  const order = await getOrder(payment.cashfree_order_id);
  if (!order) return payment;

  const orderStatus = order.order_status; // ACTIVE | PAID | EXPIRED | TERMINATED

  if (orderStatus === 'PAID') return confirmFromPaidOrder(payment, booking, order);

  if (orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED') {
    return closeUnpaidAttempt(payment, booking, 'cancelled', { order });
  }

  if (orderStatus === 'ACTIVE' && leftCheckout) {
    const attempts = await getOrderPayments(payment.cashfree_order_id);
    if (attempts.some((a) => IN_PROGRESS_ATTEMPT_STATUSES.has(a.payment_status))) return payment;
    const declined = attempts.some((a) => a.payment_status === 'FAILED');
    return closeUnpaidAttempt(payment, booking, declined ? 'failed' : 'cancelled', { order });
  }

  return payment;
}

module.exports.reconcileCashfreePayment = reconcileCashfreePayment;

async function createCashfreeOrder(req, res, next) {
  try {
    const { bookingId, amount, clientAttemptToken } = req.body;
    const booking = await assertOwnsBooking(req, res, bookingId);
    if (!booking) return;

    const amountError = rejectPaymentAmount(booking, amount);
    if (amountError) return res.status(400).json({ error: 'invalid_amount', message: amountError });

    // 1) Idempotent replay — the same intent token already produced a row
    // (network retry / double request). Return it, don't create a second.
    if (clientAttemptToken) {
      const prior = await findPaymentByClientAttemptToken(clientAttemptToken);
      if (prior) {
        const order = await getOrder(prior.cashfree_order_id);
        return res.status(200).json({
          payment: toPublicPayment(prior),
          paymentId: prior.id,
          orderId: prior.cashfree_order_id,
          paymentSessionId: order?.payment_session_id || null,
          cashfreeMode: env.cashfree.mode,
        });
      }
    }

    // Hold the booking's seats for this checkout — taking them back if an
    // earlier failed attempt released them (409 seats_unavailable if they've
    // been sold since). The hold lapses after SEAT_HOLD_MINUTES unpaid.
    await holdSeatsForPayment(bookingId, { expires: true });

    // 2) Reuse or supersede the booking's existing active attempt.
    const active = await findActiveCashfreePayment(bookingId);
    if (active) {
      const ageMs = Date.now() - new Date(active.created_at).getTime();
      const order = await getOrder(active.cashfree_order_id);
      const reusable = ageMs < REUSE_WINDOW_MS && order?.order_status === 'ACTIVE';

      if (reusable) {
        const awaiting = await markPaymentAwaitingPayment(active.id);
        const current = awaiting || active;
        if (awaiting && awaiting.status !== active.status) {
          await emitPaymentStatusChanged({
            agencyId: booking.agency_id,
            bookingId,
            paymentId: current.id,
            status: current.status,
          });
        }
        return res.status(200).json({
          payment: toPublicPayment(current),
          paymentId: current.id,
          orderId: current.cashfree_order_id,
          paymentSessionId: order.payment_session_id,
          cashfreeMode: env.cashfree.mode,
        });
      }

      // Stale / already paid / already failed at the gateway -> retire it.
      const cancelled = await markPaymentCancelled(active.id);
      if (cancelled) {
        if (order?.order_status === 'ACTIVE') await terminateOrder(active.cashfree_order_id);
        await emitPaymentStatusChanged({
          agencyId: booking.agency_id,
          bookingId,
          paymentId: active.id,
          status: 'cancelled',
        });
      } else {
        // It went terminal under us between the read and the update.
        const fresh = await findPaymentById(active.id);
        if (fresh && TERMINAL_PAYMENT_STATUSES.has(fresh.status) && fresh.status !== 'cancelled') {
          return res.status(200).json({
            payment: toPublicPayment(fresh),
            paymentId: fresh.id,
            orderId: fresh.cashfree_order_id,
            paymentSessionId: null,
            cashfreeMode: env.cashfree.mode,
          });
        }
      }
    }

    // 3) Fresh order + payment row. Cashfree charges in INR, so convert the
    // OMR amount at the live rate; the rate is stored on the row and used to
    // convert Cashfree's paid amount back to OMR on confirmation.
    const gateway = await toGatewayCurrency(amount);
    const { orderId, paymentSessionId } = await createOrder({
      bookingId,
      amount: gateway.amount,
      currency: gateway.currency,
      customerEmail: req.user.email,
      customerPhone: req.user.phone,
      customerId: req.user.id,
      expiresInMinutes: SEAT_HOLD_MINUTES,
    });

    let payment;
    try {
      payment = await createPayment({
        bookingId,
        amount,
        method: 'cashfree',
        status: 'pending',
        cashfreeOrderId: orderId,
        clientAttemptToken,
        gatewayCurrency: gateway.currency,
        gatewayAmount: gateway.amount,
        fxRate: gateway.rate,
      });
    } catch (err) {
      // A concurrent request beat us — either the same intent token
      // (uq_payments_client_attempt_token) or the single active-attempt slot
      // (one_active_cashfree_payment). The DB constraint is the final
      // protection (spec C): discard the order we just opened and return the
      // row the winning request created.
      if (err.code === '23505') {
        await terminateOrder(orderId);
        const winner =
          (clientAttemptToken && (await findPaymentByClientAttemptToken(clientAttemptToken))) ||
          (await findActiveCashfreePayment(bookingId));
        if (winner) {
          const order = await getOrder(winner.cashfree_order_id);
          return res.status(200).json({
            payment: toPublicPayment(winner),
            paymentId: winner.id,
            orderId: winner.cashfree_order_id,
            paymentSessionId: order?.payment_session_id || null,
            cashfreeMode: env.cashfree.mode,
          });
        }
      }
      throw err;
    }

    // Checkout is about to launch -> awaiting_payment (spec D). The actual
    // success only ever comes from webhook / reconciliation.
    const awaiting = await markPaymentAwaitingPayment(payment.id);
    const current = awaiting || payment;
    await emitPaymentStatusChanged({
      agencyId: booking.agency_id,
      bookingId,
      paymentId: current.id,
      status: current.status,
    });

    res.status(201).json({
      payment: toPublicPayment(current),
      paymentId: current.id,
      orderId,
      paymentSessionId,
      cashfreeMode: env.cashfree.mode,
    });
  } catch (err) {
    next(err);
  }
}

module.exports.createCashfreeOrder = createCashfreeOrder;

async function getPaymentStatus(req, res, next) {
  try {
    const payment = await findPaymentById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'not_found' });
    const booking = await assertOwnsBooking(req, res, payment.booking_id);
    if (!booking) return; // 404 already sent

    let current = payment;
    if (payment.method === 'cashfree' && !TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      current = await reconcileCashfreePayment(payment, booking);
    }
    res.json({ payment: toPublicPayment(current) });
  } catch (err) {
    next(err);
  }
}

module.exports.getPaymentStatus = getPaymentStatus;

async function getPaymentByOrder(req, res, next) {
  try {
    const payment = await findPaymentByCashfreeOrderId(req.params.orderId);
    if (!payment) return res.status(404).json({ error: 'not_found' });
    const booking = await assertOwnsBooking(req, res, payment.booking_id);
    if (!booking) return;

    // Only the payment-return page (PaymentReturn.jsx) looks a payment up by
    // order id — i.e. the agent has just come back from Cashfree's checkout,
    // so an unpaid order here means they cancelled or closed it.
    let current = payment;
    if (!TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      current = await reconcileCashfreePayment(payment, booking, { leftCheckout: true });
    }
    res.json({ payment: toPublicPayment(current) });
  } catch (err) {
    next(err);
  }
}

module.exports.getPaymentByOrder = getPaymentByOrder;

async function abortPayment(req, res, next) {
  try {
    const payment = await findPaymentById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'not_found' });
    const booking = await assertOwnsBooking(req, res, payment.booking_id);
    if (!booking) return;

    if (!['pending', 'awaiting_payment'].includes(payment.status)) {
      return res.json({ payment: toPublicPayment(payment) });
    }

    const current = await closeUnpaidAttempt(payment, booking, 'cancelled');
    res.json({ payment: toPublicPayment(current) });
  } catch (err) {
    next(err);
  }
}

module.exports.abortPayment = abortPayment;

async function cashfreeWebhook(req, res) {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = req.body?.toString('utf8') || '';

  if (!verifyWebhookSignature({ rawBody, timestamp, signature })) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  try {
    const orderId = event?.data?.order?.order_id;
    const paymentStatus = event?.data?.payment?.payment_status; // SUCCESS | FAILED | USER_DROPPED | CANCELLED | PENDING
    const orderStatus = event?.data?.order?.order_status; // PAID | EXPIRED | TERMINATED | ACTIVE
    const eventType = event?.type || '';
    const cashfreePaymentId = event?.data?.payment?.cf_payment_id
      ? String(event.data.payment.cf_payment_id)
      : null;
    // In the order's currency (INR) — converted back to OMR in advanceToConfirmed.
    const gatewayAmountPaid = event?.data?.payment?.payment_amount ?? event?.data?.order?.order_amount;

    const payment = orderId ? await findPaymentByCashfreeOrderId(orderId) : null;

    // Not a booking order — maybe a visa fee order (visaPayment.service.js).
    if (!payment && orderId) {
      const visaPayment = await findVisaPaymentByOrderId(orderId);
      if (visaPayment) {
        await handleVisaWebhook(visaPayment, { paymentStatus, orderStatus, eventType, cashfreePaymentId, gatewayAmountPaid });
        return res.status(200).json({ received: true });
      }
    }

    // Unknown order, or already done -> ack and ignore (duplicate delivery).
    if (!payment || TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      return res.status(200).json({ received: true });
    }

    const booking = await findBookingById(payment.booking_id);
    const agencyId = booking?.agency_id;

    const isSuccess =
      paymentStatus === 'SUCCESS' || orderStatus === 'PAID' || eventType === 'PAYMENT_SUCCESS_WEBHOOK';
    const isFailed = paymentStatus === 'FAILED' || eventType === 'PAYMENT_FAILED_WEBHOOK';
    const isDropped =
      paymentStatus === 'USER_DROPPED' ||
      paymentStatus === 'CANCELLED' ||
      eventType === 'PAYMENT_USER_DROPPED_WEBHOOK';
    const isExpired =
      orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED' || eventType === 'ORDER_EXPIRED';

    if (isSuccess) {
      await advanceToConfirmed(payment, { cashfreePaymentId, agencyId, gatewayAmountPaid });
    } else if (booking && (isFailed || isDropped || isExpired)) {
      await closeUnpaidAttempt(payment, booking, isFailed ? 'failed' : 'cancelled');
    }
  } catch (err) {
    // Never 5xx an authenticated webhook — Cashfree would retry indefinitely.
    // GET /api/payments/:id reconciliation is the safety net.
    console.error('cashfree webhook processing error', err);
  }

  res.status(200).json({ received: true });
}

module.exports.cashfreeWebhook = cashfreeWebhook;

// Persisted per-recipient via createNotification (so the bell gets
// id/createdAt/isRead) for every active staff role allowed to verify NEFT
// slips (adminPaymentsRouter's requireRole). Best-effort, not awaited.
async function notifyNeftReviewers({ bookingId, paymentId, amount }) {
  try {
    const staff = (await Promise.all(
      ['finance', 'ops_admin', 'super_admin'].map(listStaffByRole)
    )).flat().filter((u) => u.status === 'active');

    await Promise.all(
      staff.map((u) =>
        createNotification({
          recipientUserId: u.id,
          recipientRole: u.role,
          type: 'neft_slip_submitted',
          title: 'NEFT slip submitted',
          message: `Booking ${bookingId.slice(0, 8).toUpperCase()} — ${formatMoney(amount)} awaiting verification.`,
          referenceType: 'payment',
          referenceId: paymentId,
        })
      )
    );
  } catch (err) {
    console.error('Failed to notify NEFT reviewers', bookingId, err);
  }
}

async function uploadNeftSlip(req, res, next) {
  try {
    const { bookingId } = req.params;
    const booking = await assertOwnsBooking(req, res, bookingId);
    if (!booking) return;

    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload the NEFT transfer slip' });
    }

    const amountError = rejectPaymentAmount(booking, req.body.amount);
    if (amountError) return res.status(400).json({ error: 'invalid_amount', message: amountError });

    // An NEFT slip waits on admin verification, so its seat hold has no time
    // limit (and a failed Cashfree attempt can't release it meanwhile).
    await holdSeatsForPayment(bookingId, { expires: false });

    const upload = await uploadBuffer(req.file.buffer, {
      folderParts: ['bookings', bookingId, 'neft-slips'],
    });

    const payment = await createPayment({
      bookingId,
      amount: req.body.amount,
      method: 'neft',
      status: 'pending_verification',
      neftSlipUrl: upload.secure_url,
      neftReference: req.body.reference,
    });

    notifyNeftReviewers({ bookingId, paymentId: payment.id, amount: req.body.amount });

    res.status(201).json({ payment: toPublicPayment(payment) });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadNeftSlip = uploadNeftSlip;

async function getNeftPending(req, res, next) {
  try {
    const rows = await listNeftPending();
    res.json({ payments: rows.map(toPublicPayment) });
  } catch (err) {
    next(err);
  }
}

module.exports.getNeftPending = getNeftPending;

async function verifyNeftPayment(req, res, next) {
  try {
    const payment = await findPaymentById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'not_found' });

    if (req.body.approve) {
      const confirmed = await markPaymentConfirmed(payment.id, { verifiedByUserId: req.user.id });
      if (confirmed) {
        await confirmPayment(confirmed);
        return res.json({ payment: toPublicPayment(confirmed) });
      }
      // Already confirmed by an earlier action — return current state.
      return res.json({ payment: toPublicPayment((await findPaymentById(payment.id)) || payment) });
    }

    const rejected = await markPaymentRejected(payment.id, req.user.id);
    const booking = await findBookingById(payment.booking_id);
    const creator = booking ? await findUserById(booking.created_by_user_id) : null;
    if (creator) {
      const paymentUrl = `${env.agentPortalUrl}/payments/${payment.booking_id}`;
      const { html, attachments } = buildNotificationEmailHtml({
        heading: 'NEFT slip rejected',
        paragraphs: [
          `Hi ${creator.full_name || 'there'}, the NEFT transfer slip you submitted for booking ${payment.booking_id.slice(0, 8).toUpperCase()} could not be verified.`,
          'Please check the transfer details and upload the slip again from the payment page.',
        ],
        details: [
          { label: 'Booking', value: booking?.package_title || payment.booking_id },
          { label: 'Slip amount', value: formatMoney(payment.amount) },
          { label: 'Slip reference', value: payment.neft_reference },
          { label: 'Reason', value: req.body.reason },
        ],
        ctaLabel: 'Re-upload slip',
        ctaUrl: paymentUrl,
      });
      await sendEmail({
        to: creator.email,
        subject: 'NEFT slip rejected — Xclusive Oman',
        text: `Your NEFT slip of ${formatMoney(payment.amount)} for booking ${payment.booking_id} was rejected.${
          req.body.reason ? ` Reason: ${req.body.reason}` : ''
        } Please re-upload at ${paymentUrl}`,
        html,
        attachments,
      });
    }
    if (booking) {
      getIo()?.to(`agency:${booking.agency_id}`).emit('neft:rejected', {
        bookingId: booking.id,
        reason: req.body.reason || null,
      });
    }

    res.json({ payment: toPublicPayment(rejected) });
  } catch (err) {
    next(err);
  }
}

module.exports.verifyNeftPayment = verifyNeftPayment;

// Visa fee payment in the agent's transaction history shape. Only payments
// that moved (or are moving) money: confirmed, NEFT in verification, rejected.
function toAgentVisaTransaction(p) {
  return {
    id: p.id,
    kind: 'visa',
    bookingId: null,
    applicationId: p.application_id,
    visaType: p.visa_type_name,
    visaCategory: p.visa_category_name,
    travellers: Number(p.travellers),
    amount: Number(p.amount),
    method: p.method,
    status: p.status,
    rejectionReason: p.rejection_reason,
    createdAt: p.created_at,
  };
}

// The agency's booking payments and visa fee payments, newest first.
async function getMyTransactions(req, res, next) {
  try {
    const [rows, visaRows] = await Promise.all([
      listAgencyTransactions(req.user.agency_id),
      listAgencyVisaPayments(req.user.agency_id),
    ]);
    const transactions = [
      ...rows.map((t) => ({ ...toPublicTransaction(t), kind: 'booking' })),
      ...visaRows.map(toAgentVisaTransaction),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
}

module.exports.getMyTransactions = getMyTransactions;

async function getAllTransactions(req, res, next) {
  try {
    const { method, status, date_from: dateFrom } = req.query;
    const rows = await listAllTransactions({ method, status, dateFrom });
    res.json({ transactions: rows.map(toPublicTransaction) });
  } catch (err) {
    next(err);
  }
}

module.exports.getAllTransactions = getAllTransactions;
