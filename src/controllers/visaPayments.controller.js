const crypto = require('node:crypto');

const { createOrder, getOrder, terminateOrder } = require('../services/cashfree.service.js');
const { toGatewayCurrency } = require('../services/fx.service.js');
const { uploadBuffer } = require('../services/cloudinary.service.js');
const { getVisaPrice, getVisaPackagePrice } = require('../services/visaPricing.service.js');
const { createNotification } = require('../services/notification.service.js');
const { sendEmail } = require('../services/email.service.js');
const { buildNotificationEmailHtml } = require('../services/emailTemplate.service.js');
const { confirmVisaPayment, closeVisaAttempt, reconcileVisaPayment } = require('../services/visaPayment.service.js');
const { findApplicationForAgency, listApplicants } = require('../models/visa.model.js');
const { findVisaPackageById } = require('../models/visaPackages.model.js');
const {
  createVisaPayment,
  findVisaPaymentById,
  findVisaPaymentByOrderId,
  listOpenCashfreeAttempts,
  listPaymentsForApplication,
  listVisaNeftPending,
  listVisaTransactions,
  markApplicationPaymentReview,
  markVisaPaymentAwaiting,
  markVisaPaymentRejected,
  reopenApplication,
} = require('../models/visaPayments.model.js');
const { findUserById, listStaffByRole } = require('../models/users.model.js');
const { env } = require('../config/env.js');

const applicationReference = (id) => `VISA-${String(id).slice(0, 8).toUpperCase()}`;
const { formatMoney, roundMoney } = require('../utils/currency.js');

// Visa fee payments. The agent pays once every traveller is complete
// (name, verified photo, confirmed passport): fee per person (Payments →
// Package Controller → Visa) × travellers, worked out here — the client
// never sends an amount. Paying submits the application.
//   Agent  /api/visa/applications/:id/payment/cashfree | /neft,
//          /api/visa/payments/:id (+ /abort), /api/visa/payments/by-order/:orderId
//   Admin  /api/admin/visa-payments (ledger), /neft-pending, /:id/verify

// Cashfree requires an order expiry more than 15 minutes away.
const ORDER_EXPIRY_MINUTES = 30;

function toPublicVisaPayment(p) {
  return {
    id: p.id,
    applicationId: p.application_id,
    amount: Number(p.amount),
    pricePerPerson: Number(p.price_per_person),
    travellers: Number(p.travellers),
    method: p.method,
    status: p.status,
    neftSlipUrl: p.neft_slip_url,
    neftReference: p.neft_reference,
    rejectionReason: p.rejection_reason,
    gatewayCurrency: p.gateway_currency || null,
    gatewayAmount: p.gateway_amount != null ? Number(p.gateway_amount) : null,
    paidAt: p.paid_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ...(p.agency_name !== undefined
      ? {
          agencyId: p.agency_id,
          agencyName: p.agency_name,
          createdByName: p.created_by_name,
          visaType: p.visa_type_name,
          visaCategory: p.visa_category_name,
          applicationStatus: p.application_status,
        }
      : {}),
  };
}

module.exports.toPublicVisaPayment = toPublicVisaPayment;

// What the agent owes right now, or why they can't pay yet.
async function payableQuote(application) {
  if (application.status === 'submitted' || application.status === 'payment_review') {
    return { error: { status: 409, error: 'already_paid', message: 'This application has already been paid for.' } };
  }
  if (application.status !== 'draft') {
    return { error: { status: 409, error: 'not_payable', message: 'This application can no longer be paid.' } };
  }
  const applicants = await listApplicants(application.id);
  // Every traveller needs a back page whose passport number matched the
  // front page (passportBackCheck.service.js).
  const incomplete = applicants.filter(
    (p) => !p.full_name || p.photo_status === 'pending' || p.passport_status !== 'confirmed' || !p.passport_scan?.backCheck?.matched
  );
  if (!applicants.length || incomplete.length) {
    return {
      error: {
        status: 409,
        error: 'incomplete',
        message: 'Complete every traveller first — name, photo, confirmed passport and a back page matching the passport number.',
      },
    };
  }
  const visaPackage = await findVisaPackageById(application.visa_package_id);
  const { pricePerPerson } = { pricePerPerson: await getVisaPackagePrice(visaPackage) };
  if (pricePerPerson == null) {
    return { error: { status: 409, error: 'price_not_set', message: "The visa fee hasn't been set yet. Please contact support." } };
  }
  return {
    pricePerPerson,
    travellers: applicants.length,
    amount: roundMoney(pricePerPerson * applicants.length),
  };
}

async function loadApplication(req, res) {
  const application = await findApplicationForAgency(req.params.id, req.user.agency_id, req.user.id);
  if (!application) res.status(404).json({ error: 'not_found' });
  return application;
}

async function loadOwnedPayment(req, res, finder, key) {
  const payment = await finder(key);
  if (!payment || payment.agency_id !== req.user.agency_id) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return payment;
}

