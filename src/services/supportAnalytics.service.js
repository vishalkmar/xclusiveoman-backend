const {
  listTicketsForAnalytics,
  CLOSED_STATUSES
} = require('../models/supportTickets.model.js');

// Chat Logs & Analytics (admin Support Center → Show Analytics). Every
// widget on the dashboard is derived here from ONE filtered set of
// conversations, so a filter can never change one chart but not another.
//
// Two sets are built per request:
//   base   — every filter except the date range. Used by things that are
//            anchored to fixed calendar periods (Resolved Today/Week/Month/
//            Year, Resolution Overview) and by the live Needs Attention queue,
//            which must not hide a chat just because it started 40 days ago.
//   scoped — base ∩ date range (on conversation creation). Everything else.
//
// Support volume is small (one chat per agency, typically), so this loads the
// scoped rows and aggregates in JS rather than as a dozen GROUP BY queries.
// If volume ever grows, the filter/aggregate functions below are the seam to
// push down into SQL without touching the controller or the frontend.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STATUSES = ['new', 'open', 'waiting_admin', 'waiting_user', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CATEGORIES = ['booking', 'payment', 'cancellation', 'account', 'technical', 'general', 'other'];
const RANGES = ['today', 'yesterday', '7d', '30d', 'month', 'year', 'custom', 'all'];
const RESPONSE_TIME_BUCKETS = {
  lt5: [0, 5],
  '5to15': [5, 15],
  '15to30': [15, 30],
  '30to60': [30, 60],
  gt60: [60, Infinity],
};

module.exports.SUPPORT_ENUMS = { STATUSES, PRIORITIES, CATEGORIES };

