const crypto = require('node:crypto');

const { findApplicationForAgency, listApplicants } = require('../models/visa.model.js');
const {
  HANDOFF_MINUTES,
  createHandoff,
  findHandoffForAgency,
  findHandoffByTokenHash,
  markHandoffOpened,
  markHandoffCompleted,
  cancelHandoff,
} = require('../models/visaPhotoHandoff.model.js');
const { hashRawToken } = require('../services/auth.service.js');
const { env } = require('../config/env.js');
const { loadEditableApplicationOr404, checkAndSaveApplicantPhoto, toPublicApplicant } = require('./visa.controller.js');

// "Scan with phone" for the visa photo step (0131_visa_photo_handoffs.sql).
//
// Agent side (signed in, /api/visa):
//   POST   /applications/:id/applicants/:applicantId/photo-handoff  - new QR link
//   GET    /photo-handoffs/:handoffId                              - poll its status
//   DELETE /photo-handoffs/:handoffId                              - QR closed
// Phone side (no login, /api/visa-photo-handoff — the token is the key):
//   GET    /:token        - who the photo is for
//   POST   /:token/photo  - the photo (same checks as the agent's own upload)
//
// The token is 32 random bytes; only its SHA-256 is stored. It is tied to
// one traveller of one draft application, expires after HANDOFF_MINUTES,
// and stops working once a photo is saved, the agent closes the QR, or a new
// QR is made for the same traveller.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The phone link, on the portal's public address (AGENT_PORTAL_URL without
// its /agent path) — the same base the password reset links use.
function phoneLink(token) {
  const base = env.agentPortalUrl.replace(/\/+$/, '').replace(/\/agent$/, '');
  return `${base}/visa-photo/${token}`;
}

function handoffState(row) {
  if ((row.status === 'pending' || row.status === 'opened') && Number(row.expired)) return 'expired';
  return row.status;
}

function secondsLeft(row) {
  return Math.max(0, Number(row.seconds_left) || 0);
}

// ---- Agent side ----------------------------------------------------------

async function postHandoff(req, res, next) {
  try {
    const application = await loadEditableApplicationOr404(req, res);
    if (!application) return;
    const applicant = (await listApplicants(application.id)).find((a) => a.id === req.params.applicantId);
    if (!applicant) return res.status(404).json({ error: 'not_found' });
    if (!applicant.full_name) {
      return res.status(400).json({ error: 'missing_name', message: "Enter this member's name before adding a photo." });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const handoff = await createHandoff({
      applicationId: application.id,
      applicantId: applicant.id,
      agencyId: req.user.agency_id,
      userId: req.user.id,
      tokenHash: hashRawToken(token),
    });
    res.status(201).json({
      handoff: {
        id: handoff.id,
        // Returned once, for the QR code; never stored or shown again.
        // `url` is the link to show; `token` is kept so a frontend from
        // before `url` existed keeps working (it builds the link itself).
        url: phoneLink(token),
        token,
        status: handoff.status,
        expiresInSeconds: HANDOFF_MINUTES * 60,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.postHandoff = postHandoff;

async function getHandoff(req, res, next) {
  try {
    const handoff = await findHandoffForAgency(req.params.handoffId, req.user.agency_id);
    if (!handoff) return res.status(404).json({ error: 'not_found' });
    const status = handoffState(handoff);
    let applicant = null;
    if (status === 'completed') {
      const row = (await listApplicants(handoff.application_id)).find((a) => a.id === handoff.applicant_id);
      applicant = row ? toPublicApplicant(row) : null;
    }
    res.json({ handoff: { id: handoff.id, status, expiresInSeconds: secondsLeft(handoff), applicant } });
  } catch (err) {
    next(err);
  }
}

module.exports.getHandoff = getHandoff;

async function deleteHandoff(req, res, next) {
  try {
    await cancelHandoff(req.params.handoffId, req.user.agency_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports.deleteHandoff = deleteHandoff;

// ---- Phone side (token only) ---------------------------------------------

const LINK_ERRORS = {
  invalid: [404, 'invalid_link', 'This link is not valid. Scan the QR code on the computer again.'],
  expired: [410, 'link_expired', 'This QR code has expired. Ask for a new one on the computer and scan it again.'],
  cancelled: [410, 'link_replaced', 'This QR code is no longer active. Scan the newest QR code on the computer.'],
  completed: [409, 'already_done', 'The photo for this traveller has already been saved. You can close this page.'],
  locked: [409, 'application_locked', 'This visa application has been submitted, so its photos can no longer be changed.'],
};

function sendLinkError(res, kind) {
  const [code, error, message] = LINK_ERRORS[kind];
  res.status(code).json({ error, message });
}

// The live link, its draft application and traveller — or an error sent.
async function loadHandoffByTokenOr4xx(req, res) {
  const token = String(req.params.token || '');
  if (!TOKEN_PATTERN.test(token)) {
    sendLinkError(res, 'invalid');
    return null;
  }
  const handoff = await findHandoffByTokenHash(hashRawToken(token));
  if (!handoff) {
    sendLinkError(res, 'invalid');
    return null;
  }
  const state = handoffState(handoff);
  if (state !== 'pending' && state !== 'opened') {
    sendLinkError(res, state);
    return null;
  }
  const application = await findApplicationForAgency(handoff.application_id, handoff.agency_id);
  if (!application) {
    sendLinkError(res, 'invalid');
    return null;
  }
  if (application.status !== 'draft') {
    sendLinkError(res, 'locked');
    return null;
  }
  const applicants = await listApplicants(application.id);
  const index = applicants.findIndex((a) => a.id === handoff.applicant_id);
  if (index < 0) {
    sendLinkError(res, 'invalid');
    return null;
  }
  return { handoff, application, applicant: applicants[index], number: index + 1 };
}

// Only what the phone needs to show: who the photo is for and the visa.
async function getHandoffByToken(req, res, next) {
  try {
    const loaded = await loadHandoffByTokenOr4xx(req, res);
    if (!loaded) return;
    const { handoff, application, applicant, number } = loaded;
    await markHandoffOpened(handoff.id);
    res.json({
      traveller: { number, name: applicant.full_name, hasPhoto: !!applicant.photo_url },
      visa: [application.visa_type_name, application.visa_category_name].filter(Boolean).join(' · '),
      expiresInSeconds: secondsLeft(handoff),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getHandoffByToken = getHandoffByToken;

async function postHandoffPhoto(req, res, next) {
  try {
    const loaded = await loadHandoffByTokenOr4xx(req, res);
    if (!loaded) return;
    const saved = await checkAndSaveApplicantPhoto(req, res, loaded);
    // A refused photo leaves the link open so the traveller can retake it.
    if (saved) await markHandoffCompleted(loaded.handoff.id);
  } catch (err) {
    next(err);
  }
}

module.exports.postHandoffPhoto = postHandoffPhoto;
