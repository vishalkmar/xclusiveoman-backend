const crypto = require('node:crypto');

const {
  pool
} = require('../db/pool.js');

const {
  env
} = require('../config/env.js');

const {
  newId
} = require('../utils/id.js');

const {
  hashPassword,
  comparePassword,
  hashRawToken
} = require('../services/auth.service.js');

const {
  DUMMY_PASSWORD_HASH,
  MAX_FAILED_PASSWORD_ATTEMPTS,
  PASSWORD_LOCK_MINUTES,
  RESET_LINK_MINUTES,
  RESET_MIN_SECONDS_BETWEEN,
  RESET_MAX_PER_HOUR
} = require('../services/password.service.js');

const {
  findUserByEmail,
  findUserById,
  toPublicUser,
  setUserPassword,
  getPasswordLockSeconds,
  recordFailedPasswordAttempt,
  clearPasswordFailures
} = require('../models/users.model.js');

const {
  sendEmail
} = require('../services/email.service.js');

const {
  buildPasswordResetEmailHtml,
  buildPasswordChangedEmailHtml
} = require('../services/emailTemplate.service.js');

const {
  issueTokens
} = require('./auth.controller.js');

// Agent password sign-in, forgot/reset password, and change/create password.
// Everything here is for travel-agency users (users.agency_id set). Staff
// keep their own admin-login and are never told this exists: a staff email
// here is answered like an unknown one.

const INVALID_CREDENTIALS = { error: 'invalid_credentials', message: 'Incorrect email or password.' };

function isAgentUser(user) {
  return Boolean(user) && user.agency_id !== null && user.agency_id !== undefined;
}

function lockedResponse(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return {
    error: 'account_locked',
    message: `Too many incorrect passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in with an emailed code instead.`,
  };
}

// Best-effort security notice — never blocks or fails the request.
async function sendPasswordChangedNotice(user) {
  try {
    const { html, attachments } = buildPasswordChangedEmailHtml({ fullName: user.full_name });
    await sendEmail({
      to: user.email,
      subject: 'Your Xclusive Oman password was changed',
      text: 'The password for your Xclusive Oman Agent Portal account was just changed, and you have been signed out of your other devices. If this was not you, reset your password straight away using "Forgot password" on the sign-in page.',
      html,
      attachments,
    });
  } catch (err) {
    console.error('[password] could not send password-changed notice:', err.message);
  }
}

