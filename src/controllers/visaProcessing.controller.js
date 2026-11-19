const { uploadBuffer, deleteDocumentByUrl } = require('../services/cloudinary.service.js');
const { createNotification } = require('../services/notification.service.js');
const { sendEmail } = require('../services/email.service.js');
const { buildNotificationEmailHtml } = require('../services/emailTemplate.service.js');
const { getIo } = require('../sockets/index.js');
const { listApplicants } = require('../models/visa.model.js');
const { listPaymentsForApplication } = require('../models/visaPayments.model.js');
const { findUserById } = require('../models/users.model.js');
const {
  WORKABLE_STATUSES,
  addVisaEvent,
  findAdminApplication,
  issueApplicantVisa,
  listAdminApplications,
  listAgencyApplications,
  listAgencyVisaSummaries,
  listApplicantsForApplications,
  listVisaEvents,
  rejectApplicantVisa,
  rejectPendingApplicants,
  resetApplicantVisa,
  settleApplicationStatus,
  startProcessing,
} = require('../models/visaProcessing.model.js');
const { toPublicApplicant, toApplicationPackage } = require('./visa.controller.js');
const { toPublicVisaPayment } = require('./visaPayments.controller.js');
const { env } = require('../config/env.js');

// Admin visa processing — Visa Status (every applied request, filterable),
// Visa Requests (one card per agency -> its requests -> one request), and
// the per-traveller visa upload / removal / rejection with a tracking
// timeline (visa_application_events). The agent sees issued visas on their
// application page (toPublicApplicant's visa* fields).

const shortRef = (id) => String(id).slice(0, 8).toUpperCase();
const applicationReference = (id) => `VISA-${shortRef(id)}`;

function toAdminApplication(row, applicants = null) {
  const travellers = Number(row.travellers || 0);
  const issued = Number(row.visas_issued || 0);
  const rejected = Number(row.visas_rejected || 0);
  return {
    id: row.id,
    reference: row.reference || applicationReference(row.id),
    status: row.status,
    visaPackage: toApplicationPackage(row),
    visaType: { id: row.visa_type_id, name: row.visa_type_name },
    visaCategory: { id: row.visa_category_id, name: row.visa_category_name, processingTime: row.visa_category_processing_time },
    agency: { id: row.agency_id, name: row.agency_name, country: row.agency_country, logoUrl: row.agency_logo_url || null },
    createdBy: {
      id: row.created_by_user_id,
      name: row.created_by_name || null,
      email: row.created_by_email || null,
      phone: row.created_by_phone || null,
    },
    travellers,
    visasIssued: issued,
    visasRejected: rejected,
    visasPending: Math.max(travellers - issued - rejected, 0),
    travellerNames: row.traveller_names ? String(row.traveller_names).split('|').filter(Boolean) : [],
    paidAmount: row.paid_amount != null ? Number(row.paid_amount) : null,
    appliedAt: row.submitted_at || row.created_at,
    submittedAt: row.submitted_at || null,
    processingStartedAt: row.processing_started_at || null,
    completedAt: row.completed_at || null,
    rejectionReason: row.rejection_reason || null,
    createdAt: row.created_at,
    ...(applicants ? { applicants: applicants.map(toAdminApplicant) } : {}),
  };
}

// The agent-facing shape plus what only the admin needs (the visa document
// regardless of status is already covered; add who issued it).
function toAdminApplicant(row) {
  return {
    ...toPublicApplicant(row),
    visaIssuedByUserId: row.visa_issued_by_user_id || null,
  };
}

function toPublicEvent(row) {
  return {
    id: row.id,
    event: row.event,
    message: row.message,
    applicantId: row.applicant_id,
    applicantName: row.applicant_name || null,
    actor: row.actor_user_id ? { id: row.actor_user_id, name: row.actor_name, role: row.actor_role } : null,
    createdAt: row.created_at,
  };
}

// ---- Reads ---------------------------------------------------------------------

