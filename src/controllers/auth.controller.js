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
  createAgency
} = require('../models/agencies.model.js');

const {
  createUser,
  findUserByEmail,
  findUserById,
  listStaffByRole,
  toPublicUser
} = require('../models/users.model.js');

const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  tokenVersionMatches,
  hashRawToken,
  generateNumericOtp,
  signAdminMfaToken,
  verifyAdminMfaToken,
  comparePassword,
  hashPassword
} = require('../services/auth.service.js');

const {
  generateAgentPassword
} = require('../services/password.service.js');

const {
  adminSecurityModel
} = require('../models/adminSecurity.model.js');

const {
  verifyTotpStep
} = require('../services/totp.service.js');

const {
  issueCode: issueAdminMfaEmailCode,
  verifyCode: verifyAdminMfaEmailCode,
  maskEmail,
  EmailMfaError
} = require('../services/adminEmailMfa.service.js');

const {
  sendEmail,
  sendOtpEmail
} = require('../services/email.service.js');

const {
  buildAgentRegistrationReceivedEmailHtml
} = require('../services/emailTemplate.service.js');

const {
  createNotification
} = require('../services/notification.service.js');

const {
  uploadBuffer
} = require('../services/cloudinary.service.js');

// Email OTP login — Agent/Team's sole authentication mechanism (no
// per-user password anywhere — users.password_hash was dropped,
// 0060_drop_password.sql). 6-digit code, 5-minute expiry, max 5 verification
// attempts per code (login_otps.attempt_count) before it's rejected outright
// and a fresh one has to be requested. The Admin Console is the one
// exception — email + a single shared password (adminLogin, below) — but
// still funnels into the exact same mfaRequired/issueTokens tail as
// verifyLoginOtp once that password checks out.
const OTP_EXPIRY_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;

// Rate limiting on *sending* a code (as opposed to OTP_MAX_ATTEMPTS above,
// which limits *guessing* one already sent). Two layers:
//  - middleware/rateLimiter.js's otpRequestLimiter, applied in
//    auth.routes.js, throttles by IP regardless of which email is targeted
//    — the thing that matters most now that this endpoint reports whether
//    an email is registered (see requestLoginOtp below).
//  - OTP_RESEND_COOLDOWN_SECONDS/OTP_MAX_PER_WINDOW below throttle by
//    *account* instead, off the existing login_otps rows — no new table or
//    dependency needed, since every send already inserts one row here.
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_PER_WINDOW = 5;
const OTP_RATE_WINDOW_MINUTES = 15;

function isCashfreeSandboxTestAccount(email) {
  return Boolean(
    (env.cashfree.apiBaseUrl || '').includes('sandbox') &&
    email?.trim().toLowerCase() === env.cashfree.testLoginEmail
  );
}

const REFRESH_COOKIE_NAME = 'xo_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Admin Console roles — mirrors the frontend's own allow-list
// (admin/context/AuthContext.jsx#ADMIN_ROLES / LoginModal.jsx#ADMIN_ROLES).
// Deliberately excludes the two team roles (relationship_manager,
// sales_manager): they're staff (agency_id NULL) but sign in at /team, not
// the Admin Console. Used by requestLoginOtp's `portal` gate below.
const ADMIN_CONSOLE_ROLES = new Set(['ops_admin', 'super_admin', 'sales_marketing', 'support', 'finance']);

function belongsToPortal(user, portal) {
  if (portal === 'admin') return user.agency_id === null && ADMIN_CONSOLE_ROLES.has(user.role);
  if (portal === 'agent') return user.agency_id !== null;
  return true; // no portal scoping (e.g. /team/login)
}

// Admin console second factors currently switched on (Security screen):
// 'totp' (authenticator app) and/or 'email' (code to the configured inbox).
// Either one satisfies the step when both are on.
function adminMfaMethods(security) {
  const methods = [];
  if (security?.totp_enabled && security.totp_secret) methods.push('totp');
  if (security?.email_2fa_enabled && security.email_2fa_address) methods.push('email');
  return methods;
}

