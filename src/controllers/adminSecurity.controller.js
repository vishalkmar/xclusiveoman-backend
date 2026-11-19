const QRCode = require('qrcode');

const {
  adminSecurityModel
} = require('../models/adminSecurity.model.js');

const {
  generateSecret,
  verifyTotpStep,
  buildOtpAuthUri
} = require('../services/totp.service.js');

const {
  issueCode,
  verifyCode,
  EmailMfaError
} = require('../services/adminEmailMfa.service.js');

// The admin console's "Security" screen (admin/pages/Security.jsx). Two
// GLOBAL second-factor toggles — authenticator app (TOTP) and email
// verification — not per-user enrolment, so
// these endpoints operate on the single admin_security row. Read is open to
// any staff role so the page can render its current state; the
// mutations are super_admin-only (see adminSecurity.routes.js), since
// flipping this affects every admin's ability to sign in.

const TOTP_ISSUER = 'Xclusive Oman';
const TOTP_LABEL = 'Admin Console';

function toStatus(row) {
  return {
    twoFactor: {
      // The real switch the login flow reads.
      enabled: Boolean(row?.totp_enabled),
      // A secret exists (enrolment started) but isn't confirmed yet — lets
      // the UI tell "never set up" apart from "half-way through setup".
      pending: Boolean(row && row.totp_secret && !row.totp_enabled),
    },
    // Email verification — the same kind of global switch, one inbox for
    // every admin-console sign-in. pendingAddress is set while a setup code
    // is out and not yet confirmed.
    emailVerification: {
      enabled: Boolean(row?.email_2fa_enabled),
      address: row?.email_2fa_enabled ? row.email_2fa_address : null,
      pendingAddress: row?.email_2fa_enabled ? null : row?.email_2fa_pending_address || null,
    },
  };
}

function sendEmailMfaError(res, err) {
  return res.status(err.status).json({ error: err.error, message: err.message });
}

async function getSecurityStatus(req, res, next) {
  try {
    const row = await adminSecurityModel.get();
    res.json(toStatus(row));
  } catch (err) {
    next(err);
  }
}

module.exports.getSecurityStatus = getSecurityStatus;

async function beginTotpEnrollment(req, res, next) {
  try {
    const existing = await adminSecurityModel.get();
    if (existing?.totp_enabled) {
      return res.status(409).json({
        error: 'already_enabled',
        message: 'Two-factor authentication is already on. Turn it off first to set up a new authenticator.',
      });
    }

    const secret = generateSecret();
    await adminSecurityModel.setPendingSecret(secret);

    const otpauthUri = buildOtpAuthUri({ secret, label: TOTP_LABEL, issuer: TOTP_ISSUER });
    const qrDataUri = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 240 });

    res.json({ secret, otpauthUri, qrDataUri });
  } catch (err) {
    next(err);
  }
}

module.exports.beginTotpEnrollment = beginTotpEnrollment;

async function activateTotp(req, res, next) {
  try {
    const { code } = req.body;
    const row = await adminSecurityModel.get();
    if (!row?.totp_secret || row.totp_enabled) {
      return res.status(400).json({
        error: 'no_pending_setup',
        message: 'Start the authenticator setup again — there is no pending secret to confirm.',
      });
    }
    const step = verifyTotpStep(row.totp_secret, code, row.last_totp_step);
    if (step === null) {
      return res.status(400).json({ error: 'invalid_code', message: 'That code is not valid. Enter the code your authenticator app is showing right now.' });
    }

    const updated = await adminSecurityModel.activate(step);
    res.json(toStatus(updated));
  } catch (err) {
    next(err);
  }
}

module.exports.activateTotp = activateTotp;

async function disableTotp(req, res, next) {
  try {
    const { code } = req.body;
    const row = await adminSecurityModel.get();
    if (!row?.totp_enabled) {
      return res.json(toStatus(row));
    }
    if (verifyTotpStep(row.totp_secret, code, row.last_totp_step) === null) {
      return res.status(400).json({ error: 'invalid_code', message: 'Enter the code your authenticator app is showing right now to turn 2FA off.' });
    }

    const updated = await adminSecurityModel.disable();
    res.json(toStatus(updated));
  } catch (err) {
    next(err);
  }
}

module.exports.disableTotp = disableTotp;

// ---- Email verification ---------------------------------------------------
// enroll (send a code to the new inbox) -> activate (confirm it) turns it on;
// disable/request (send a code to the current inbox) -> disable turns it off.
// Proving access to the inbox on both ends means a walk-up session can't
// silently redirect or strip the second factor.

async function beginEmailEnrollment(req, res, next) {
  try {
    const existing = await adminSecurityModel.get();
    if (existing?.email_2fa_enabled) {
      return res.status(409).json({
        error: 'already_enabled',
        message: 'Email verification is already on. Turn it off first to use a different inbox.',
      });
    }
    const email = String(req.body.email).trim().toLowerCase();
    await issueCode({ purpose: 'enroll', userId: req.user.id, email });
    const updated = await adminSecurityModel.setEmailPendingAddress(email);
    res.json(toStatus(updated));
  } catch (err) {
    if (err instanceof EmailMfaError) return sendEmailMfaError(res, err);
    next(err);
  }
}

module.exports.beginEmailEnrollment = beginEmailEnrollment;

async function activateEmail(req, res, next) {
  try {
    const row = await adminSecurityModel.get();
    if (!row?.email_2fa_pending_address || row.email_2fa_enabled) {
      return res.status(400).json({
        error: 'no_pending_setup',
        message: 'Start the email verification setup again — there is no pending inbox to confirm.',
      });
    }
    await verifyCode({
      purpose: 'enroll',
      userId: req.user.id,
      code: req.body.code,
      expectedEmail: row.email_2fa_pending_address,
    });
    const updated = await adminSecurityModel.activateEmail();
    res.json(toStatus(updated));
  } catch (err) {
    if (err instanceof EmailMfaError) return sendEmailMfaError(res, err);
    next(err);
  }
}

module.exports.activateEmail = activateEmail;

async function requestEmailDisable(req, res, next) {
  try {
    const row = await adminSecurityModel.get();
    if (!row?.email_2fa_enabled) {
      return res.json(toStatus(row));
    }
    await issueCode({ purpose: 'disable', userId: req.user.id, email: row.email_2fa_address });
    res.json(toStatus(row));
  } catch (err) {
    if (err instanceof EmailMfaError) return sendEmailMfaError(res, err);
    next(err);
  }
}

module.exports.requestEmailDisable = requestEmailDisable;

async function disableEmail(req, res, next) {
  try {
    const row = await adminSecurityModel.get();
    if (!row?.email_2fa_enabled) {
      return res.json(toStatus(row));
    }
    await verifyCode({
      purpose: 'disable',
      userId: req.user.id,
      code: req.body.code,
      expectedEmail: row.email_2fa_address,
    });
    const updated = await adminSecurityModel.disableEmail();
    res.json(toStatus(updated));
  } catch (err) {
    if (err instanceof EmailMfaError) return sendEmailMfaError(res, err);
    next(err);
  }
}

module.exports.disableEmail = disableEmail;