const toMs = (value) => (value ? new Date(value).getTime() : null);
const stripHtml = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const avg = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// --- Calendar helpers -------------------------------------------------------
// The browser sends its getTimezoneOffset() (minutes, e.g. -240 for Oman), so
// "today"/"this week" mean the admin's own calendar, not the server's.
function makeClock(tzOffset, now) {
  const tz = Number.isFinite(tzOffset) ? tzOffset : 0;
  const toLocal = (ms) => new Date(ms - tz * MIN);
  const fromLocal = (y, m, d = 1, h = 0) => Date.UTC(y, m, d, h) + tz * MIN;

  function startOfDay(ms, addDays = 0) {
    const d = toLocal(ms);
    return fromLocal(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDays);
  }
  function startOfWeek(ms, addWeeks = 0) {
    const d = toLocal(ms);
    const mondayOffset = (d.getUTCDay() + 6) % 7;
    return fromLocal(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset + addWeeks * 7);
  }
  function startOfMonth(ms, addMonths = 0) {
    const d = toLocal(ms);
    return fromLocal(d.getUTCFullYear(), d.getUTCMonth() + addMonths);
  }
  function startOfYear(ms, addYears = 0) {
    return fromLocal(toLocal(ms).getUTCFullYear() + addYears, 0);
  }
  function startOfHour(ms) {
    const d = toLocal(ms);
    return fromLocal(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  }
  function parseDate(ymd) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return match ? fromLocal(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }

  return { now, startOfDay, startOfWeek, startOfMonth, startOfYear, startOfHour, parseDate };
}

// [from, to) for the selected range, plus the equal-length window before it
// for "vs previous period" comparisons. `null` bounds = all time.
function resolveRange(clock, { range, from, to }) {
  const { now } = clock;
  const today = clock.startOfDay(now);
  const tomorrow = clock.startOfDay(now, 1);
  switch (range) {
    case 'today': return { from: today, to: tomorrow };
    case 'yesterday': return { from: clock.startOfDay(now, -1), to: today };
    case '7d': return { from: clock.startOfDay(now, -6), to: tomorrow };
    case 'month': return { from: clock.startOfMonth(now), to: clock.startOfMonth(now, 1) };
    case 'year': return { from: clock.startOfYear(now), to: clock.startOfYear(now, 1) };
    case 'custom': {
      const start = clock.parseDate(from);
      const end = clock.parseDate(to);
      if (start == null && end == null) return { from: null, to: null };
      return { from: start, to: end == null ? null : end + DAY };
    }
    case 'all': return { from: null, to: null };
    case '30d':
    default: return { from: clock.startOfDay(now, -29), to: tomorrow };
  }
}

const inWindow = (ms, from, to) => ms != null && (from == null || ms >= from) && (to == null || ms < to);

// --- Per-conversation derivation -------------------------------------------

// The agent's opening message lives on the ticket (description), not in
// ticket_messages — it's counted as message #1 here, the same way the agent
// chat (agent/pages/Support.jsx#buildTimeline) shows it.
function enrichConversation(ticket, messages, now) {
  const createdAt = toMs(ticket.created_at);
  let messageCount = 1;
  let unanswered = 1;
  let waitingSince = createdAt;
  let firstStaffAt = null;
  let lastActivityAt = createdAt;
  let lastMessage = stripHtml(ticket.description);
  let lastMessageFromStaff = false;

  for (const m of messages) {
    const at = toMs(m.created_at);
    const fromStaff = Boolean(Number(m.from_staff));
    messageCount += 1;
    if (fromStaff) {
      if (firstStaffAt == null) firstStaffAt = at;
      unanswered = 0;
      waitingSince = null;
    } else {
      unanswered += 1;
      if (waitingSince == null) waitingSince = at;
    }
    lastActivityAt = at;
    lastMessageFromStaff = fromStaff;
    lastMessage = m.preview || (m.attachment_type === 'audio' ? 'Voice message' : m.attachment_type ? 'Photo' : '');
  }

  const status = ticket.status || 'new';
  const closed = CLOSED_STATUSES.includes(status);
  const firstResponseAt = toMs(ticket.first_response_at) ?? firstStaffAt;
  const resolvedAt = closed ? toMs(ticket.resolved_at) : null;
  const awaitingAdmin = !closed && unanswered > 0;

  return {
    id: ticket.id,
    ref: `#${String(ticket.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`,
    userId: ticket.created_by_user_id,
    userName: ticket.created_by_name,
    userEmail: ticket.created_by_email,
    agencyId: ticket.agency_id,
    agencyName: ticket.agency_name,
    subject: ticket.subject,
    lastMessage,
    lastMessageFromStaff,
    status,
    priority: ticket.priority || 'medium',
    category: ticket.category || 'general',
    assignedToUserId: ticket.assigned_to_user_id || null,
    assignedToName: ticket.assigned_to_name || null,
    messageCount,
    unansweredCount: closed ? 0 : unanswered,
    reopenedCount: Number(ticket.reopened_count) || 0,
    firstResponseMinutes: firstResponseAt != null ? round1(Math.max(0, firstResponseAt - createdAt) / MIN) : null,
    resolutionMinutes: resolvedAt != null ? round1(Math.max(0, resolvedAt - createdAt) / MIN) : null,
    waitingMinutes: awaitingAdmin && waitingSince != null ? round1(Math.max(0, now - waitingSince) / MIN) : 0,
    awaitingAdmin,
    closed,
    createdAt,
    firstResponseAt,
    resolvedAt,
    lastActivityAt: Math.max(lastActivityAt, toMs(ticket.last_message_at) || 0),
  };
}

// --- Filters ---------------------------------------------------------------

function normalizeFilters(query = {}) {
  const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
  return {
    range: pick(query.range, RANGES) || '30d',
    from: query.from,
    to: query.to,
    tz: Number(query.tz),
    status: pick(query.status, STATUSES),
    priority: pick(query.priority, PRIORITIES),
    category: pick(query.category, CATEGORIES),
    agent: query.agent ? String(query.agent) : undefined,
    userId: query.userId ? String(query.userId) : undefined,
    search: query.search ? String(query.search).trim().toLowerCase() : undefined,
    responseStatus: pick(query.responseStatus, ['replied', 'unreplied']),
    repeat: query.repeat === 'repeat' ? 'repeat' : undefined,
    responseTime: RESPONSE_TIME_BUCKETS[query.responseTime] ? query.responseTime : undefined,
  };
}

module.exports.normalizeFilters = normalizeFilters;

function matchesFilters(c, f, repeatUserIds) {
  if (f.status && c.status !== f.status) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.category && c.category !== f.category) return false;
  if (f.agent === 'unassigned' ? c.assignedToUserId : f.agent && c.assignedToUserId !== f.agent) return false;
  if (f.userId && c.userId !== f.userId) return false;
  if (f.repeat && !repeatUserIds.has(c.userId)) return false;
  if (f.responseStatus === 'replied' && c.firstResponseMinutes == null) return false;
  if (f.responseStatus === 'unreplied' && c.firstResponseMinutes != null) return false;
  if (f.responseTime) {
    const [lo, hi] = RESPONSE_TIME_BUCKETS[f.responseTime];
    if (c.firstResponseMinutes == null || c.firstResponseMinutes < lo || c.firstResponseMinutes >= hi) return false;
  }
  if (f.search) {
    const haystack = [c.userName, c.userEmail, c.agencyName, c.subject, c.ref, c.id].join(' ').toLowerCase();
    if (!haystack.includes(f.search)) return false;
  }
  return true;
}

