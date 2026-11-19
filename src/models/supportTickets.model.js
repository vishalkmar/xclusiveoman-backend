const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

// Admin Support & Helpdesk (Task 18 — Screen 27/28, SUP-1..3). Agent-side
// (own-agency) and admin-side (all agencies, joined) queries live together
// here, same file-organization choice as bookings.model.js/bookingsAdmin.model.js
// before it — one schema, two access patterns.

const ADMIN_JOINS = `
  FROM support_tickets t
  JOIN agencies a ON a.id = t.agency_id
  JOIN users creator ON creator.id = t.created_by_user_id
  LEFT JOIN users assignee ON assignee.id = t.assigned_to_user_id
`;

const ADMIN_SELECT_COLUMNS = `
  t.*,
  a.name AS agency_name,
  creator.full_name AS created_by_name,
  creator.email AS created_by_email,
  assignee.full_name AS assigned_to_name
`;

const CLOSED_STATUSES = ['resolved', 'closed'];
module.exports.CLOSED_STATUSES = CLOSED_STATUSES;

// Best-effort first guess at a chat's category from the agent's opening
// message — staff can always correct it from Chat Logs. Order matters: the
// more specific intents are checked before the generic "booking".
const CATEGORY_KEYWORDS = [
  ['cancellation', /\b(cancel|cancell?ation|refund)\w*/i],
  ['payment', /\b(pay|payment|invoice|neft|deposit|balance|charge|card|transaction)\w*/i],
  ['account', /\b(account|login|log in|password|otp|profile|register|sign ?in)\w*/i],
  ['technical', /\b(error|bug|crash|not working|broken|website|app)\b/i],
  ['booking', /\b(book|booking|reservation|itinerary|tour|package|hotel|transfer|voucher)\w*/i],
];

function guessCategory(text) {
  const plain = String(text || '').replace(/<[^>]*>/g, ' ');
  const match = CATEGORY_KEYWORDS.find(([, re]) => re.test(plain));
  return match ? match[0] : 'general';
}

async function createTicket({ agencyId, createdByUserId, subject, description }) {
  const id = newId();
  await pool.query(
    `INSERT INTO support_tickets (id, agency_id, created_by_user_id, subject, description, category, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, now())`,
    [id, agencyId, createdByUserId, subject, description, guessCategory(`${subject} ${description}`)]
  );
  const { rows } = await pool.query('SELECT * FROM support_tickets WHERE id = ?', [id]);
  return rows[0];
}

module.exports.createTicket = createTicket;

async function listTicketsForAgency(agencyId) {
  const { rows } = await pool.query(
    'SELECT * FROM support_tickets WHERE agency_id = ? ORDER BY created_at DESC',
    [agencyId]
  );
  return rows;
}

module.exports.listTicketsForAgency = listTicketsForAgency;

async function findTicketForAgency(ticketId, agencyId) {
  const { rows } = await pool.query('SELECT * FROM support_tickets WHERE id = ? AND agency_id = ?', [ticketId, agencyId]);
  return rows[0] || null;
}

module.exports.findTicketForAgency = findTicketForAgency;

// --- Admin-side (all agencies) ---

// `agencyIds` — Team Portal Support Tickets scoping (a Relationship
// Manager only ever sees tickets raised by their own assigned agencies),
// mirrors every other admin list's identical param (bookingsAdmin.model.js,
// packageRequestsAdmin.model.js, …) — server-set, never client-suppliable.
function buildAdminFilters({ agencyIds, search }) {
  const clauses = [];
  const values = [];

  if (agencyIds) {
    clauses.push(`t.agency_id IN (?)`);
    values.push(agencyIds);
  }
  if (search) {
    clauses.push(`(LOWER(t.subject) LIKE LOWER(?) OR LOWER(a.name) LIKE LOWER(?) OR LOWER(creator.full_name) LIKE LOWER(?))`);
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, values };
}

async function listTicketsForAdmin(
  { agencyIds, search, page, pageSize } = {}
) {
  const { where, values } = buildAdminFilters({ agencyIds, search });

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS count ${ADMIN_JOINS} ${where}`, values);
  const total = Number(countRows[0].count);

  const limit = Math.max(1, Math.min(100, Number(pageSize) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;

  // Newest activity first (like any inbox), with the last message and the
  // number of agent messages staff haven't opened yet for the list row.
  const { rows } = await pool.query(
    `SELECT ${ADMIN_SELECT_COLUMNS},
       (SELECT COUNT(*) FROM ticket_messages tm JOIN users u ON u.id = tm.sender_user_id
        WHERE tm.ticket_id = t.id AND u.agency_id IS NOT NULL AND tm.seen = FALSE) AS unread_count,
       (SELECT tm.message FROM ticket_messages tm WHERE tm.ticket_id = t.id ORDER BY tm.created_at DESC LIMIT 1) AS last_message,
       (SELECT tm.attachment_type FROM ticket_messages tm WHERE tm.ticket_id = t.id ORDER BY tm.created_at DESC LIMIT 1) AS last_attachment_type
     ${ADMIN_JOINS} ${where}
     ORDER BY COALESCE(t.last_message_at, t.updated_at, t.created_at) DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );

  return { rows, total, page: currentPage, pageSize: limit };
}

module.exports.listTicketsForAdmin = listTicketsForAdmin;

async function findTicketForAdmin(ticketId) {
  const { rows } = await pool.query(`SELECT ${ADMIN_SELECT_COLUMNS} ${ADMIN_JOINS} WHERE t.id = ?`, [ticketId]);
  return rows[0] || null;
}

module.exports.findTicketForAdmin = findTicketForAdmin;

