const crypto = require('node:crypto');

const {
  env
} = require('../config/env.js');

const {
  CURRENCY
} = require('../utils/currency.js');

function ensureConfigured() {
  if (!env.cashfree.appId || !env.cashfree.secretKey) {
    throw Object.assign(new Error('Cashfree is not configured (set CASHFREE_* in .env)'), {
      status: 503,
      publicCode: 'payments_unavailable',
    });
  }
}

const CF_HEADERS = () => ({
  'Content-Type': 'application/json',
  'x-client-id': env.cashfree.appId,
  'x-client-secret': env.cashfree.secretKey,
  'x-api-version': '2023-08-01',
});

// Never leak Cashfree's raw error/credentials to the client (spec P) — a
// generic 502 with our own publicCode, matching the pattern createOrder
// already used.
function cashfreeError(fallback) {
  const err = new Error(fallback);
  err.status = 502;
  err.publicCode = 'cashfree_error';
  return err;
}

// Live Cashfree rejects any return_url/notify_url that isn't https, so an
// AGENT_PORTAL_URL/API_BASE_URL deployed as plain http:// is upgraded here
// rather than failing every checkout. Both domains are served over https.
function toHttps(url) {
  // Local Vite/API development servers normally speak plain HTTP. Rewriting
  // localhost to HTTPS makes Cashfree return to an SSL endpoint that does not
  // exist and causes ERR_SSL_PROTOCOL_ERROR after payment. Deployed domains
  // remain HTTPS as required by Cashfree.
  try {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return url;
  } catch {
    // Fall through to the safe HTTPS rewrite for malformed/unparseable URLs.
  }
  return url.replace(/^http:\/\//i, 'https://');
}

// `amount`/`currency` are the gateway-side values (INR, already converted
// from OMR by the caller via fx.service.js). Booking orders pass `bookingId`;
// other payments (visa fees) pass their own `orderId`, `orderTag` and the
// agent-portal `returnPath` Cashfree sends the agent back to.
async function createOrder({
  bookingId,
  orderId,
  orderTag,
  returnPath = '/payments/return',
  amount,
  currency = CURRENCY,
  customerEmail,
  customerPhone,
  customerId,
  expiresInMinutes,
}) {
  ensureConfigured();

  const res = await fetch(`${env.cashfree.apiBaseUrl}/orders`, {
    method: 'POST',
    headers: CF_HEADERS(),
    body: JSON.stringify({
      order_id: orderId || `booking-${bookingId}-${Date.now()}`,
      order_amount: amount,
      order_currency: currency,
      order_tag: orderTag || bookingId,
      // Cashfree rejects an expiry that isn't more than 15 minutes away, so the
      // seat-hold length gets 30s of headroom — the order still lapses on the
      // gateway right as our hold does.
      ...(expiresInMinutes
        ? { order_expiry_time: new Date(Date.now() + (expiresInMinutes * 60 + 30) * 1000).toISOString() }
        : {}),
      customer_details: {
        customer_id: customerId,
        customer_email: customerEmail,
        customer_phone: customerPhone || '0000000000',
      },
      order_meta: {
        // Cashfree substitutes {order_id} on redirect. agentPortalUrl already
        // ends in "/agent" (see config/env.js), so this lands on the SPA's
        // /agent/payments/return route which drives GET /api/payments polling.
        return_url: toHttps(`${env.agentPortalUrl}${returnPath}?order_id={order_id}`),
        notify_url: toHttps(`${env.apiBaseUrl}/api/webhooks/cashfree`),
      },
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw cashfreeError(data?.message || 'Cashfree order creation failed');
  }

  return { orderId: data.order_id, paymentSessionId: data.payment_session_id };
}

module.exports.createOrder = createOrder;

async function getOrder(orderId) {
  ensureConfigured();
  try {
    const res = await fetch(`${env.cashfree.apiBaseUrl}/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: CF_HEADERS(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

module.exports.getOrder = getOrder;

async function getOrderPayments(orderId) {
  ensureConfigured();
  try {
    const res = await fetch(`${env.cashfree.apiBaseUrl}/orders/${encodeURIComponent(orderId)}/payments`, {
      method: 'GET',
      headers: CF_HEADERS(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

module.exports.getOrderPayments = getOrderPayments;

async function terminateOrder(orderId) {
  ensureConfigured();
  try {
    const res = await fetch(`${env.cashfree.apiBaseUrl}/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      headers: CF_HEADERS(),
      body: JSON.stringify({ order_status: 'TERMINATED' }),
    });
    return { terminated: res.ok };
  } catch {
    return { terminated: false };
  }
}

module.exports.terminateOrder = terminateOrder;

function verifyWebhookSignature({ rawBody, timestamp, signature }) {
  if (!env.cashfree.webhookSecret || !signature || !timestamp) return false;

  const expected = crypto
    .createHmac('sha256', env.cashfree.webhookSecret)
    .update(timestamp + rawBody)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch etc. -> not authentic
  }
}

module.exports.verifyWebhookSignature = verifyWebhookSignature;