async function loadFilteredConversations({ agencyIds, query, now = Date.now() }) {
  const filters = normalizeFilters(query);
  const clock = makeClock(filters.tz, now);
  const window = resolveRange(clock, filters);

  const { tickets, messages } = await listTicketsForAnalytics({ agencyIds });
  const byTicket = new Map();
  for (const m of messages) {
    if (!byTicket.has(m.ticket_id)) byTicket.set(m.ticket_id, []);
    byTicket.get(m.ticket_id).push(m);
  }
  const all = tickets.map((t) => enrichConversation(t, byTicket.get(t.id) || [], now));

  // Repeat user = more than one conversation, counted across everything the
  // viewer can see (not just the current filter), so the filter is stable.
  const perUser = new Map();
  for (const c of all) perUser.set(c.userId, (perUser.get(c.userId) || 0) + 1);
  const repeatUserIds = new Set([...perUser].filter(([, n]) => n > 1).map(([id]) => id));

  const base = all.filter((c) => matchesFilters(c, filters, repeatUserIds));
  const scoped = base.filter((c) => inWindow(c.createdAt, window.from, window.to));

  return { filters, clock, window, base, scoped };
}

module.exports.loadFilteredConversations = loadFilteredConversations;

// --- Aggregations ----------------------------------------------------------

