// Security regression tests — run with `npm run test:security`.
//
// Boots the real Express app + Socket.IO in-process on a random port against
// the configured (development) database, and checks the protections added in
// the security hardening pass: authN/authZ, cross-agency access (IDOR),
// session revocation, rate limits, input/URL validation, upload content
// checks, error hygiene, catalog scoping and socket authentication. Every
// probe is harmless (no destructive input); the few rows it creates (a temp
// agency + user) are removed at the end. Never point this at production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createApp } = require('../src/app.js');
const { initSockets } = require('../src/sockets/index.js');
const { pool } = require('../src/db/pool.js');
const { newId } = require('../src/utils/id.js');
const {
  signAccessToken,
  signRefreshToken,
  signFdItineraryPdfToken,
} = require('../src/services/auth.service.js');
const { findUserById } = require('../src/models/users.model.js');

// socket.io-client lives in the frontend repo (the backend never needs it).
let ioClient = null;
try {
  ioClient = require(path.resolve(__dirname, '../../xclusiveoman-agent-portal-fe/node_modules/socket.io-client'));
} catch {
  /* socket test is skipped below */
}

let server;
let base;
let agentA; // agency with bookings
let agentB; // a different agency
let staff; // super_admin
let tempAgencyId;
let tempUserId;

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const bearer = (user) => ({ Authorization: `Bearer ${signAccessToken(user)}` });

async function api(pathname, { method = 'GET', headers = {}, body, raw } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  initSockets(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;

  const agents = await q(
    `SELECT u.* FROM users u WHERE u.status = 'active' AND u.agency_id IS NOT NULL
     ORDER BY (SELECT COUNT(*) FROM bookings b WHERE b.agency_id = u.agency_id) DESC`
  );
  agentA = agents[0];
  agentB = agents.find((u) => u.agency_id !== agentA.agency_id);
  [staff] = await q(`SELECT * FROM users WHERE status = 'active' AND role = 'super_admin' LIMIT 1`);
  assert.ok(agentA && agentB && staff, 'needs two agencies and a super_admin in the dev database');

  // Throwaway agent for the session-revocation test (logout bumps the
  // user's token_version, which would sign a real dev user out).
  tempAgencyId = newId();
  tempUserId = newId();
  await q(`INSERT INTO agencies (id, name, type, country, status) VALUES (?, 'Security Test Agency', 'travel_agent', 'Oman', 'approved')`, [tempAgencyId]);
  await q(
    `INSERT INTO users (id, agency_id, role, full_name, email, status) VALUES (?, ?, 'agency_owner', 'Security Test', ?, 'active')`,
    [tempUserId, tempAgencyId, `security-test-${Date.now()}@example.com`]
  );
});

