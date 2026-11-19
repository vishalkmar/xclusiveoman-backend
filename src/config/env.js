require('dotenv/config');

const required = [
  "DATABASE_URL_PROD",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const nodeEnv = process.env.NODE_ENV || "development";

// Production refuses to start on weak or unsafe settings rather than run
// insecurely: short or shared JWT secrets make tokens forgeable, and a
// missing/wildcard CORS_ORIGINS would fall back to localhost or allow any
// site to make credentialed calls. Development keeps its convenient defaults.
if (nodeEnv === "production") {
  const problems = [];
  for (const key of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"]) {
    if (String(process.env[key]).length < 32) problems.push(`${key} must be at least 32 characters`);
  }
  if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    problems.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different");
  }
  const origins = String(process.env.CORS_ORIGINS || "");
  if (!origins.trim()) problems.push("CORS_ORIGINS must list the frontend origin(s)");
  if (origins.split(",").some((o) => o.trim() === "*")) problems.push("CORS_ORIGINS must not contain '*'");
  if (problems.length) {
    throw new Error(`Unsafe production configuration: ${problems.join("; ")}`);
  }
}

const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv,
  // required (above) only checks DATABASE_URL_PROD, but this used to always
  // read process.env.DATABASE_URL regardless of nodeEnv — a cPanel/Passenger
  // deployment that only sets DATABASE_URL_PROD (matching what's actually
  // required at startup) got `databaseUrl: undefined` here, which
  // db/pool.js's mysql.createPool({ uri: undefined }) throws on at require()
  // time, surfacing as Passenger's generic "Web application could not be
  // started" with no clearer error. Production now reads the var that's
  // actually guaranteed to be set; local dev keeps using DATABASE_URL.
  databaseUrl: nodeEnv === "production" ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  // Admin Console login moved to a real per-account bcrypt password
  // (users.password_hash, 0084_admin_password.sql) — this is no longer
  // checked on every login (auth.controller.js#adminLogin doesn't read it
  // at all now), only by scripts/seedAdminPasswords.js to backfill an
  // *initial* password for admin/staff accounts that don't have one yet.
  // Not required at startup for that reason — the running server has no
  // hard dependency on it, unlike JWT_*_SECRET above.
  adminLoginPassword: process.env.ADMIN_LOGIN_PASSWORD || "",
  corsOrigins: (
    process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  agentPortalUrl: process.env.AGENT_PORTAL_URL || "http://localhost:5173/agent",
  // Transactional emails (staff welcome, agent registration/approval —
  // services/emailTemplate.service.js) link straight to each portal's own
  // login page. Both portals are one frontend deployment (AGENT_PORTAL_URL
  // above already documents this), so these are derived from it — stripping
  // its trailing "/agent" gets back to that shared origin — rather than
  // needing a second required env var just for the /admin half.
  get adminLoginUrl() {
    return `${this.agentPortalUrl.replace(/\/agent\/?$/, "")}/admin/login`;
  },
  get agentLoginUrl() {
    return `${this.agentPortalUrl.replace(/\/agent\/?$/, "")}/agent/login`;
  },
  // Lead Managers (sales_manager) and Relationship Managers
  // (relationship_manager) sign in at their own /team route, not
  // /admin/login — a distinctly-themed portal (frontend) scoped to just the
  // Access Features an admin checked for them, rather than the full Admin
  // Console. Same derivation as adminLoginUrl/agentLoginUrl above.
  get teamLoginUrl() {
    return `${this.agentPortalUrl.replace(/\/agent\/?$/, "")}/team/login`;
  },
  // Task 11 (Marketing Center — Open & Click Tracking) — the backend's own
  // publicly-reachable base URL, needed to build absolute tracking-pixel/
  // click-redirect URLs embedded in an outbound email (unlike agentPortalUrl
  // above, which points at the *frontend*). Defaults to this same process's
  // own port for local dev, so tracking works out of the box without any
  // new required configuration.
  apiBaseUrl:
    process.env.API_BASE_URL ||
    `http://localhost:${Number(process.env.PORT || 4000)}`,
  // Absolute, publicly reachable URL of the logo shown in every branded
  // email (services/emailTemplate.service.js). Defaults to the copy this
  // backend serves at /assets (app.js); EMAIL_LOGO_URL overrides it, e.g.
  // with a CDN/Cloudinary URL, or when API_BASE_URL is localhost and mail
  // clients can't reach it.
  get emailLogoUrl() {
    return process.env.EMAIL_LOGO_URL || `${this.apiBaseUrl.replace(/\/$/, "")}/assets/xclusive-oman-logo.png`;
  },
  // Signs/verifies marketing tracking-pixel and click-redirect tokens
  // (services/marketingTracking.service.js). Falls back to
  // JWT_REFRESH_SECRET (already a required startup env var above) so
  // tracking works in every existing deployment with zero new required
  // configuration — a dedicated MARKETING_TRACKING_SECRET is optional, for
  // stricter isolation between the two token purposes.
  marketingTrackingSecret:
    process.env.MARKETING_TRACKING_SECRET || process.env.JWT_REFRESH_SECRET,
  // Brevo (formerly Sendinblue) transactional email HTTP API —
  // services/email.service.js#sendEmail, the sole email transport in this
  // app (SMTP/Nodemailer removed — it isn't usable on Render for outbound
  // mail, and every email here already went through this one shared
  // function, so migrating it centrally covers OTP, registration/approval,
  // staff welcome, Marketing Center, payment confirmations, support
  // tickets, and FD operations in one place). BREVO_SENDER_EMAIL must be a
  // sender verified in Brevo's own dashboard, or sends are rejected
  // regardless of API key validity.
  brevo: {
    apiKey: process.env.BREVO_API_KEY,
    senderEmail: process.env.BREVO_SENDER_EMAIL,
    senderName: process.env.BREVO_SENDER_NAME || "Xclusive Oman",
  },
  whatsappSalesNumber: process.env.WHATSAPP_SALES_NUMBER || "",
  // scripts/seed.js's default super_admin account — set per-environment in
  // .env (see .env.example), no built-in fallback: an unset SEED_ADMIN_EMAIL
  // just means seed.js logs that nothing is configured and skips (see its
  // own DEFAULT_EMAIL check), rather than silently seeding someone's actual
  // inbox as super_admin.
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || "",
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  cashfree: {
    appId: process.env.CASHFREE_APP_ID,
    secretKey: process.env.CASHFREE_SECRET_KEY,
    webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET,
    // Cashfree can be switched between sandbox and production through the
    // deployment environment. Sandbox requires sandbox App ID/Secret Key.
    apiBaseUrl: process.env.CASHFREE_API_BASE_URL || "https://sandbox.cashfree.com/pg",
    // Sent with every create-order response; the agent Payment page opens
    // the checkout JS SDK in this mode.
    mode: (process.env.CASHFREE_API_BASE_URL || "").includes("sandbox") ? "sandbox" : "production",
    // Cashfree doesn't settle in OMR — orders are opened in this currency,
    // converted from the booking's OMR amount (services/fx.service.js).
    currency: (process.env.CASHFREE_CURRENCY || "INR").toUpperCase(),
    // Cashfree's sandbox automation account can use a fixed OTP so the bot
    // can sign in without waiting for email delivery. This is enabled only
    // when the configured Cashfree endpoint is the sandbox endpoint.
    testLoginEmail: (process.env.CASHFREE_TEST_LOGIN_EMAIL || "test@traveon.in").trim().toLowerCase(),
    testLoginOtp: process.env.CASHFREE_TEST_LOGIN_OTP || "123456",
  },
  // External exchange-rate API used for that conversion. Must return
  // { rates: { INR: ... } } (open.er-api.com) or { conversion_rates: {...} }
  // (exchangerate-api.com v6, e.g. https://v6.exchangerate-api.com/v6/<KEY>/latest/OMR)
  // with OMR as the base currency.
  fx: {
    apiUrl: process.env.FX_API_URL || "https://open.er-api.com/v6/latest/OMR",
  },
  // Visa photo verification (services/visaPhotoCheck.service.js) — Google
  // Gemini's free tier (key from https://aistudio.google.com/apikey). Unset
  // key = the AI checks are skipped and photos are saved as needs_review
  // for staff to verify by eye.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY || "",
    model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  },
};

module.exports.env = env;