// The shared "not signed in yet — one more step" response for both admin
// login paths. When email is the only factor, the code goes out right away
// so the next screen already has something to type; with both on, the
// client asks for an email code only if the user picks that option
// (POST /auth/mfa/email). Returns false (nothing sent) when no factor is on.
async function respondAdminMfaRequired(res, user, security) {
  const methods = adminMfaMethods(security);
  if (!methods.length) return false;

  const body = {
    mfaRequired: true,
    mfaToken: signAdminMfaToken({ userId: user.id }),
    mfaMethods: methods,
  };
  if (methods.includes('email')) {
    body.mfaEmailHint = maskEmail(security.email_2fa_address);
    body.mfaEmailSent = false;
    if (methods.length === 1) {
      try {
        await issueAdminMfaEmailCode({ purpose: 'login', userId: user.id, email: security.email_2fa_address });
        body.mfaEmailSent = true;
      } catch (err) {
        // Inside the resend cooldown (a sign-in retried within a minute) —
        // the code already out is still the live one, so just carry on to
        // the code screen; it has its own Resend.
        if (!(err instanceof EmailMfaError)) throw err;
      }
    }
  }
  res.json(body);
  return true;
}

function refreshCookieOptions() {
  const isProd = env.nodeEnv === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // 'lax' only rides along on same-site requests (fine for local dev, where
    // the Vite proxy keeps everything same-origin). The deployed frontend
    // calls the API cross-origin (VITE_API_PROXY_TARGET), and browsers never
    // attach a 'lax' cookie to a cross-site fetch/XHR — only 'none' does,
    // which itself requires 'secure'.
    sameSite: isProd ? 'none' : 'lax',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    path: '/api/auth',
  };
}

function issueTokens(res, user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

// Shared with controllers/passwordAuth.controller.js (password sign-in and
// change-password both end by issuing a session the same way).
module.exports.issueTokens = issueTokens;

// Admin-facing "New Agent Added" notification — fires once a new agency +
// owner has actually been created (see register() below; called after
// COMMIT, never before). Reuses the exact same generic notification
// infrastructure every other module in this app already goes through
// (services/notification.service.js's createNotification — the `notifications`
// table, its `notification:new` socket emit, and the shared NotificationBell
// UI, admin/components/AdminLayout.jsx) — none of that is new here, only this
// call site is. createNotification is single-recipient by design (see its
// own doc comment), so "the admin(s)" means looping it once per admin staff
// member — ops_admin and super_admin specifically (the two roles this app
// otherwise treats as "the Admin", e.g. AdminLayout's "ADMIN" badge and the
// existing queue:new_item live-badge socket event's `role:ops_admin` room —
// not the wider STAFF_ROLES list, which also includes specialist roles like
// finance/support that don't review new agency signups).
//
// Best-effort and never awaited by the response: a notification hiccup must
// never fail (or even delay) the registration itself, which has already
// fully succeeded by the time this runs.
async function notifyAdminsOfNewAgent({ agency, user }) {
  try {
    const [opsAdmins, superAdmins] = await Promise.all([
      listStaffByRole('ops_admin'),
      listStaffByRole('super_admin'),
    ]);
    const admins = [...opsAdmins, ...superAdmins].filter((u) => u.status === 'active');

    await Promise.all(
      admins.map((admin) =>
        createNotification({
          recipientUserId: admin.id,
          recipientRole: admin.role,
          type: 'agent_added',
          title: 'New Agent Added',
          message: `Agent ${user.full_name} has been added successfully.`,
          referenceType: 'agency',
          referenceId: agency.id,
        })
      )
    );
  } catch (err) {
    console.error('Failed to notify admins of new agent registration', agency.id, err);
  }
}

// Acknowledges the new owner's own registration (as opposed to
// notifyAdminsOfNewAgent above, which tells admins about it) — same
// best-effort, post-COMMIT posture: an email-send hiccup here must never fail (or
// even delay) the registration response.
async function sendAgentRegistrationReceivedEmail({ agency, user, temporaryPassword }) {
  try {
    const { html, attachments } = buildAgentRegistrationReceivedEmailHtml({
      fullName: user.full_name,
      agencyName: agency.name,
      email: user.email,
      temporaryPassword,
    });
    await sendEmail({
      to: user.email,
      subject: "We've received your Xclusive Oman registration",
      text: `Thanks for registering ${agency.name} with Xclusive Oman. Our team is reviewing your details now — you'll get another email the moment you're approved.\n\nYour login details\nEmail: ${user.email}\nPassword: ${temporaryPassword}\n\nYou can sign in with this password on the Agent Portal login ("Sign in with password"), or use an emailed sign-in code instead. Please change it from Profile > Change password after your first sign-in.`,
      html,
      attachments,
    });
  } catch (err) {
    console.error('Failed to send registration-received email', agency.id, err);
  }
}

async function uploadLicenseDocument(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload your IATA/License document' });
    }

    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ['agencies', 'pending', 'license-documents'],
    });

    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadLicenseDocument = uploadLicenseDocument;