after(async () => {
  if (tempUserId) await q('DELETE FROM users WHERE id = ?', [tempUserId]);
  if (tempAgencyId) await q('DELETE FROM agencies WHERE id = ?', [tempAgencyId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ── Authentication / authorization ────────────────────────────────────────

test('protected routes reject requests without a token (401)', async () => {
  for (const p of ['/bookings', '/admin/dashboard-stats', '/agencies/me', '/notifications']) {
    const r = await api(p);
    assert.equal(r.status, 401, p);
  }
});

test('an agent token cannot reach admin routes (403)', async () => {
  for (const p of ['/admin/dashboard-stats', '/admin/employees', '/admin/transactions', '/admin/support/tickets', '/admin/marketing/campaigns']) {
    const r = await api(p, { headers: bearer(agentA) });
    assert.equal(r.status, 403, p);
  }
});

test('a forged token (wrong secret) and a narrow-purpose PDF token are refused as sessions', async () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ sub: agentA.id, role: 'super_admin' }, 'not-the-real-secret');
  assert.equal((await api('/bookings', { headers: { Authorization: `Bearer ${forged}` } })).status, 401);

  const none = jwt.sign({ sub: staff.id, role: 'super_admin' }, '', { algorithm: 'none' });
  assert.equal((await api('/admin/dashboard-stats', { headers: { Authorization: `Bearer ${none}` } })).status, 401);

  const pdfToken = signFdItineraryPdfToken({ userId: agentA.id, departureId: 'x' });
  assert.equal((await api('/bookings', { headers: { Authorization: `Bearer ${pdfToken}` } })).status, 401);
});

test("an agent cannot read another agency's booking, payment status or documents (IDOR)", async () => {
  const [booking] = await q('SELECT id FROM bookings WHERE agency_id = ? LIMIT 1', [agentA.agency_id]);
  assert.ok(booking, 'agentA needs a booking');
  // The owner can see it…
  assert.equal((await api(`/bookings/${booking.id}`, { headers: bearer(agentA) })).status, 200);
  // …another agency gets 404 (not 403, so existence isn't confirmed either).
  for (const p of [`/bookings/${booking.id}`, `/bookings/${booking.id}/documents`]) {
    assert.equal((await api(p, { headers: bearer(agentB) })).status, 404, p);
  }
  const [payment] = await q('SELECT id FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE agency_id = ?) LIMIT 1', [agentA.agency_id]);
  if (payment) {
    assert.equal((await api(`/payments/${payment.id}`, { headers: bearer(agentB) })).status, 404);
  }
  // …and its own list never contains it.
  const list = await api('/bookings', { headers: bearer(agentB) });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.json).includes(booking.id));
});

// ── Sessions ──────────────────────────────────────────────────────────────