function pctChange(current, previous) {
  if (previous == null || current == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

function calendarPeriods(clock) {
  const { now } = clock;
  return [
    { key: 'today', label: 'Today', from: clock.startOfDay(now), to: clock.startOfDay(now, 1), prevFrom: clock.startOfDay(now, -1), prevLabel: 'yesterday' },
    { key: 'week', label: 'This Week', from: clock.startOfWeek(now), to: clock.startOfWeek(now, 1), prevFrom: clock.startOfWeek(now, -1), prevLabel: 'last week' },
    { key: 'month', label: 'This Month', from: clock.startOfMonth(now), to: clock.startOfMonth(now, 1), prevFrom: clock.startOfMonth(now, -1), prevLabel: 'last month' },
    { key: 'year', label: 'This Year', from: clock.startOfYear(now), to: clock.startOfYear(now, 1), prevFrom: clock.startOfYear(now, -1), prevLabel: 'last year' },
  ];
}

function buildSummary({ base, scoped, window, clock }) {
  const resolved = calendarPeriods(clock).map((p) => {
    const current = base.filter((c) => inWindow(c.resolvedAt, p.from, p.to)).length;
    const previous = base.filter((c) => inWindow(c.resolvedAt, p.prevFrom, p.from)).length;
    return { key: p.key, value: current, previous, changePct: pctChange(current, previous), comparisonLabel: `vs ${p.prevLabel}` };
  });

  // Equal-length window right before the selected range.
  let previousScoped = null;
  if (window.from != null) {
    const length = (window.to ?? clock.now) - window.from;
    previousScoped = base.filter((c) => inWindow(c.createdAt, window.from - length, window.from));
  }
  const avgResponse = (list) => avg(list.filter((c) => c.firstResponseMinutes != null).map((c) => c.firstResponseMinutes));
  const currentAvg = avgResponse(scoped);
  const previousAvg = previousScoped ? avgResponse(previousScoped) : null;

  return {
    resolved,
    awaitingAdmin: scoped.filter((c) => c.awaitingAdmin).length,
    newConversations: {
      value: scoped.length,
      previous: previousScoped ? previousScoped.length : null,
      changePct: previousScoped ? pctChange(scoped.length, previousScoped.length) : null,
    },
    newStatusCount: scoped.filter((c) => c.status === 'new').length,
    openConversations: scoped.filter((c) => !c.closed).length,
    avgResponseMinutes: {
      value: round1(currentAvg),
      previous: round1(previousAvg),
      changePct: currentAvg != null && previousAvg != null ? pctChange(currentAvg, previousAvg) : null,
    },
  };
}

// Bucket size follows the span: hours for a day, days up to a quarter,
// months beyond that.
function buildBuckets({ window, clock, scoped }) {
  const from = window.from ?? (scoped.length ? clock.startOfDay(Math.min(...scoped.map((c) => c.createdAt))) : clock.startOfDay(clock.now, -29));
  const to = Math.min(window.to ?? clock.startOfDay(clock.now, 1), clock.startOfDay(clock.now, 1));
  const span = to - from;
  const unit = span <= 2 * DAY ? 'hour' : span <= 92 * DAY ? 'day' : 'month';
  const buckets = [];
  let cursor = unit === 'hour' ? clock.startOfHour(from) : unit === 'day' ? clock.startOfDay(from) : clock.startOfMonth(from);
  while (cursor < to && buckets.length < 400) {
    const next = unit === 'hour' ? cursor + HOUR : unit === 'day' ? clock.startOfDay(cursor, 1) : clock.startOfMonth(cursor, 1);
    buckets.push({ start: cursor, end: next });
    cursor = next;
  }
  return { unit, buckets };
}

function buildTrends({ base, scoped, window, clock }) {
  const { unit, buckets } = buildBuckets({ window, clock, scoped });
  const volume = buckets.map((b) => ({
    at: new Date(b.start).toISOString(),
    created: scoped.filter((c) => inWindow(c.createdAt, b.start, b.end)).length,
    resolved: base.filter((c) => inWindow(c.resolvedAt, b.start, b.end)).length,
  }));
  const responseTime = buckets.map((b) => {
    const values = scoped
      .filter((c) => c.firstResponseMinutes != null && inWindow(c.createdAt, b.start, b.end))
      .map((c) => c.firstResponseMinutes);
    return { at: new Date(b.start).toISOString(), avgMinutes: round1(avg(values)), count: values.length };
  });
  return { unit, volume, responseTime };
}

function buildStatusBreakdown(scoped) {
  return STATUSES.map((status) => ({ status, count: scoped.filter((c) => c.status === status).length })).filter((s) => s.count > 0);
}

function buildResolutionOverview({ base, clock }) {
  return calendarPeriods(clock).map((p) => {
    const received = base.filter((c) => inWindow(c.createdAt, p.from, p.to));
    return {
      period: p.label,
      received: received.length,
      resolved: base.filter((c) => inWindow(c.resolvedAt, p.from, p.to)).length,
      pending: received.filter((c) => !c.closed).length,
    };
  });
}

function buildPerformance(scoped) {
  const resolvedCount = scoped.filter((c) => c.closed).length;
  const waiting = scoped.filter((c) => c.awaitingAdmin);
  const oldest = waiting.reduce((max, c) => (c.waitingMinutes > (max?.waitingMinutes ?? -1) ? c : max), null);
  return {
    total: scoped.length,
    resolved: resolvedCount,
    resolutionRate: scoped.length ? round1((resolvedCount / scoped.length) * 100) : null,
    avgFirstResponseMinutes: round1(avg(scoped.filter((c) => c.firstResponseMinutes != null).map((c) => c.firstResponseMinutes))),
    avgResolutionMinutes: round1(avg(scoped.filter((c) => c.resolutionMinutes != null).map((c) => c.resolutionMinutes))),
    oldestPending: oldest ? { id: oldest.id, ref: oldest.ref, userName: oldest.userName, waitingMinutes: oldest.waitingMinutes } : null,
    unansweredOver30: waiting.filter((c) => c.waitingMinutes > 30).length,
    reopened: scoped.filter((c) => c.reopenedCount > 0).length,
  };
}

const ATTENTION_RULES = [
  { key: 'urgent', label: 'Urgent priority', weight: 50, test: (c) => c.priority === 'urgent' },
  { key: 'pending_1h', label: 'Waiting > 1 hour', weight: 40, test: (c) => c.awaitingAdmin && c.waitingMinutes > 60 },
  { key: 'no_reply_15m', label: 'No reply > 15 min', weight: 30, test: (c) => c.awaitingAdmin && c.waitingMinutes > 15 && c.waitingMinutes <= 60 },
  { key: 'repeated', label: 'Repeated messages', weight: 20, test: (c) => c.awaitingAdmin && c.unansweredCount >= 2 },
  { key: 'high', label: 'High priority', weight: 15, test: (c) => c.priority === 'high' },
  { key: 'reopened', label: 'Reopened', weight: 10, test: (c) => c.reopenedCount > 0 },
];

function buildNeedsAttention(base) {
  const counts = Object.fromEntries(ATTENTION_RULES.map((r) => [r.key, 0]));
  const items = [];
  for (const c of base) {
    if (c.closed) continue;
    const reasons = ATTENTION_RULES.filter((r) => r.test(c));
    if (reasons.length === 0) continue;
    reasons.forEach((r) => { counts[r.key] += 1; });
    items.push({
      ...toPublicLog(c),
      reasons: reasons.map((r) => ({ key: r.key, label: r.label })),
      score: reasons.reduce((sum, r) => sum + r.weight, 0) + Math.min(c.waitingMinutes, 600) / 60,
    });
  }
  items.sort((a, b) => b.score - a.score);
  return {
    total: items.length,
    counts,
    rules: ATTENTION_RULES.map(({ key, label }) => ({ key, label })),
    items: items.slice(0, 25),
  };
}

function buildTopUsers(scoped) {
  const users = new Map();
  for (const c of scoped) {
    const u = users.get(c.userId) || { userId: c.userId, name: c.userName, email: c.userEmail, agencyName: c.agencyName, conversations: 0, messages: 0, resolved: 0, pending: 0, lastContactAt: 0 };
    u.conversations += 1;
    u.messages += c.messageCount;
    if (c.closed) u.resolved += 1;
    else u.pending += 1;
    u.lastContactAt = Math.max(u.lastContactAt, c.lastActivityAt);
    users.set(c.userId, u);
  }
  return [...users.values()]
    .sort((a, b) => b.conversations - a.conversations || b.messages - a.messages || b.lastContactAt - a.lastContactAt)
    .slice(0, 10)
    .map((u) => ({ ...u, lastContactAt: new Date(u.lastContactAt).toISOString() }));
}

function buildAgentPerformance(scoped) {
  const agents = new Map();
  for (const c of scoped) {
    const key = c.assignedToUserId || 'unassigned';
    const a = agents.get(key) || { agentId: c.assignedToUserId, name: c.assignedToName || 'Unassigned', assigned: 0, resolved: 0, pending: 0, responses: [], resolutions: [] };
    a.assigned += 1;
    if (c.closed) a.resolved += 1;
    else a.pending += 1;
    if (c.firstResponseMinutes != null) a.responses.push(c.firstResponseMinutes);
    if (c.resolutionMinutes != null) a.resolutions.push(c.resolutionMinutes);
    agents.set(key, a);
  }
  return [...agents.values()]
    .map(({ responses, resolutions, ...a }) => ({ ...a, avgResponseMinutes: round1(avg(responses)), avgResolutionMinutes: round1(avg(resolutions)) }))
    .sort((a, b) => (a.agentId ? 0 : 1) - (b.agentId ? 0 : 1) || b.resolved - a.resolved || b.assigned - a.assigned);
}

function buildCategories(scoped) {
  return CATEGORIES.map((category) => ({ category, count: scoped.filter((c) => c.category === category).length }));
}

function toPublicLog(c) {
  const iso = (ms) => (ms != null ? new Date(ms).toISOString() : null);
  return {
    id: c.id,
    ref: c.ref,
    userId: c.userId,
    userName: c.userName,
    userEmail: c.userEmail,
    agencyName: c.agencyName,
    subject: c.subject,
    lastMessage: c.lastMessage,
    lastMessageFromStaff: c.lastMessageFromStaff,
    status: c.status,
    priority: c.priority,
    category: c.category,
    assignedToUserId: c.assignedToUserId,
    assignedToName: c.assignedToName,
    messageCount: c.messageCount,
    unansweredCount: c.unansweredCount,
    reopenedCount: c.reopenedCount,
    firstResponseMinutes: c.firstResponseMinutes,
    resolutionMinutes: c.resolutionMinutes,
    waitingMinutes: c.waitingMinutes,
    createdAt: iso(c.createdAt),
    firstResponseAt: iso(c.firstResponseAt),
    resolvedAt: iso(c.resolvedAt),
    lastActivityAt: iso(c.lastActivityAt),
  };
}

module.exports.toPublicLog = toPublicLog;

async function getDashboard({ agencyIds, query }) {
  const ctx = await loadFilteredConversations({ agencyIds, query });
  const { base, scoped, window, filters } = ctx;
  return {
    filters,
    range: { from: window.from != null ? new Date(window.from).toISOString() : null, to: window.to != null ? new Date(window.to).toISOString() : null },
    summary: buildSummary(ctx),
    trends: buildTrends(ctx),
    statusBreakdown: buildStatusBreakdown(scoped),
    resolutionOverview: buildResolutionOverview(ctx),
    performance: buildPerformance(scoped),
    needsAttention: buildNeedsAttention(base),
    topUsers: buildTopUsers(scoped),
    agents: buildAgentPerformance(scoped),
    categories: buildCategories(scoped),
  };
}

module.exports.getDashboard = getDashboard;

const LOG_SORTS = {
  lastActivity: (a, b) => b.lastActivityAt - a.lastActivityAt,
  created: (a, b) => b.createdAt - a.createdAt,
  waiting: (a, b) => b.waitingMinutes - a.waitingMinutes,
  messages: (a, b) => b.messageCount - a.messageCount,
};

async function getLogs({ agencyIds, query }) {
  const { scoped } = await loadFilteredConversations({ agencyIds, query });
  const sorted = [...scoped].sort(LOG_SORTS[query.sort] || LOG_SORTS.lastActivity);
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 10));
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Number(query.page) || 1));
  return {
    logs: sorted.slice((page - 1) * pageSize, page * pageSize).map(toPublicLog),
    pagination: { total: sorted.length, page, pageSize, totalPages },
  };
}

module.exports.getLogs = getLogs;

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  // Leading =,+,-,@ would be evaluated as a formula by Excel/Sheets.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportLogsCsv({ agencyIds, query }) {
  const { scoped } = await loadFilteredConversations({ agencyIds, query });
  const header = ['ID', 'Conversation ID', 'User', 'Email', 'Agency', 'Status', 'Priority', 'Category', 'Agent', 'Messages', 'First Response (min)', 'Resolution Time (min)', 'Waiting (min)', 'Reopened', 'Created', 'Last Activity', 'Resolved', 'Last Message'];
  const rows = [...scoped].sort(LOG_SORTS.lastActivity).map((c) => {
    const l = toPublicLog(c);
    return [l.ref, l.id, l.userName, l.userEmail, l.agencyName, l.status, l.priority, l.category, l.assignedToName || 'Unassigned', l.messageCount, l.firstResponseMinutes, l.resolutionMinutes, l.waitingMinutes || '', l.reopenedCount, l.createdAt, l.lastActivityAt, l.resolvedAt, l.lastMessage];
  });
  // BOM so Excel opens UTF-8 names correctly.
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports.exportLogsCsv = exportLogsCsv;