// `fromStaff` drives the chat's automatic workflow: a staff reply stamps the
// first response and hands the turn to the agent; an agent message hands it
// back to staff — and reopens the chat if it had been resolved/closed.
// NOTE: MySQL evaluates single-table UPDATE assignments left to right with
// already-updated values, so everything reading the *old* status is set
// before `status` itself.
async function insertTicketMessage({ ticketId, senderUserId, message, attachmentUrl = null, attachmentType = null, fromStaff = false }) {
  const id = newId();
  await pool.query(
    `INSERT INTO ticket_messages (id, ticket_id, sender_user_id, message, attachment_url, attachment_type) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, ticketId, senderUserId, message || '', attachmentUrl, attachmentUrl ? attachmentType || 'image' : null]
  );
  if (fromStaff) {
    await pool.query(
      `UPDATE support_tickets SET
         updated_at = now(),
         last_message_at = now(),
         first_response_at = COALESCE(first_response_at, now()),
         status = CASE WHEN status IN ('resolved', 'closed') THEN status ELSE 'waiting_user' END
       WHERE id = ?`,
      [ticketId]
    );
  } else {
    await pool.query(
      `UPDATE support_tickets SET
         updated_at = now(),
         last_message_at = now(),
         reopened_count = reopened_count + IF(status IN ('resolved', 'closed'), 1, 0),
         resolved_at = IF(status IN ('resolved', 'closed'), NULL, resolved_at),
         status = CASE
           WHEN status IN ('resolved', 'closed') THEN 'waiting_admin'
           WHEN first_response_at IS NULL THEN 'new'
           ELSE 'waiting_admin'
         END
       WHERE id = ?`,
      [ticketId]
    );
  }
  const { rows } = await pool.query('SELECT * FROM ticket_messages WHERE id = ?', [id]);
  return rows[0];
}

module.exports.insertTicketMessage = insertTicketMessage;

async function listMessagesForTicket(ticketId) {
  const { rows } = await pool.query(
    `SELECT tm.*, tm.seen, u.full_name AS sender_name, u.role AS sender_role
     FROM ticket_messages tm
     JOIN users u ON u.id = tm.sender_user_id
     WHERE tm.ticket_id = ?
     ORDER BY tm.created_at ASC`,
    [ticketId]
  );
  return rows;
}

module.exports.listMessagesForTicket = listMessagesForTicket;

async function markMessagesSeen(ticketId, viewerUserId) {
  await pool.query(
    `UPDATE ticket_messages SET seen = TRUE WHERE ticket_id = ? AND sender_user_id <> ?`,
    [ticketId, viewerUserId]
  );
}

module.exports.markMessagesSeen = markMessagesSeen;

// Staff-side workflow edits from Chat Logs (status / priority / category /
// assignee). Resolving stamps resolved_at; moving a resolved chat back to an
// active status counts as a reopen. Same left-to-right caveat as above.
async function updateTicketWorkflow(ticketId, { status, priority, category, assignedToUserId }) {
  const sets = [];
  const values = [];
  if (status !== undefined) {
    if (CLOSED_STATUSES.includes(status)) {
      sets.push('resolved_at = COALESCE(resolved_at, now())');
    } else {
      sets.push(`reopened_count = reopened_count + IF(status IN ('resolved', 'closed'), 1, 0)`, 'resolved_at = NULL');
    }
    sets.push('status = ?');
    values.push(status);
  }
  if (priority !== undefined) {
    sets.push('priority = ?');
    values.push(priority);
  }
  if (category !== undefined) {
    sets.push('category = ?');
    values.push(category);
  }
  if (assignedToUserId !== undefined) {
    sets.push('assigned_to_user_id = ?');
    values.push(assignedToUserId || null);
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE support_tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = ?`, [...values, ticketId]);
}

module.exports.updateTicketWorkflow = updateTicketWorkflow;

// Staff who can own a support chat.
async function listSupportAssignees() {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, role FROM users
     WHERE agency_id IS NULL AND role IN ('support', 'super_admin', 'relationship_manager') AND status = 'active'
     ORDER BY full_name ASC`
  );
  return rows;
}

module.exports.listSupportAssignees = listSupportAssignees;

// --- Chat Logs & Analytics (services/supportAnalytics.service.js) ---

// Every chat in scope plus one lightweight row per message (a preview, not
// the full body), so the analytics service can derive response times,
// waiting time and unanswered streaks in a single pass.
async function listTicketsForAnalytics({ agencyIds } = {}) {
  // An RM with no assigned agencies sees nothing (and `IN ()` isn't valid SQL).
  if (agencyIds && agencyIds.length === 0) return { tickets: [], messages: [] };
  const where = agencyIds ? 'WHERE t.agency_id IN (?)' : '';
  const { rows: tickets } = await pool.query(
    `SELECT ${ADMIN_SELECT_COLUMNS} ${ADMIN_JOINS} ${where} ORDER BY t.created_at DESC`,
    agencyIds ? [agencyIds] : []
  );
  if (tickets.length === 0) return { tickets, messages: [] };
  const { rows: messages } = await pool.query(
    `SELECT tm.ticket_id, tm.created_at, tm.attachment_type, LEFT(tm.message, 160) AS preview,
            (u.agency_id IS NULL) AS from_staff
     FROM ticket_messages tm
     JOIN users u ON u.id = tm.sender_user_id
     WHERE tm.ticket_id IN (?)
     ORDER BY tm.created_at ASC`,
    [tickets.map((t) => t.id)]
  );
  return { tickets, messages };
}

module.exports.listTicketsForAnalytics = listTicketsForAnalytics;