test('logout revokes the refresh token and outstanding access tokens', async () => {
  const user = await findUserById(tempUserId);
  const access = signAccessToken(user);
  const cookie = `xo_refresh=${signRefreshToken(user)}`; // auth.controller.js's REFRESH_COOKIE_NAME

  assert.equal((await api('/auth/refresh', { method: 'POST', headers: { cookie } })).status, 200, 'refresh works before logout');
  assert.equal((await api('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${access}` } })).status, 204);
  assert.equal((await api('/auth/refresh', { method: 'POST', headers: { cookie } })).status, 401, 'old refresh cookie is dead');
  assert.equal((await api('/agencies/me', { headers: { Authorization: `Bearer ${access}` } })).status, 401, 'old access token is dead');
});

// ── Input validation / XSS ────────────────────────────────────────────────

test('registration refuses javascript:, data: and http: URLs (stored XSS)', async () => {
  const baseBody = {
    agencyName: 'XSS Test', agencyType: 'travel_agent', country: 'Oman', ownerFullName: 'X Test',
    email: `xss-${Date.now()}@example.com`, phone: '+96890000000', licenseDocumentType: 'gst', licenseNumber: 'X1',
  };
  for (const bad of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'http://example.com/a.pdf']) {
    const r = await api('/auth/register', { method: 'POST', body: { ...baseBody, licenseDocumentUrl: bad } });
    assert.equal(r.status, 400, bad);
  }
});

test('SQL metacharacters in search/filter input are treated as data, not SQL', async () => {
  const probes = ["' OR '1'='1", "1; DROP TABLE bookings; --", "%' UNION SELECT password_hash FROM users -- "];
  for (const probe of probes) {
    const r = await api(`/admin/bookings?search=${encodeURIComponent(probe)}`, { headers: bearer(staff) });
    assert.equal(r.status, 200, probe);
    assert.equal(r.json.bookings?.length ?? r.json.rows?.length ?? 0, 0, `no rows match ${probe}`);
  }
  const [{ n }] = await q('SELECT COUNT(*) n FROM bookings');
  assert.ok(Number(n) > 0, 'bookings table intact');
});

test('malformed and oversized JSON bodies are rejected without internals', async () => {
  const bad = await api('/auth/request-otp', { method: 'POST', headers: { 'content-type': 'application/json' }, raw: '{"email":' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_json');
  assert.ok(!/at .*\.js:\d+/.test(bad.text), 'no stack trace');

  const big = await api('/auth/request-otp', { method: 'POST', body: { email: 'a@b.co', pad: 'x'.repeat(200 * 1024) } });
  assert.equal(big.status, 413);
});

// ── Uploads ───────────────────────────────────────────────────────────────

test('uploads whose content does not match the declared type are rejected', async () => {
  const fd = new FormData();
  fd.append('logo', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'logo.png');
  const r = await fetch(`${base}/auth/register/logo`, { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'upload_rejected');

  const html = new FormData();
  html.append('logo', new Blob(['<html></html>'], { type: 'text/html' }), 'x.html');
  assert.equal((await fetch(`${base}/auth/register/logo`, { method: 'POST', body: html })).status, 400);
});

// ── Data exposure ─────────────────────────────────────────────────────────

test('agents only see published catalog items and never the hotel supplier email', async () => {
  const asAgent = await api('/hotels', { headers: bearer(agentA) });
  assert.equal(asAgent.status, 200);
  for (const h of asAgent.json.hotels) {
    assert.equal(h.email, undefined, 'hotel email hidden from agents');
    if (h.status !== undefined) assert.equal(h.status, 'published');
  }
  const drafts = await api('/hotels?status=draft', { headers: bearer(agentA) });
  assert.ok(drafts.json.hotels.every((h) => h.status === undefined || h.status === 'published'), 'status=draft ignored for agents');

  const [draft] = await q(`SELECT id FROM hotels WHERE status = 'draft' LIMIT 1`);
  if (draft) assert.equal((await api(`/hotels/${draft.id}`, { headers: bearer(agentA) })).status, 404);

  const asStaff = await api('/hotels', { headers: bearer(staff) });
  assert.equal(asStaff.status, 200);
});

test('API responses are not cacheable and do not advertise the framework', async () => {
  const r = await api('/agencies/me', { headers: bearer(agentA) });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('x-content-type-options'));
});

test('unknown routes return a plain JSON 404', async () => {
  const r = await api('/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not_found');
});

// ── Rate limits ───────────────────────────────────────────────────────────

test('repeated OTP verification attempts are rate limited with 429 + Retry-After', async () => {
  let limited = null;
  for (let i = 0; i < 25 && !limited; i += 1) {
    const r = await api('/auth/verify-otp', { method: 'POST', body: { email: 'nobody@example.com', otp: '000000' } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'got a 429 within 25 attempts');
  assert.equal(limited.json.error, 'rate_limited');
  assert.ok(limited.headers.get('retry-after'), 'Retry-After header present');
});

test('concurrent registration bursts are rate limited', async () => {
  const body = { agencyName: 'x' }; // invalid on purpose — the limiter runs before validation
  const results = await Promise.all(Array.from({ length: 15 }, () => api('/auth/register', { method: 'POST', body })));
  assert.ok(results.some((r) => r.status === 429), 'some of 15 parallel sign-ups were limited');
});

// ── WebSockets ────────────────────────────────────────────────────────────

test('sockets refuse missing, purpose-scoped and revoked tokens, and accept a valid session', { skip: !ioClient }, async () => {
  const origin = base.replace('/api', '');
  const tryConnect = (token) =>
    new Promise((resolve) => {
      const socket = ioClient.io(origin, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, timeout: 4000 });
      socket.on('connect', () => {
        socket.close();
        resolve('connected');
      });
      socket.on('connect_error', (err) => {
        socket.close();
        resolve(err.message);
      });
    });

  assert.equal(await tryConnect(null), 'unauthorized');
  assert.equal(await tryConnect(signFdItineraryPdfToken({ userId: agentA.id, departureId: 'x' })), 'unauthorized');
  assert.equal(await tryConnect(signAccessToken(agentA)), 'connected');

  // A token issued before the temp user signed out (previous test) is revoked.
  const stale = signAccessToken({ ...(await findUserById(tempUserId)), token_version: 0 });
  assert.equal(await tryConnect(stale), 'unauthorized');
});