async function getApplications(req, res, next) {
  try {
    const { status, agency_id: agencyId, days, search, page, page_size: pageSize } = req.query;
    const result = await listAdminApplications({ status, agencyId, days, search, page, pageSize });
    res.json({
      applications: result.rows.map((r) => toAdminApplication(r)),
      pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages },
      statusCounts: result.statusCounts,
      total: result.allTotal,
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getApplications = getApplications;

async function getAgencies(req, res, next) {
  try {
    const rows = await listAgencyVisaSummaries();
    res.json({
      agencies: rows.map((r) => ({
        id: r.agency_id,
        name: r.agency_name,
        country: r.agency_country,
        logoUrl: r.agency_logo_url || null,
        applications: Number(r.applications || 0),
        openApplications: Number(r.open_applications || 0),
        awaitingPayment: Number(r.awaiting_payment || 0),
        travellers: Number(r.travellers || 0),
        issued: Number(r.issued || 0),
        rejected: Number(r.rejected || 0),
        pending: Number(r.pending || 0),
        lastAppliedAt: r.last_applied_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getAgencies = getAgencies;

// One agency's requests, each with its travellers (photo, passport pages,
// visa) so the page can show them separated per request.
async function getAgencyApplications(req, res, next) {
  try {
    const rows = await listAgencyApplications(req.params.agencyId);
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'This agency has no visa requests.' });
    const applicants = await listApplicantsForApplications(rows.map((r) => r.id));
    const byApp = new Map();
    applicants.forEach((a) => byApp.set(a.application_id, [...(byApp.get(a.application_id) || []), a]));
    res.json({
      agency: { id: rows[0].agency_id, name: rows[0].agency_name, country: rows[0].agency_country, logoUrl: rows[0].agency_logo_url || null },
      applications: rows.map((r) => toAdminApplication(r, byApp.get(r.id) || [])),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getAgencyApplications = getAgencyApplications;

async function loadApplicationOr404(req, res) {
  const application = await findAdminApplication(req.params.id);
  if (!application) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return application;
}

async function sendDetail(res, id, status = 200) {
  const [application, applicants, events, payments] = await Promise.all([
    findAdminApplication(id),
    listApplicants(id),
    listVisaEvents(id),
    listPaymentsForApplication(id),
  ]);
  res.status(status).json({
    application: toAdminApplication(application, applicants),
    events: events.map(toPublicEvent),
    payments: payments.map(toPublicVisaPayment),
  });
}

async function getApplication(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application) return;
    await sendDetail(res, application.id);
  } catch (err) {
    next(err);
  }
}

module.exports.getApplication = getApplication;

// ---- Decisions ---------------------------------------------------------------------

function requireWorkable(application, res) {
  if (!WORKABLE_STATUSES.includes(application.status)) {
    res.status(409).json({
      error: 'not_workable',
      message:
        application.status === 'payment_review'
          ? 'The visa fee for this request is still being verified (NEFT Verification).'
          : 'This request can no longer be processed.',
    });
    return false;
  }
  return true;
}

async function loadApplicantOr404(req, res) {
  const applicants = await listApplicants(req.params.id);
  const applicant = applicants.find((a) => a.id === req.params.applicantId);
  if (!applicant) {
    res.status(404).json({ error: 'not_found', message: 'Traveller not found on this request.' });
    return null;
  }
  return applicant;
}

// Live refresh for the agency's open pages.
function emitUpdate(application) {
  getIo()?.to(`agency:${application.agency_id}`).emit('visa:application_updated', { applicationId: application.id });
}

// In-app notification (and, for a finished request, an email) to the agent
// who applied. Best-effort.
async function notifyAgent(application, { type, title, message, email }) {
  try {
    await createNotification({
      recipientUserId: application.created_by_user_id,
      type,
      title,
      message,
      referenceType: 'visa_application',
      referenceId: application.id,
    });
    if (email) {
      const creator = await findUserById(application.created_by_user_id);
      if (!creator?.email) return;
      const url = `${env.agentPortalUrl}/visa/applications/${application.id}`;
      const { html, attachments } = buildNotificationEmailHtml({
        heading: title,
        paragraphs: [`Hi ${creator.full_name || 'there'},`, ...email.paragraphs],
        details: [{ label: 'Application ID', value: application.reference || applicationReference(application.id) }, ...(email.details || [])],
        ctaLabel: 'View visa application',
        ctaUrl: url,
      });
      await sendEmail({
        to: creator.email,
        subject: `${title} — Xclusive Oman`,
        text: `Application ID: ${application.reference || applicationReference(application.id)}. ${email.paragraphs.join(' ')} View it at ${url}`,
        html,
        attachments,
      });
    }
  } catch (err) {
    console.error('[visaProcessing] agent notice failed', err.message);
  }
}

// After a traveller decision: re-derive the request status, log it, and
// tell the agent when the whole request is finished.
async function settleAndAnnounce(application, actorUserId, { reason } = {}) {
  const result = await settleApplicationStatus(application.id, { reason });
  if (!result || result.from === result.to) return;
  const ref = shortRef(application.id);
  if (result.to === 'approved') {
    const fresh = await findAdminApplication(application.id);
    await addVisaEvent({
      applicationId: application.id,
      event: 'application_approved',
      message: `All travellers decided — ${fresh.visas_issued} of ${fresh.travellers} visa(s) issued.`,
      actorUserId,
    });
    await notifyAgent(application, {
      type: 'visa_application_completed',
      title: 'Your visas are ready',
      message: `Visa request ${ref}: ${fresh.visas_issued} of ${fresh.travellers} visa(s) issued and ready to download.`,
      email: {
        paragraphs: [
          `The visas for request ${ref} (${fresh.visa_type_name} · ${fresh.visa_category_name}) are ready.`,
          'Download them from the visa application page in the agent portal.',
        ],
        details: [
          { label: 'Visas issued', value: `${fresh.visas_issued} of ${fresh.travellers}` },
          ...(Number(fresh.visas_rejected) > 0 ? [{ label: 'Refused', value: String(fresh.visas_rejected) }] : []),
        ],
      },
    });
  } else if (result.to === 'rejected') {
    await addVisaEvent({ applicationId: application.id, event: 'application_rejected', message: reason || 'Every traveller was refused.', actorUserId });
    await notifyAgent(application, {
      type: 'visa_application_rejected',
      title: 'Visa request refused',
      message: `Visa request ${ref} was refused${reason ? `: ${reason}` : '.'}`,
      email: {
        paragraphs: [`Unfortunately visa request ${ref} was refused.`],
        details: reason ? [{ label: 'Reason', value: reason }] : [],
      },
    });
  } else if (result.to === 'processing' && ['approved', 'rejected'].includes(result.from)) {
    await addVisaEvent({ applicationId: application.id, event: 'application_reopened', message: 'Request re-opened for changes.', actorUserId });
  }
}

async function ensureProcessing(application, actorUserId) {
  if (application.status !== 'submitted') return;
  if (await startProcessing(application.id)) {
    await addVisaEvent({ applicationId: application.id, event: 'processing_started', message: 'Processing started.', actorUserId });
    await notifyAgent(application, {
      type: 'visa_processing_started',
      title: 'Visa processing started',
      message: `We've started processing visa request ${shortRef(application.id)}.`,
    });
  }
}

async function postStart(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application || !requireWorkable(application, res)) return;
    if (application.status !== 'submitted') {
      return res.status(409).json({ error: 'already_started', message: 'Processing has already started for this request.' });
    }
    await ensureProcessing(application, req.user.id);
    emitUpdate(application);
    await sendDetail(res, application.id);
  } catch (err) {
    next(err);
  }
}

module.exports.postStart = postStart;

const DOC_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image' };

async function postApplicantVisa(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application || !requireWorkable(application, res)) return;
    const applicant = await loadApplicantOr404(req, res);
    if (!applicant) return;
    if (!req.file) return res.status(400).json({ error: 'missing_file', message: 'Choose the visa file (PDF or image) to upload.' });
    const type = DOC_TYPES[req.file.mimetype];
    if (!type) return res.status(400).json({ error: 'invalid_file', message: 'Upload the visa as a PDF, JPG, PNG or WebP.' });

    const visaNumber = String(req.body.visaNumber || '').trim().slice(0, 60) || null;
    const validUntil = String(req.body.validUntil || '').trim() || null;
    if (validUntil && (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || Number.isNaN(new Date(`${validUntil}T00:00:00Z`).getTime()))) {
      return res.status(400).json({ error: 'invalid_date', message: 'Valid until must be a date (YYYY-MM-DD).' });
    }

    // PDFs go up as raw files so they're always downloadable (many Cloudinary
    // accounts block PDF delivery for image assets); images stay images.
    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ['visa', 'applications', application.id, 'visas'],
      ...(type === 'pdf' ? { resourceType: 'raw', publicId: `visa-${applicant.id.slice(0, 8)}-${Date.now()}.pdf` } : {}),
    });
    const replacing = applicant.visa_status === 'issued' ? applicant.visa_document_url : null;
    await ensureProcessing(application, req.user.id);
    await issueApplicantVisa(applicant.id, {
      url: uploaded.secure_url,
      name: String(req.file.originalname || '').slice(0, 200) || null,
      type,
      number: visaNumber,
      validUntil,
      userId: req.user.id,
    });
    if (replacing && replacing !== uploaded.secure_url) deleteDocumentByUrl(replacing).catch(() => {});

    const who = applicant.full_name || `Traveller ${applicant.position}`;
    await addVisaEvent({
      applicationId: application.id,
      applicantId: applicant.id,
      event: replacing ? 'visa_replaced' : 'visa_issued',
      message: `${replacing ? 'Visa replaced' : 'Visa uploaded'} for ${who}${visaNumber ? ` (No. ${visaNumber})` : ''}.`,
      actorUserId: req.user.id,
    });
    await notifyAgent(application, {
      type: 'visa_issued',
      title: replacing ? 'Visa updated' : 'Visa issued',
      message: `${replacing ? 'An updated visa' : 'The visa'} for ${who} (request ${shortRef(application.id)}) is ready to download.`,
    });
    await settleAndAnnounce(application, req.user.id);
    emitUpdate(application);
    await sendDetail(res, application.id, 201);
  } catch (err) {
    next(err);
  }
}

module.exports.postApplicantVisa = postApplicantVisa;

async function deleteApplicantVisa(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application || !requireWorkable(application, res)) return;
    const applicant = await loadApplicantOr404(req, res);
    if (!applicant) return;
    if (applicant.visa_status === 'pending') {
      return res.status(409).json({ error: 'nothing_to_undo', message: 'This traveller has no visa decision yet.' });
    }
    const url = applicant.visa_status === 'issued' ? applicant.visa_document_url : null;
    await resetApplicantVisa(applicant.id);
    if (url) deleteDocumentByUrl(url).catch(() => {});
    const who = applicant.full_name || `Traveller ${applicant.position}`;
    await addVisaEvent({
      applicationId: application.id,
      applicantId: applicant.id,
      event: url ? 'visa_removed' : 'rejection_undone',
      message: url ? `Visa removed for ${who}.` : `Refusal undone for ${who}.`,
      actorUserId: req.user.id,
    });
    await settleAndAnnounce(application, req.user.id);
    emitUpdate(application);
    await sendDetail(res, application.id);
  } catch (err) {
    next(err);
  }
}

module.exports.deleteApplicantVisa = deleteApplicantVisa;

async function postRejectApplicant(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application || !requireWorkable(application, res)) return;
    const applicant = await loadApplicantOr404(req, res);
    if (!applicant) return;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Give a reason for refusing this visa.' });
    const url = applicant.visa_status === 'issued' ? applicant.visa_document_url : null;
    await ensureProcessing(application, req.user.id);
    await rejectApplicantVisa(applicant.id, reason.slice(0, 1000));
    if (url) deleteDocumentByUrl(url).catch(() => {});
    const who = applicant.full_name || `Traveller ${applicant.position}`;
    await addVisaEvent({
      applicationId: application.id,
      applicantId: applicant.id,
      event: 'traveller_rejected',
      message: `Visa refused for ${who}: ${reason}`,
      actorUserId: req.user.id,
    });
    await notifyAgent(application, {
      type: 'visa_traveller_rejected',
      title: 'Visa refused',
      message: `The visa for ${who} (request ${shortRef(application.id)}) was refused: ${reason}`,
    });
    await settleAndAnnounce(application, req.user.id, { reason });
    emitUpdate(application);
    await sendDetail(res, application.id);
  } catch (err) {
    next(err);
  }
}

module.exports.postRejectApplicant = postRejectApplicant;

// Refuse the whole request: every still-undecided traveller is refused with
// the same reason (already-issued visas stay issued).
async function postRejectApplication(req, res, next) {
  try {
    const application = await loadApplicationOr404(req, res);
    if (!application || !requireWorkable(application, res)) return;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Give a reason for refusing this request.' });
    if (Number(application.travellers) - Number(application.visas_issued) - Number(application.visas_rejected) <= 0) {
      return res.status(409).json({ error: 'nothing_pending', message: 'Every traveller on this request is already decided.' });
    }
    await rejectPendingApplicants(application.id, reason.slice(0, 1000));
    await addVisaEvent({
      applicationId: application.id,
      event: 'pending_rejected',
      message: `Remaining travellers refused: ${reason}`,
      actorUserId: req.user.id,
    });
    await settleAndAnnounce(application, req.user.id, { reason });
    emitUpdate(application);
    await sendDetail(res, application.id);
  } catch (err) {
    next(err);
  }
}

module.exports.postRejectApplication = postRejectApplication;
