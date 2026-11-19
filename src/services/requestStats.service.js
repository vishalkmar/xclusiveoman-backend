const {
  roundMoney
} = require('../utils/currency.js');

// Shared statistics for the two quote pipelines — Custom FIT (package_requests,
// admin Quote Inbox) and MICE (mice_rfqs, admin MICE Requests). Both have the
// same shape (status, created_at, published_at, sell_price, lead manager,
// agency, destination, a party size and a trip/event start date), so one
// aggregator serves both; only the status vocabulary differs, passed in as a
// pipeline config below.
//
// Rows arrive already filtered by the list's own filters (minus `status`, so
// the status cards/tabs can show every status's count for the current view)
// and already scoped to the viewer (RM/LM Team Portal scoping).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const toMs = (value) => (value ? new Date(value).getTime() : null);
const round1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const money = roundMoney;
const avg = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

// Funnel stage each status implies the request has *reached*. Lost outcomes
// (declined/expired) sit at the "quoted" stage — a request can't be declined
// or expire before a quote exists in either flow's UI.
const PIPELINES = {
  fit: {
    stages: ['Submitted', 'Assigned', 'Costed', 'Quoted', 'Accepted', 'Converted'],
    stageOf: { submitted: 0, assigned: 1, costed: 2, published: 3, revision_requested: 3, declined: 3, expired: 3, accepted: 4, converted: 5 },
    open: ['submitted', 'assigned', 'costed', 'revision_requested'],
    quoted: ['published', 'revision_requested', 'accepted', 'declined', 'expired', 'converted'],
    won: ['accepted', 'converted'],
    lost: ['declined', 'expired'],
    live: ['published', 'revision_requested'],
    sizeBuckets: [[1, 2, '1–2 pax'], [3, 4, '3–4 pax'], [5, 8, '5–8 pax'], [9, 15, '9–15 pax'], [16, Infinity, '16+ pax']],
  },
  mice: {
    stages: ['Submitted', 'RFP Sent', 'Supplier Quotes', 'Costed', 'Proposal Sent', 'Accepted', 'Converted'],
    stageOf: {
      draft: 0, submitted: 0, rfp_dispatched: 1, supplier_responses_pending: 1, supplier_responses_received: 2, costed: 3,
      published: 4, revision_requested: 4, negotiating: 4, declined: 4, expired: 4, accepted: 5, converted: 6,
    },
    open: ['submitted', 'rfp_dispatched', 'supplier_responses_pending', 'supplier_responses_received', 'costed', 'revision_requested', 'negotiating'],
    quoted: ['published', 'revision_requested', 'negotiating', 'accepted', 'declined', 'expired', 'converted'],
    won: ['accepted', 'converted'],
    lost: ['declined', 'expired'],
    live: ['published', 'revision_requested', 'negotiating'],
    sizeBuckets: [[1, 20, '1–20'], [21, 50, '21–50'], [51, 100, '51–100'], [101, 250, '101–250'], [251, Infinity, '250+']],
  },
};

// Month (or day, for short ranges) buckets across the submission window. The
// browser's getTimezoneOffset() keeps buckets on the admin's own calendar.
function buildBuckets({ fromMs, toMs: endMs, tz }) {
  const shift = (ms) => new Date(ms - tz * 60000);
  const unshift = (y, m, d = 1) => Date.UTC(y, m, d) + tz * 60000;
  const span = endMs - fromMs;
  const unit = span <= 62 * DAY ? 'day' : 'month';
  const startOf = (ms) => {
    const d = shift(ms);
    return unit === 'day' ? unshift(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : unshift(d.getUTCFullYear(), d.getUTCMonth());
  };
  const next = (ms) => {
    const d = shift(ms);
    return unit === 'day' ? unshift(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : unshift(d.getUTCFullYear(), d.getUTCMonth() + 1);
  };
  const buckets = [];
  for (let cursor = startOf(fromMs); cursor < endMs && buckets.length < 400; cursor = next(cursor)) {
    buckets.push({ start: cursor, end: next(cursor) });
  }
  return { unit, buckets };
}

function topBy(rows, keyFn, labelFn, limit = 8, extra = () => ({})) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key == null || key === '') continue;
    const g = groups.get(key) || { key, label: labelFn(r), count: 0, rows: [] };
    g.count += 1;
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(({ rows: groupRows, ...g }) => ({ ...g, ...extra(groupRows) }));
}

/**
 * @param {object} args
 * @param {'fit'|'mice'} args.pipeline
 * @param {Array} args.rows       raw DB rows (status, created_at, published_at, sell_price,
 *                                lead_manager_user_id, lead_manager_full_name, agency_id,
 *                                agency_name, destination)
 * @param {(row) => number} args.sizeOf   party size (pax / group size)
 * @param {(row) => any} args.startOf     trip/event start date
 * @param {{ from?: string, to?: string }} args.window  the submission-date filter, if any
 * @param {number} args.tz
 */