// POST /auth/agent-login — email + password.
async function agentLogin(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);

    // Unknown email, staff email, inactive/unapproved account: the same
    // answer, and the same bcrypt work, so neither the message nor the
    // response time says which of those it was.
    if (!isAgentUser(user) || user.status !== 'active') {
      await comparePassword(password, DUMMY_PASSWORD_HASH);
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    const lockSeconds = await getPasswordLockSeconds(user.id);
    if (lockSeconds > 0) {
      return res.status(429).json(lockedResponse(lockSeconds));
    }

    // An account with no password yet compares against the dummy hash (same
    // cost), and can never match.
    const matches = await comparePassword(password, user.password_hash || DUMMY_PASSWORD_HASH);
    if (!user.password_hash || !matches) {
      if (user.password_hash) {
        await recordFailedPasswordAttempt(user.id, {
          maxAttempts: MAX_FAILED_PASSWORD_ATTEMPTS,
          lockMinutes: PASSWORD_LOCK_MINUTES,
        });
      }
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    await clearPasswordFailures(user.id);
    const accessToken = issueTokens(res, user);
    res.json({ accessToken, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports.agentLogin = agentLogin;

// POST /auth/forgot-password — always answers the same, whether or not the
// email belongs to an account, and answers before doing any work, so neither
// the response nor its timing reveals which emails are registered.
async function forgotPassword(req, res) {
  res.json({
    message: "If an account exists for that email, we've sent a link to reset the password. It expires in 30 minutes.",
  });

  try {
    const user = await findUserByEmail(req.body.email);
    if (!isAgentUser(user) || user.status !== 'active') return;

    // Per-account throttle: one link a minute, five an hour — so the form
    // can't be used to flood somebody's inbox.
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS last_hour,
         COALESCE(MIN(TIMESTAMPDIFF(SECOND, created_at, now())), 9999) AS seconds_since_last
       FROM password_resets
       WHERE user_id = ? AND created_at > now() - INTERVAL 1 HOUR`,
      [user.id]
    );
    if (Number(rows[0].last_hour) >= RESET_MAX_PER_HOUR) return;
    if (Number(rows[0].seconds_since_last) < RESET_MIN_SECONDS_BETWEEN) return;

    // Only the newest link works: earlier unused ones are retired.
    await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    const rawToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at)
       VALUES (?, ?, ?, now() + INTERVAL ${Number(RESET_LINK_MINUTES)} MINUTE)`,
      [newId(), user.id, hashRawToken(rawToken)]
    );

    const resetUrl = `${env.agentPortalUrl.replace(/\/+$/, '')}/reset-password?token=${rawToken}`;
    const { html, attachments } = buildPasswordResetEmailHtml({
      fullName: user.full_name,
      resetUrl,
      expiresMinutes: RESET_LINK_MINUTES,
    });
    await sendEmail({
      to: user.email,
      subject: 'Reset your Xclusive Oman password',
      text: `Use this link to choose a new password for your Xclusive Oman Agent Portal account (it works once and expires in ${RESET_LINK_MINUTES} minutes): ${resetUrl}\n\nIf you didn't ask for this, ignore this email.`,
      html,
      attachments,
    });
  } catch (err) {
    // Already answered; nothing to tell the caller. Never log the link.
    console.error('[password] forgot-password processing failed:', err.message);
  }
}

module.exports.forgotPassword = forgotPassword;

// POST /auth/reset-password — the emailed single-use token + a new password.
async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    const invalid = {
      error: 'invalid_or_expired_token',
      message: 'This reset link is invalid or has expired. Request a new one from the sign-in page.',
    };

    const { rows } = await pool.query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > now()`,
      [hashRawToken(token)]
    );
    const reset = rows[0];
    if (!reset) return res.status(400).json(invalid);

    const user = await findUserById(reset.user_id);
    if (!isAgentUser(user) || user.status !== 'active') return res.status(400).json(invalid);

    // Consume the token first, atomically: of two simultaneous uses, only
    // one can win.
    const consumed = await pool.query(
      'UPDATE password_resets SET used_at = now() WHERE id = ? AND used_at IS NULL',
      [reset.id]
    );
    if (!consumed.rowCount) return res.status(400).json(invalid);

    const updated = await setUserPassword(user.id, await hashPassword(password));
    await pool.query('UPDATE password_resets SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);

    sendPasswordChangedNotice(updated || user); // not awaited — best effort
    res.json({ message: 'Your password has been changed. You can sign in with it now.' });
  } catch (err) {
    next(err);
  }
}

module.exports.resetPassword = resetPassword;

// POST /auth/change-password — signed in. With a password already set, the
// current one is required; without one, this creates it. Signs every other
// device out and returns fresh tokens for this one.
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = req.user; // fresh row from requireAuth, incl. password_hash

    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'current_password_required', message: 'Enter your current password.' });
      }
      const lockSeconds = await getPasswordLockSeconds(user.id);
      if (lockSeconds > 0) return res.status(429).json(lockedResponse(lockSeconds));

      // 400, not 401: a 401 here would make the app think the session had
      // ended and sign the agent out.
      if (!(await comparePassword(currentPassword, user.password_hash))) {
        await recordFailedPasswordAttempt(user.id, {
          maxAttempts: MAX_FAILED_PASSWORD_ATTEMPTS,
          lockMinutes: PASSWORD_LOCK_MINUTES,
        });
        return res.status(400).json({ error: 'incorrect_password', message: 'Your current password is incorrect.' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'same_password', message: 'Choose a password different from your current one.' });
      }
    }

    const updated = await setUserPassword(user.id, await hashPassword(newPassword));
    const accessToken = issueTokens(res, updated);

    sendPasswordChangedNotice(updated); // not awaited — best effort
    res.json({
      accessToken,
      user: toPublicUser(updated),
      message: user.password_hash ? 'Your password has been changed.' : 'Your password has been created.',
    });
  } catch (err) {
    next(err);
  }
}

module.exports.changePassword = changePassword;