// GET /visa/applications/:id/payment — the quote plus the payment history.
async function getPaymentInfo(req, res, next) {
  try {
    const application = await loadApplication(req, res);
    if (!application) return;
    const quote = await payableQuote(application);
    const payments = await listPaymentsForApplication(application.id);
    res.json({
      quote: quote.error ? null : { amount: quote.amount, pricePerPerson: quote.pricePerPerson, travellers: quote.travellers },
      blocked: quote.error ? { error: quote.error.error, message: quote.error.message } : null,
      payments: payments.map(toPublicVisaPayment),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getPaymentInfo = getPaymentInfo;

async function startCashfree(req, res, next) {
  try {
    const application = await loadApplication(req, res);
    if (!application) return;
    const quote = await payableQuote(application);
    if (quote.error) return res.status(quote.error.status).json(quote.error);

    // Retire earlier open attempts — or, if one was actually paid, stop here.
    for (const open of await listOpenCashfreeAttempts(application.id)) {
      const order = await getOrder(open.cashfree_order_id);
      const closed = await closeVisaAttempt(open, 'cancelled', { order });
      if (closed.status === 'confirmed') {
        return res.status(409).json({ error: 'already_paid', message: 'This application has already been paid for.' });
      }
    }

    // Cashfree charges in INR: convert at the live rate and lock it on the row.
    const gateway = await toGatewayCurrency(quote.amount);
    const { orderId, paymentSessionId } = await createOrder({
      // Cashfree caps order ids at 45 characters, so: visa_<12 hex of the
      // application id>_<base36 time>_<random> (~32). Looked up by the stored
      // value, never parsed. The random part keeps same-millisecond clicks apart.
      orderId: `visa_${application.id.replace(/-/g, '').slice(0, 12)}_${Date.now().toString(36)}_${crypto
        .randomBytes(3)
        .toString('hex')}`,
      orderTag: `visa-${application.id}`,
      returnPath: '/visa/payments/return',
      amount: gateway.amount,
      currency: gateway.currency,
      customerEmail: req.user.email,
      customerPhone: req.user.phone,
      customerId: req.user.id,
      expiresInMinutes: ORDER_EXPIRY_MINUTES,
    });

    let payment;
    try {
      payment = await createVisaPayment({
        applicationId: application.id,
        agencyId: application.agency_id,
        userId: req.user.id,
        amount: quote.amount,
        pricePerPerson: quote.pricePerPerson,
        travellers: quote.travellers,
        method: 'cashfree',
        status: 'pending',
        cashfreeOrderId: orderId,
        gatewayCurrency: gateway.currency,
        gatewayAmount: gateway.amount,
        fxRate: gateway.rate,
      });
    } catch (err) {
      await terminateOrder(orderId);
      throw err;
    }
    const current = (await markVisaPaymentAwaiting(payment.id)) || payment;
    res.status(201).json({
      payment: toPublicVisaPayment(current),
      paymentSessionId,
      cashfreeMode: env.cashfree.mode,
    });
  } catch (err) {
    next(err);
  }
}

module.exports.startCashfree = startCashfree;

// Persisted notification for every active finance/ops/super admin (the
// roles allowed to verify NEFT slips). Best-effort.
async function notifyNeftReviewers(payment, application) {
  try {
    const staff = (await Promise.all(['finance', 'ops_admin', 'super_admin'].map(listStaffByRole)))
      .flat()
      .filter((u) => u.status === 'active');
    await Promise.all(
      staff.map((u) =>
        createNotification({
          recipientUserId: u.id,
          recipientRole: u.role,
          type: 'visa_neft_slip_submitted',
          title: 'Visa NEFT slip submitted',
          message: `Visa application ${application.id.slice(0, 8).toUpperCase()} — ${formatMoney(payment.amount)} awaiting verification.`,
          referenceType: 'visa_payment',
          referenceId: payment.id,
        })
      )
    );
  } catch (err) {
    console.error('[visaPayments] failed to notify NEFT reviewers', err.message);
  }
}

async function submitNeftSlip(req, res, next) {
  try {
    const application = await loadApplication(req, res);
    if (!application) return;
    if (!req.file) return res.status(400).json({ error: 'missing_file', message: 'Upload the NEFT transfer slip.' });
    const quote = await payableQuote(application);
    if (quote.error) return res.status(quote.error.status).json(quote.error);

    const upload = await uploadBuffer(req.file.buffer, {
      folderParts: ['visa', 'applications', application.id, 'neft-slips'],
    });
    const payment = await createVisaPayment({
      applicationId: application.id,
      agencyId: application.agency_id,
      userId: req.user.id,
      amount: quote.amount,
      pricePerPerson: quote.pricePerPerson,
      travellers: quote.travellers,
      method: 'neft',
      status: 'pending_verification',
      neftSlipUrl: upload.secure_url,
      neftReference: String(req.body.reference || '').slice(0, 120),
    });
    await markApplicationPaymentReview(application.id);
    notifyNeftReviewers(payment, application);
    res.status(201).json({ payment: toPublicVisaPayment(payment) });
  } catch (err) {
    next(err);
  }
}

module.exports.submitNeftSlip = submitNeftSlip;

async function getVisaPayment(req, res, next) {
  try {
    const payment = await loadOwnedPayment(req, res, findVisaPaymentById, req.params.paymentId);
    if (!payment) return;
    res.json({ payment: toPublicVisaPayment(await reconcileVisaPayment(payment)) });
  } catch (err) {
    next(err);
  }
}

module.exports.getVisaPayment = getVisaPayment;

// The Cashfree return page looks the payment up by order id — the agent has
// just left checkout, so an unpaid order here means it was cancelled/closed.
async function getVisaPaymentByOrder(req, res, next) {
  try {
    const payment = await loadOwnedPayment(req, res, findVisaPaymentByOrderId, req.params.orderId);
    if (!payment) return;
    res.json({ payment: toPublicVisaPayment(await reconcileVisaPayment(payment, { leftCheckout: true })) });
  } catch (err) {
    next(err);
  }
}

module.exports.getVisaPaymentByOrder = getVisaPaymentByOrder;

async function abortVisaPayment(req, res, next) {
  try {
    const payment = await loadOwnedPayment(req, res, findVisaPaymentById, req.params.paymentId);
    if (!payment) return;
    if (!['pending', 'awaiting_payment'].includes(payment.status)) return res.json({ payment: toPublicVisaPayment(payment) });
    res.json({ payment: toPublicVisaPayment(await closeVisaAttempt(payment, 'cancelled')) });
  } catch (err) {
    next(err);
  }
}

module.exports.abortVisaPayment = abortVisaPayment;

// ---- Admin --------------------------------------------------------------------

async function adminListVisaPayments(req, res, next) {
  try {
    const { method, status, date_from: dateFrom } = req.query;
    const rows = await listVisaTransactions({ method, status, dateFrom });
    res.json({ payments: rows.map(toPublicVisaPayment) });
  } catch (err) {
    next(err);
  }
}

module.exports.adminListVisaPayments = adminListVisaPayments;

async function adminNeftPending(req, res, next) {
  try {
    res.json({ payments: (await listVisaNeftPending()).map(toPublicVisaPayment) });
  } catch (err) {
    next(err);
  }
}

module.exports.adminNeftPending = adminNeftPending;

async function adminVerifyNeft(req, res, next) {
  try {
    const payment = await findVisaPaymentById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'not_found' });
    if (payment.method !== 'neft') return res.status(400).json({ error: 'not_neft', message: 'Only NEFT slips are verified here.' });

    if (req.body.approve) {
      const confirmed = await confirmVisaPayment(payment, { verifiedByUserId: req.user.id });
      return res.json({ payment: toPublicVisaPayment(confirmed || (await findVisaPaymentById(payment.id)) || payment) });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Enter a reason to reject the slip.' });
    const rejected = await markVisaPaymentRejected(payment.id, { verifiedByUserId: req.user.id, reason });
    if (!rejected) return res.json({ payment: toPublicVisaPayment((await findVisaPaymentById(payment.id)) || payment) });
    // The agent can pay again (card, or a corrected slip).
    await reopenApplication(payment.application_id);

    const creator = await findUserById(payment.created_by_user_id);
    if (creator) {
      try {
        await createNotification({
          recipientUserId: creator.id,
          type: 'visa_neft_rejected',
          title: 'Visa NEFT slip rejected',
          message: `Your NEFT slip of ${formatMoney(payment.amount)} could not be verified: ${reason}. Please pay again.`,
          referenceType: 'visa_application',
          referenceId: payment.application_id,
        });
        const payUrl = `${env.agentPortalUrl}/visa/${payment.application_id}/pay`;
        const { html, attachments } = buildNotificationEmailHtml({
          heading: 'Visa NEFT slip rejected',
          paragraphs: [
            `Hi ${creator.full_name || 'there'}, the NEFT transfer slip you submitted for visa application ${payment.application_id
              .slice(0, 8)
              .toUpperCase()} could not be verified.`,
            'Please check the transfer and pay again from the visa payment page.',
          ],
          details: [
            { label: 'Application ID', value: applicationReference(payment.application_id) },
            { label: 'Slip amount', value: formatMoney(payment.amount) },
            { label: 'Slip reference', value: payment.neft_reference },
            { label: 'Reason', value: reason },
          ],
          ctaLabel: 'Pay again',
          ctaUrl: payUrl,
        });
        await sendEmail({
          to: creator.email,
          subject: 'Visa NEFT slip rejected — Xclusive Oman',
          text: `Application ID: ${applicationReference(payment.application_id)}. Your visa NEFT slip of ${formatMoney(payment.amount)} was rejected. Reason: ${reason}. Pay again at ${payUrl}`,
          html,
          attachments,
        });
      } catch (err) {
        console.error('[visaPayments] rejection notice failed', err.message);
      }
    }
    res.json({ payment: toPublicVisaPayment(rejected) });
  } catch (err) {
    next(err);
  }
}

module.exports.adminVerifyNeft = adminVerifyNeft;