function buildRequestStats({ pipeline, rows, sizeOf, startOf, window = {}, tz = 0, now = Date.now() }) {
  const p = PIPELINES[pipeline];
  const inSet = (list) => (r) => list.includes(r.status);

  const statusCounts = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  const quoted = rows.filter(inSet(p.quoted));
  const won = rows.filter(inSet(p.won));
  const lost = rows.filter(inSet(p.lost));
  const decided = won.length + lost.length;
  const turnaroundHours = rows
    .filter((r) => r.published_at)
    .map((r) => (toMs(r.published_at) - toMs(r.created_at)) / HOUR)
    .filter((h) => h >= 0);
  const sizes = rows.map(sizeOf).filter((n) => Number(n) > 0);
  const sumValue = (list) => money(list.reduce((s, r) => s + (Number(r.sell_price) || 0), 0));

  const kpis = {
    total: rows.length,
    open: rows.filter(inSet(p.open)).length,
    unassigned: rows.filter((r) => !r.lead_manager_user_id && p.open.includes(r.status)).length,
    quoted: quoted.length,
    won: won.length,
    lost: lost.length,
    quoteRate: rows.length ? round1((quoted.length / rows.length) * 100) : null,
    winRate: decided ? round1((won.length / decided) * 100) : null,
    avgTurnaroundHours: round1(avg(turnaroundHours)),
    medianTurnaroundHours: turnaroundHours.length ? round1([...turnaroundHours].sort((a, b) => a - b)[Math.floor(turnaroundHours.length / 2)]) : null,
    pipelineValue: sumValue(rows.filter(inSet(p.live))),
    wonValue: sumValue(won),
    avgDealValue: won.length ? money(sumValue(won) / won.length) : null,
    avgSize: round1(avg(sizes.map(Number))),
    totalPeople: sizes.reduce((s, n) => s + Number(n), 0),
  };

  // Trend — submissions vs quotes sent vs wins over the selected window
  // (or the last 6 months when no submission-date filter is set).
  const fromMs = window.from ? toMs(window.from) : (() => {
    const d = new Date(now - tz * 60000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1) + tz * 60000;
  })();
  const endMs = window.to ? toMs(window.to) + DAY : now;
  const { unit, buckets } = buildBuckets({ fromMs, toMs: endMs, tz });
  const within = (ms, b) => ms != null && ms >= b.start && ms < b.end;
  const trend = buckets.map((b) => ({
    at: new Date(b.start).toISOString(),
    submitted: rows.filter((r) => within(toMs(r.created_at), b)).length,
    quoted: rows.filter((r) => within(toMs(r.published_at), b)).length,
    // Cohort view: of the requests submitted in this bucket, how many are won.
    // (There's no accepted_at column, and updated_at moves on any later edit.)
    won: won.filter((r) => within(toMs(r.created_at), b)).length,
    value: sumValue(rows.filter((r) => within(toMs(r.published_at), b))),
  }));

  const funnel = p.stages.map((label, index) => ({
    stage: label,
    count: rows.filter((r) => (p.stageOf[r.status] ?? 0) >= index).length,
  }));

  const sizeDistribution = p.sizeBuckets.map(([lo, hi, label]) => ({
    label,
    count: rows.filter((r) => {
      const n = Number(sizeOf(r));
      return n >= lo && n <= hi;
    }).length,
  }));

  // Upcoming trips/events by start month — next 6 months, live requests only
  // (lost ones won't travel).
  const nowLocal = new Date(now - tz * 60000);
  const upcoming = Array.from({ length: 6 }, (_, i) => {
    const start = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + i, 1);
    const end = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + i + 1, 1);
    const list = rows.filter((r) => {
      if (p.lost.includes(r.status)) return false;
      const d = startOf(r);
      if (!d) return false;
      const ms = typeof d === 'string' ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
      return ms >= start && ms < end;
    });
    return { at: new Date(start).toISOString(), count: list.length, people: list.reduce((s, r) => s + (Number(sizeOf(r)) || 0), 0), confirmed: list.filter(inSet(p.won)).length };
  });

  const valueOf = (groupRows) => ({
    won: groupRows.filter(inSet(p.won)).length,
    value: sumValue(groupRows.filter(inSet(p.won))),
  });

  const leadManagers = topBy(
    rows,
    (r) => r.lead_manager_user_id || 'unassigned',
    (r) => r.lead_manager_full_name || 'Unassigned',
    10,
    (groupRows) => {
      const hours = groupRows.filter((r) => r.published_at).map((r) => (toMs(r.published_at) - toMs(r.created_at)) / HOUR).filter((h) => h >= 0);
      return {
        open: groupRows.filter(inSet(p.open)).length,
        quoted: groupRows.filter(inSet(p.quoted)).length,
        ...valueOf(groupRows),
        avgTurnaroundHours: round1(avg(hours)),
      };
    }
  ).sort((a, b) => (a.key === 'unassigned') - (b.key === 'unassigned') || b.count - a.count);

  return {
    total: rows.length,
    statusCounts,
    kpis,
    trend: { unit, points: trend },
    funnel,
    topDestinations: topBy(rows, (r) => String(r.destination || '').trim().toLowerCase(), (r) => String(r.destination || '').trim(), 8, valueOf),
    topAgencies: topBy(rows, (r) => r.agency_id, (r) => r.agency_name, 8, valueOf),
    leadManagers,
    sizeDistribution,
    upcoming,
  };
}

module.exports.buildRequestStats = buildRequestStats;
module.exports.REQUEST_PIPELINES = PIPELINES;
