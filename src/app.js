const path = require('node:path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');

const {
  env
} = require('./config/env.js');

const routes = require('./routes/index.js');
const webhooksRoutes = require('./routes/webhooks.routes.js');

const {
  notFoundHandler,
  errorHandler
} = require('./middleware/errorHandler.js');

const {
  globalApiLimiter
} = require('./middleware/rateLimiter.js');
const { readablePath } = require('./middleware/readablePath.js');

// Access logs must never record credentials. Short-lived tokens travel in
// URLs (the itinerary print page's ?pdfToken=, marketing tracking links'
// /open/:token and /click/:token), and the print page's URL also arrives as
// the Referer of its data request — so both are masked before logging.
function redactUrl(url) {
  return String(url || '')
    .replace(/([?&](?:pdfToken|token|otp|code|key|signature)=)[^&#]*/gi, '$1[redacted]')
    .replace(/(\/(?:open|click)\/)[^/?#]+/g, '$1[redacted]');
}

morgan.token('safe-url', (req) => redactUrl(req.originalUrl || req.url));
morgan.token('safe-referrer', (req) => redactUrl(req.headers.referer || req.headers.referrer || ''));

const PROD_LOG_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":safe-referrer" ":user-agent"';
const DEV_LOG_FORMAT = ':method :safe-url :status :response-time ms - :res[content-length]';

function createApp() {
  const app = express();

  // Needed for express-rate-limit (middleware/rateLimiter.js) to key off the
  // real client IP rather than the reverse proxy's — the deployed backend
  // sits behind one (see refreshCookieOptions' own sameSite/secure split in
  // auth.controller.js for another spot that already assumes a prod proxy).
  // '1' trusts exactly one hop, matching a single load balancer/PaaS proxy.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // Helmet's default Cross-Origin-Resource-Policy is 'same-origin', which
      // the browser enforces independently of CORS: with the frontend and
      // this API now on different origins (xclusiveoman.com vs
      // backend.xclusiveoman.com) by design, that default would silently
      // block every response from being read cross-origin even though the
      // cors() middleware below allows it — devtools shows this as "blocked
      // by CORP", not a CORS error, so it's easy to miss.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    })
  );
  app.use(cookieParser());

  // Public static assets — the email logo is linked from here
  // (env.emailLogoUrl) rather than embedded in each email as a base64 data
  // URI, which Gmail refuses to render and which pushed messages past
  // Gmail's ~102KB clipping limit.
  app.use('/assets', express.static(path.resolve(__dirname, 'assets'), { maxAge: '7d' }));

  // Mounted before express.json() so the Cashfree webhook gets the exact raw
  // body bytes it needs to verify the signature (doc §14.1/§16).
  app.use('/api/webhooks', webhooksRoutes);

  // JSON bodies only, capped at 100kb (express's default, made explicit) —
  // oversized bodies are refused with 413 before any route runs.
  app.use(express.json({ limit: '100kb' }));
  app.use(morgan(env.nodeEnv === 'production' ? PROD_LOG_FORMAT : DEV_LOG_FORMAT));

  // API responses carry private data (bookings, payments, profiles) — never
  // let a browser or shared proxy cache them.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Per-IP ceiling on every API request (middleware/rateLimiter.js), on top
  // of the stricter per-route limits. The Cashfree webhook above is mounted
  // first, so it's never throttled.
  app.use('/api', globalApiLimiter);

  app.use('/api', readablePath(routes));
  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports.createApp = createApp;
