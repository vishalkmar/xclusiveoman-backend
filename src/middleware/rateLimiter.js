const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Central rate-limit policies. Each category gets its own limiter (and so its
// own counters), sized to what a legitimate user actually does, so a burst on
// one endpoint never spends another endpoint's budget.
//
// Keys:
//   - by IP for unauthenticated traffic (login, registration, public pages).
//     The IP comes from req.ip, which honours `app.set('trust proxy', 1)` in
//     app.js — exactly one proxy hop is trusted, so a client can't spoof its
//     IP with its own X-Forwarded-For header.
//   - by account for signed-in actions (payments, uploads, messages), so one
//     account can't hammer them by rotating IPs, and many agents behind one
//     office IP don't share a single budget.
//
// Store: in-memory (express-rate-limit's default). Right for a single Node
// process, which is how this API is deployed today. If it ever runs as
// several instances behind a load balancer, give these a shared store (e.g.
// rate-limit-redis) so the limits apply across instances; a memory store has
// no external dependency, so it can't fail open the way an unreachable Redis
// could.
//
// Responses: HTTP 429 with a JSON body, plus the standard RateLimit-* and
// Retry-After headers so clients know when to retry.

const MINUTE = 60 * 1000;

function limiter({ windowMs, limit, message, keyBy = 'ip', skipSuccessfulRequests = false }) {
  const keyGenerator =
    keyBy === 'user'
      ? (req) => (req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`)
      : (req) => `ip:${ipKeyGenerator(req.ip)}`;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7', // RateLimit + RateLimit-Policy headers; Retry-After on 429
    legacyHeaders: false,
    skipSuccessfulRequests,
    keyGenerator,
    handler(req, res, next, options) {
      console.warn(`[rateLimit] ${req.method} ${req.originalUrl.split('?')[0]} limited for ${keyGenerator(req)}`);
      res.status(options.statusCode).json({ error: 'rate_limited', message });
    },
  });
}

// Every /api request, per IP — a ceiling well above what one person's
// browser generates (dashboards fire a dozen calls per page), there to stop
// a single client flooding the API, not to shape normal use.
module.exports.globalApiLimiter = limiter({
  windowMs: MINUTE,
  limit: 300,
  message: 'Too many requests. Please slow down and try again shortly.',
});

// Sending a sign-in / verification code (email cost + inbox flooding).
module.exports.otpRequestLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  message: 'Too many code requests from this device. Please try again later.',
});

// Checking a 6-digit email code. Each code also locks after a few wrong
// attempts (login_otps.attempt_count); this caps guessing across codes.
module.exports.otpVerifyLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  message: 'Too many attempts from this device. Please try again later.',
});

module.exports.mfaVerifyLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  message: 'Too many attempts from this device. Please try again later.',
});

// Admin password login — only failed attempts count, so admins who sign in
// successfully never lock themselves out.
module.exports.adminLoginLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this device. Please try again later.',
});

// Agent Sign Up — creating accounts.
module.exports.registrationLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 10,
  message: 'Too many sign-up attempts from this device. Please try again later.',
});

// Sign Up's public (unauthenticated) document/logo uploads — each one stores
// a file in Cloudinary, so they're capped tightly per IP.
module.exports.publicUploadLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 20,
  message: 'Too many uploads from this device. Please try again later.',
});

// Session refresh — the SPA refreshes on load and when the 15-minute access
// token lapses; this only stops scripted hammering.
module.exports.refreshLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 120,
  message: 'Too many session refreshes. Please try again shortly.',
});

// Signed-in file uploads (images, documents, slips, voice notes).
module.exports.uploadLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 60,
  keyBy: 'user',
  message: 'Too many uploads. Please wait a few minutes and try again.',
});

// Payment attempts — each opens a Cashfree order.
module.exports.paymentLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  keyBy: 'user',
  message: 'Too many payment attempts. Please wait a few minutes and try again.',
});

// "Scan with phone" QR codes for visa photos — each one opens a no-login link.
module.exports.handoffLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 40,
  keyBy: 'user',
  message: 'Too many QR codes made. Please wait a few minutes and try again.',
});

// Support chat messages and new tickets.
module.exports.messageLimiter = limiter({
  windowMs: MINUTE,
  limit: 30,
  keyBy: 'user',
  message: 'You are sending messages too quickly. Please wait a moment.',
});

// Creating bookings and quote/RFQ requests (seat holds, admin notifications).
module.exports.bookingLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 40,
  keyBy: 'user',
  message: 'Too many booking requests. Please wait a few minutes and try again.',
});

// Paid / outbound operations — marketing sends and test emails.
module.exports.outboundMessageLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 30,
  keyBy: 'user',
  message: 'Too many messages sent. Please try again later.',
});

// Unauthenticated public reads (CMS pages, gallery, itinerary PDF data,
// marketing tracking links).
module.exports.publicReadLimiter = limiter({
  windowMs: MINUTE,
  limit: 120,
  message: 'Too many requests. Please slow down and try again shortly.',
});

// ── Agent password sign-in / reset / change ─────────────────────────────────

// Password sign-in — only failed attempts count, so signing in correctly
// never uses it up. Per IP; each account also has its own lockout after 5
// wrong passwords (models/users.model.js), which holds against many IPs.
module.exports.passwordLoginLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 15,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this device. Please try again later.',
});

// "Forgot password" — each request can send an email, so it's tight. The
// controller also rate-limits per account (one link a minute, five an hour).
module.exports.forgotPasswordLimiter = limiter({
  windowMs: 60 * MINUTE,
  limit: 8,
  message: 'Too many password reset requests from this device. Please try again later.',
});

// Setting a new password from an emailed link (guessing tokens).
module.exports.resetPasswordLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 15,
  message: 'Too many attempts. Please try again later.',
});

// Changing the password from the Profile (checks the current password), per
// account.
module.exports.changePasswordLimiter = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyBy: 'user',
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