// Optional company logo for Sign Up — same public upload-then-submit-the-URL
// flow as uploadLicenseDocument above, but images only (the shared upload
// middleware also lets PDFs through).
const LOGO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function uploadRegistrationLogo(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload your company logo' });
    }
    if (!LOGO_MIME.has(req.file.mimetype)) {
      return res.status(400).json({ error: 'invalid_file_type', message: 'The logo must be a JPG, PNG or WebP image' });
    }

    const uploaded = await uploadBuffer(req.file.buffer, {
      folderParts: ['agencies', 'pending', 'logos'],
    });

    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) {
    next(err);
  }
}

module.exports.uploadRegistrationLogo = uploadRegistrationLogo;

async function register(req, res, next) {
  const {
    agencyName,
    agencyType,
    licenseDocumentType,
    licenseDocumentUrl,
    licenseNumber,
    logoUrl,
    country,
    ownerFullName,
    email,
    phone,
  } = req.body;

  const client = await pool.connect();
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'conflict', message: 'Email already registered' });
    }

    await client.query('BEGIN');
    const agency = await createAgency(client, {
      name: agencyName,
      type: agencyType,
      licenseNumber,
      licenseDocumentType,
      licenseDocumentUrl,
      logoAssetUrl: logoUrl,
      country,
    });

    // The new agent gets a generated password (Xclusive@ + 5 digits),
    // emailed below; only its bcrypt hash is stored. It signs in straight
    // away, like the emailed code does — a pending agency just sees the
    // limited dashboard until it is approved.
    const temporaryPassword = generateAgentPassword();
    const user = await createUser(client, {
      agencyId: agency.id,
      role: 'agency_owner',
      fullName: ownerFullName,
      email,
      phone,
      passwordHash: await hashPassword(temporaryPassword),
    });
    await client.query('COMMIT');

    // Only ever reached after the agency + owner are durably committed —
    // never fires on a failed/rolled-back registration (see the catch block
    // below, which never calls this).
    await notifyAdminsOfNewAgent({ agency, user });
    await sendAgentRegistrationReceivedEmail({ agency, user, temporaryPassword });

    res.status(201).json({
      agency: { id: agency.id, name: agency.name, status: agency.status },
      user: toPublicUser(user),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports.register = register;

async function requestLoginOtp(req, res, next) {
  try {
    const { email, portal } = req.body;
    const user = await findUserByEmail(email);

    // On the public Agent Portal login, a staff email is answered exactly
    // like an email that doesn't exist — same status, code and message, and
    // before the inactive check below — so the agent login never reveals
    // that an address is a staff account, or where staff sign in.
    const staffOnAgentLogin = Boolean(user) && portal === 'agent' && !belongsToPortal(user, 'agent');
    if (!user || staffOnAgentLogin) {
      return res.status(404).json({
        error: 'not_registered',
        message:
          portal === 'agent'
            ? "Incorrect email. Check the address, or sign up if you don't have an account yet."
            : 'This email is not registered. Please sign up first.',
      });
    }

    if (user.status !== 'active' && !isCashfreeSandboxTestAccount(user.email)) {
      return res.status(403).json({
        error: 'account_inactive',
        message: 'This account is inactive. Please contact support.',
      });
    }

    // Portal gate — refuse to generate/send a code at all for an email that
    // doesn't belong to the login it came from (LoginModal.jsx's restrictTo).
    // Runs before any OTP is created so an agent never receives a staff code
    // and vice versa.
    // (The agent → staff direction is handled above, indistinguishably from an
    // unknown email.)
    if (portal && !belongsToPortal(user, portal)) {
      return res.status(403).json({
        error: 'wrong_portal',
        message: 'This login is for Xclusive Oman staff. Travel agents sign in at the Agent Portal.',
      });
    }

    if (isCashfreeSandboxTestAccount(user.email)) {
      return res.json({ message: `Use the configured sandbox test OTP for ${user.email}.` });
    }

    // Per-account send throttle (see the constants' own comment above) —
    // checked against every past send for this user, used or not, so a
    // rapid string of "Resend code" clicks can't outrun it.
    const { rows: recentSends } = await pool.query(
      `SELECT created_at FROM login_otps WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [user.id, OTP_MAX_PER_WINDOW]
    );
    const now = Date.now();
    const lastSend = recentSends[0];
    if (lastSend) {
      const secondsSinceLastSend = (now - new Date(lastSend.created_at).getTime()) / 1000;
      if (secondsSinceLastSend < OTP_RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: 'rate_limited',
          message: `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLastSend)}s before requesting another code.`,
        });
      }
    }
    const windowStart = now - OTP_RATE_WINDOW_MINUTES * 60 * 1000;
    const sentWithinWindow = recentSends.filter((row) => new Date(row.created_at).getTime() > windowStart).length;
    if (sentWithinWindow >= OTP_MAX_PER_WINDOW) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many code requests for this account. Please try again later.',
      });
    }

    const otp = generateNumericOtp();
    const otpHash = hashRawToken(otp);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Supersede any earlier, still-unused code for this user first, so at
    // most one OTP is ever valid at a time — clicking "Resend code" (or
    // re-submitting the email step) can't leave several different codes
    // simultaneously accepted.
    await pool.query('UPDATE login_otps SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await pool.query(
      `INSERT INTO login_otps (id, user_id, otp_hash, expires_at) VALUES (?, ?, ?, ?)`,
      [newId(), user.id, otpHash, expiresAt]
    );

    // Sent via Brevo's HTTP API — same transport every email in this app
    // uses now (sendEmail above, email.service.js), SMTP/Nodemailer having
    // been removed entirely (it wasn't usable on Render). sendOtpEmail is
    // just a thin wrapper that builds this one template and calls sendEmail;
    // OTP generation/storage/expiry above this line is untouched.
    await sendOtpEmail(user.email, otp, OTP_EXPIRY_MINUTES);

    res.json({ message: `A sign-in code has been sent to ${user.email}.` });
  } catch (err) {
    next(err);
  }
}

module.exports.requestLoginOtp = requestLoginOtp;

async function verifyLoginOtp(req, res, next) {
  try {
    const { email, otp } = req.body;
    const user = await findUserByEmail(email);
    if (!user || (user.status !== 'active' && !isCashfreeSandboxTestAccount(user.email))) {
      return res.status(401).json({ error: 'invalid_otp', message: 'Invalid or expired code' });
    }

    // Cashfree sandbox automation uses a fixed OTP. Keep this bypass scoped
    // to the exact configured account and sandbox endpoint; normal accounts
    // continue through the persisted, expiring, rate-limited OTP flow below.
    if (isCashfreeSandboxTestAccount(user.email) && String(otp) === env.cashfree.testLoginOtp) {
      const accessToken = issueTokens(res, user);
      return res.json({ accessToken, user: toPublicUser(user) });
    }

    const { rows } = await pool.query(
      `SELECT * FROM login_otps
       WHERE user_id = ? AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const record = rows[0];
    if (!record) {
      return res.status(401).json({ error: 'invalid_otp', message: 'Invalid or expired code' });
    }

    if (record.attempt_count >= OTP_MAX_ATTEMPTS) {
      await pool.query('UPDATE login_otps SET used_at = now() WHERE id = ?', [record.id]);
      return res.status(401).json({
        error: 'too_many_attempts',
        message: 'Too many incorrect attempts. Request a new code.',
      });
    }

    const submittedHash = hashRawToken(otp);
    if (submittedHash !== record.otp_hash) {
      await pool.query('UPDATE login_otps SET attempt_count = attempt_count + 1 WHERE id = ?', [record.id]);
      return res.status(401).json({ error: 'invalid_otp', message: 'Incorrect code' });
    }

    await pool.query('UPDATE login_otps SET used_at = now() WHERE id = ?', [record.id]);

    // Admin console 2FA (Security screen). When the global authenticator
    // toggle is on, an admin-console sign-in isn't finished yet — hand back
    // a short-lived mfaToken instead of a session and let verify-mfa below
    // trade it for the real tokens once a valid authenticator code lands.
    // Everyone else (agents, team) is unaffected.
    if (belongsToPortal(user, 'admin')) {
      const security = await adminSecurityModel.get();
      if (await respondAdminMfaRequired(res, user, security)) return;
    }

    const accessToken = issueTokens(res, user);
    res.json({ accessToken, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports.verifyLoginOtp = verifyLoginOtp;

async function adminLogin(req, res, next) {
  try {
    const { email, password } = req.body;

    const user = await findUserByEmail(email);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password' });
    }

    // Per-account bcrypt hash (0084_admin_password.sql), not the old flat
    // compare against one shared env value — comparePassword resolves false
    // outright for a NULL hash (an Agent/Team row, or an admin row this
    // account's own migration hasn't backfilled yet via
    // scripts/seedAdminPasswords.js), same "no crash, just refuse" posture
    // every other invalid-credentials branch here already takes.
    const passwordValid = await comparePassword(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email or password' });
    }

    if (!belongsToPortal(user, 'admin')) {
      return res.status(403).json({
        error: 'wrong_portal',
        message: 'This login is for Xclusive Oman staff. Travel agents sign in at the Agent Portal.',
      });
    }

    const security = await adminSecurityModel.get();
    if (await respondAdminMfaRequired(res, user, security)) return;

    const accessToken = issueTokens(res, user);
    res.json({ accessToken, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports.adminLogin = adminLogin;

async function verifyLoginMfa(req, res, next) {
  try {
    const { mfaToken, code, method = 'totp' } = req.body;

    let claims;
    try {
      claims = verifyAdminMfaToken(mfaToken);
    } catch {
      return res.status(401).json({
        error: 'mfa_session_expired',
        message: 'This sign-in step timed out. Start again from your email.',
      });
    }

    const user = await findUserById(claims.sub);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'invalid_mfa', message: 'Invalid authentication code' });
    }

    const security = await adminSecurityModel.get();
    const methods = adminMfaMethods(security);
    // 2FA was turned off between step 2 and now — nothing left to check,
    // just finish the sign-in rather than stranding the user.
    if (!methods.length) {
      const accessToken = issueTokens(res, user);
      return res.json({ accessToken, user: toPublicUser(user) });
    }
    if (!methods.includes(method)) {
      return res.status(401).json({ error: 'invalid_mfa', message: 'Invalid authentication code' });
    }

    if (method === 'email') {
      try {
        await verifyAdminMfaEmailCode({
          purpose: 'login',
          userId: user.id,
          code,
          expectedEmail: security.email_2fa_address,
        });
      } catch (err) {
        if (!(err instanceof EmailMfaError)) throw err;
        return res.status(401).json({ error: err.error, message: err.message });
      }
      const accessToken = issueTokens(res, user);
      return res.json({ accessToken, user: toPublicUser(user) });
    }

    // Must be exactly the code on screen now, and a step not already spent.
    const step = verifyTotpStep(security.totp_secret, code, security.last_totp_step);
    if (step === null) {
      return res.status(401).json({ error: 'invalid_mfa', message: 'Invalid authentication code' });
    }
    // Claim that step. If another concurrent sign-in already took it, this
    // request loses the race and the code counts as spent for it too.
    const claimed = await adminSecurityModel.recordUsedStep(step);
    if (!claimed) {
      return res.status(401).json({
        error: 'code_already_used',
        message: 'That code was just used. Wait for your authenticator app to show the next one.',
      });
    }

    const accessToken = issueTokens(res, user);
    res.json({ accessToken, user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports.verifyLoginMfa = verifyLoginMfa;

// Emails a fresh admin sign-in verification code — the "Resend code" link
// on the email step, and the first send when both factors are on and the
// user picks email over the authenticator app. Gated on the same short-lived
// mfaToken as verify-mfa, so it's only reachable after the password/OTP
// step has already passed.
async function sendLoginMfaEmail(req, res, next) {
  try {
    let claims;
    try {
      claims = verifyAdminMfaToken(req.body.mfaToken);
    } catch {
      return res.status(401).json({
        error: 'mfa_session_expired',
        message: 'This sign-in step timed out. Start again from your email.',
      });
    }

    const user = await findUserById(claims.sub);
    const security = await adminSecurityModel.get();
    if (!user || user.status !== 'active' || !adminMfaMethods(security).includes('email')) {
      return res.status(400).json({ error: 'email_mfa_unavailable', message: 'Email verification is not turned on.' });
    }

    try {
      await issueAdminMfaEmailCode({ purpose: 'login', userId: user.id, email: security.email_2fa_address });
    } catch (err) {
      if (!(err instanceof EmailMfaError)) throw err;
      return res.status(err.status).json({ error: err.error, message: err.message });
    }
    res.json({ message: `A verification code has been sent to ${maskEmail(security.email_2fa_address)}.` });
  } catch (err) {
    next(err);
  }
}

module.exports.sendLoginMfaEmail = sendLoginMfaEmail;

async function refresh(req, res, next) {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing refresh token' });
    }

    const claims = verifyRefreshToken(token);
    const user = await findUserById(claims.sub);
    // A refresh token issued before the user's last sign-out (token_version
    // bumped by logout below) is dead even though its signature still checks.
    if (!user || user.status !== 'active' || !tokenVersionMatches(claims, user)) {
      res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
      return res.status(401).json({ error: 'unauthorized' });
    }

    const accessToken = issueTokens(res, user);
    res.json({ accessToken, user: toPublicUser(user) });
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired refresh token' });
  }
}

module.exports.refresh = refresh;

async function logout(req, res, next) {
  try {
    // Server-side sign-out: bumping token_version revokes every access and
    // refresh token issued to this user so far (on every device), so a
    // copied refresh cookie can't be used after logging out.
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]);
    // clearCookie must be called with the same attributes the cookie was set
    // with (sameSite/secure included) or some browsers won't match it to clear.
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports.logout = logout;

async function me(req, res) {
  res.json({ user: toPublicUser(req.user) });
}

module.exports.me = me;
