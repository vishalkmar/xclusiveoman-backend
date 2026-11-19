const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

const {
  generateNumericOtp,
  hashRawToken
} = require('./auth.service.js');

const {
  sendEmail
} = require('./email.service.js');

const {
  buildOtpEmailHtml
} = require('./emailTemplate.service.js');

// Admin console "Email verification" second factor — issuing and checking
// the 6-digit codes behind it (admin_mfa_email_codes, 0090_admin_email_2fa.sql).
// Same model as the plain sign-in OTP in auth.controller.js (hashed, 5-minute
// expiry, 5 attempts, one live code at a time, 60s resend cooldown), but
// scoped by `purpose` so a code emailed to confirm setup can never be spent
// at the login screen and vice versa.

const CODE_EXPIRY_MINUTES = 5;
const CODE_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

const PURPOSES = new Set(['login', 'enroll', 'disable']);

const EMAIL_COPY = {
  login: {
    subject: 'Your Xclusive Oman admin verification code',
    heading: 'Admin sign-in verification',
    intro: 'Someone just signed in to the Xclusive Oman admin console. Enter this code to finish signing in.',
  },
  enroll: {
    subject: 'Confirm this inbox for Xclusive Oman admin sign-in',
    heading: 'Confirm email verification',
    intro: 'Enter this code on the admin Security screen to start receiving admin sign-in codes at this address.',
  },
  disable: {
    subject: 'Confirm turning off admin email verification',
    heading: 'Turn off email verification',
    intro: 'Enter this code on the admin Security screen to stop requiring an emailed code at admin sign-in.',
  },
};

class EmailMfaError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

module.exports.EmailMfaError = EmailMfaError;

// Generates, stores and emails a fresh code, superseding any earlier unused
// one for the same purpose/user. Throws EmailMfaError(429) inside the
// cooldown so a burst of "Resend" clicks can't flood the inbox.
async function issueCode({ purpose, userId, email }) {
  if (!PURPOSES.has(purpose)) throw new Error(`Unknown email MFA purpose: ${purpose}`);

  const { rows: recent } = await pool.query(
    `SELECT created_at FROM admin_mfa_email_codes
     WHERE purpose = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1`,
    [purpose, userId]
  );
  if (recent[0]) {
    const secondsSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
    if (secondsSince < RESEND_COOLDOWN_SECONDS) {
      throw new EmailMfaError(
        429,
        'rate_limited',
        `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSince)}s before requesting another code.`
      );
    }
  }

  const code = generateNumericOtp();
  await pool.query(
    'UPDATE admin_mfa_email_codes SET used_at = now() WHERE purpose = ? AND user_id = ? AND used_at IS NULL',
    [purpose, userId]
  );
  await pool.query(
    `INSERT INTO admin_mfa_email_codes (id, purpose, user_id, email, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), purpose, userId, email, hashRawToken(code), new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000)]
  );

  const copy = EMAIL_COPY[purpose];
  const { html, attachments } = buildOtpEmailHtml({
    otp: code,
    expiresInMinutes: CODE_EXPIRY_MINUTES,
    heading: copy.heading,
    intro: copy.intro,
  });
  await sendEmail({
    to: email,
    subject: copy.subject,
    text: `${copy.intro} Your code is ${code}. It expires in ${CODE_EXPIRY_MINUTES} minutes.`,
    html,
    attachments,
  });
}

module.exports.issueCode = issueCode;

// Checks `code` against the latest live code for this purpose/user and
// consumes it on success. `expectedEmail`, when given, must match the inbox
// the code went to — so changing the configured address mid-flight
// invalidates codes already sent to the old one. Throws EmailMfaError on
// any rejection; resolves on success.
async function verifyCode({ purpose, userId, code, expectedEmail }) {
  const { rows } = await pool.query(
    `SELECT * FROM admin_mfa_email_codes
     WHERE purpose = ? AND user_id = ? AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [purpose, userId]
  );
  const record = rows[0];
  if (!record || (expectedEmail && record.email.toLowerCase() !== expectedEmail.toLowerCase())) {
    throw new EmailMfaError(400, 'invalid_code', 'That code has expired. Request a new one.');
  }

  if (record.attempt_count >= CODE_MAX_ATTEMPTS) {
    await pool.query('UPDATE admin_mfa_email_codes SET used_at = now() WHERE id = ?', [record.id]);
    throw new EmailMfaError(400, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.');
  }

  if (hashRawToken(String(code).trim()) !== record.code_hash) {
    await pool.query('UPDATE admin_mfa_email_codes SET attempt_count = attempt_count + 1 WHERE id = ?', [record.id]);
    throw new EmailMfaError(400, 'invalid_code', 'Incorrect code');
  }

  // Conditional claim — two requests racing with the same code can't both win.
  const { rowCount } = await pool.query(
    'UPDATE admin_mfa_email_codes SET used_at = now() WHERE id = ? AND used_at IS NULL',
    [record.id]
  );
  if (!rowCount) {
    throw new EmailMfaError(400, 'code_already_used', 'That code was just used. Request a new one.');
  }
}

module.exports.verifyCode = verifyCode;

// "xclusiveoman@gmail.com" -> "x**********n@gmail.com" — enough for the
// person signing in to recognise the inbox without the login screen
// disclosing the full address before the second factor is passed.
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  const masked = local.length <= 2 ? `${local[0]}*` : `${local[0]}${'*'.repeat(local.length - 2)}${local.slice(-1)}`;
  return `${masked}@${domain}`;
}

module.exports.maskEmail = maskEmail;
