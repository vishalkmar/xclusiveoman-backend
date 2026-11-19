const fs = require('node:fs/promises');
const path = require('node:path');

const {
  env
} = require('../config/env.js');

const {
  CURRENCY,
  roundMoney
} = require('../utils/currency.js');

// OMR <-> gateway currency (INR) conversion for Cashfree checkout. The rate
// comes from an external FX API (FX_API_URL, open.er-api.com by default —
// free, no key). A nightly job (jobs/fxRate.job.js) fetches the day's rate
// once and saves it to `savedRate` and to RATE_FILE (so it survives a
// restart), and getRate reads that — calling the API itself only as a
// fallback when no usable saved rate exists. open.er-api.com updates once a
// day anyway, so this loses nothing and keeps us far under its rate limit. The rate used for an order
// is stored on its payment row (payments.fx_rate) and reused to convert
// Cashfree's paid amount back to OMR, so a rate change between checkout and
// webhook can never leave a booking a few baisa short of its deposit.

const FETCH_TIMEOUT_MS = 15 * 1000;
// If the nightly job keeps failing, stop charging at an old rate after this.
const MAX_SAVED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROVIDER_AGE_S = 48 * 60 * 60;
const FALLBACK_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_FILE = path.join(__dirname, '..', '..', 'storage', 'fx-rate.json');

let savedRate = null; // { baseCurrency, targetCurrency, rate, providerUpdatedAt, fetchedAt }
let inFlightRefresh = null;
let lastFallbackFailedAt = 0;

function fxError(message) {
  return Object.assign(new Error(message), { status: 503, publicCode: 'fx_unavailable' });
}

// One call to the FX API. Returns the `target` rate plus the raw response.
async function fetchRate(target) {
  const res = await fetch(env.fx.apiUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  if (data?.result && data.result !== 'success') throw new Error(`FX API result: ${data.result}`);
  if (data?.base_code && data.base_code !== CURRENCY) throw new Error(`FX API base is ${data.base_code}, expected ${CURRENCY}`);

  // open.er-api.com returns `rates`, exchangerate-api.com v6 `conversion_rates`.
  const rate = Number((data?.rates || data?.conversion_rates || {})[target]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`No valid ${target} rate in FX response`);
  return { rate, data };
}

// The nightly rate, from memory or (after a restart) from RATE_FILE.
async function loadSavedRate() {
  if (savedRate) return savedRate;
  try {
    const parsed = JSON.parse(await fs.readFile(RATE_FILE, 'utf8'));
    if (Number.isFinite(parsed?.rate) && parsed.rate > 0) savedRate = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('fx saved rate unreadable', err.message);
  }
  return savedRate;
}

module.exports.loadSavedRate = loadSavedRate;

function isUsable(saved, target) {
  if (!saved || saved.targetCurrency !== target) return false;
  return Date.now() - Date.parse(saved.providerUpdatedAt) < MAX_SAVED_AGE_MS;
}

// Units of `target` per 1 OMR. Normally just the nightly saved rate, no API
// call. Fallback: if there is no usable saved rate (nightly job never ran or
// kept failing), run the same fetch-and-save now. After a failed attempt it
// waits FALLBACK_COOLDOWN_MS before trying again, so a run of "Pay" clicks
// during an outage can't hammer the API into a 429.
async function getRate(target = env.cashfree.currency) {
  if (target === CURRENCY) return 1;

  const saved = await loadSavedRate();
  if (isUsable(saved, target)) return saved.rate;

  if (Date.now() - lastFallbackFailedAt > FALLBACK_COOLDOWN_MS) {
    try {
      const fresh = await refreshSavedRate(target);
      console.warn(`fx no usable saved rate, fetched on demand: ${fresh.rate}`);
      return fresh.rate;
    } catch (err) {
      lastFallbackFailedAt = Date.now();
      console.error('fx on-demand rate fetch failed', err.message);
    }
  }

  throw fxError('Currency conversion is temporarily unavailable. Please try again shortly.');
}

module.exports.getRate = getRate;

// Fetches today's rate and saves it (memory + RATE_FILE) — the nightly job,
// and getRate's fallback. Concurrent callers share one in-flight fetch.
// Throws without touching the saved rate if the response is invalid or
// stale, so a bad fetch never replaces a good rate.
function refreshSavedRate(target = env.cashfree.currency) {
  if (!inFlightRefresh) {
    inFlightRefresh = fetchAndSaveRate(target).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

module.exports.refreshSavedRate = refreshSavedRate;

async function fetchAndSaveRate(target) {
  if (target === CURRENCY) return null;

  const { rate, data } = await fetchRate(target);
  const updatedAt = Number(data.time_last_update_unix);
  const now = Date.now() / 1000;
  if (!Number.isFinite(updatedAt) || updatedAt > now + 300 || now - updatedAt > MAX_PROVIDER_AGE_S) {
    throw new Error('FX rate timestamp is invalid or older than 48 hours');
  }

  const next = {
    baseCurrency: CURRENCY,
    targetCurrency: target,
    rate,
    providerUpdatedAt: new Date(updatedAt * 1000).toISOString(),
    fetchedAt: new Date().toISOString()
  };

  // Write to a temp file and rename, so a crash mid-write can't corrupt it.
  await fs.mkdir(path.dirname(RATE_FILE), { recursive: true });
  const tempFile = `${RATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(next, null, 2));
  await fs.rename(tempFile, RATE_FILE);

  savedRate = next;
  return next;
}

// Gateway currencies (INR) have 2 decimals.
function roundGateway(amount) {
  return Math.round((Number(amount) || 0) * 100) / 100;
}

// OMR -> gateway currency at the saved nightly rate. Returns the amount to charge plus
// the rate, which the caller persists for the reverse conversion.
async function toGatewayCurrency(omrAmount) {
  const currency = env.cashfree.currency;
  const rate = await getRate(currency);
  return { currency, rate, amount: roundGateway(Number(omrAmount) * rate) };
}

module.exports.toGatewayCurrency = toGatewayCurrency;

// Gateway currency -> OMR using the rate locked on the payment row.
function fromGatewayCurrency(gatewayAmount, rate) {
  return roundMoney(Number(gatewayAmount) / Number(rate));
}

module.exports.fromGatewayCurrency = fromGatewayCurrency;
