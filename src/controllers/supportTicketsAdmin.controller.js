const {
  listTicketsForAdmin,
  findTicketForAdmin,
  insertTicketMessage,
  listMessagesForTicket,
  markMessagesSeen,
  updateTicketWorkflow,
  listSupportAssignees
} = require('../models/supportTickets.model.js');

const {
  listAgenciesByRmIds
} = require('../models/agencies.model.js');

const {
  insertAuditLog,
  listAuditLogsForEntity
} = require('../models/auditLogs.model.js');

const {
  notifyAgencyOfReply,
  notifyStaffOfUpdate
} = require('../services/supportTicketNotify.service.js');
const { uploadBuffer } = require('../services/cloudinary.service.js');
const supportAnalytics = require('../services/supportAnalytics.service.js');

// Admin Support & Helpdesk (Task 18 — SUP-2/SUP-3). Mounted at
// /api/admin/support/tickets, gated requireRole('support','super_admin') —
// its own RBAC boundary, independent of Marketing/Operations/Manual
// Booking/Documents/Payments, same convention every prior admin feature in
// this codebase established.
//
// Two endpoints here (GET .../:id detail, POST .../:id/messages) go beyond
// the doc's own bare 2-route bullet list for this section — both are
// necessary for the explicitly-required "threaded replies" and "activity
// history" admin UI to function at all, and mirror this codebase's own
// established pattern of a mirrored admin reply/detail endpoint alongside
// the agent one (e.g. booking creation: self-service vs
// /admin/bookings/manual, both funneling into one shared model layer).

function toPublicMessage(m) {
  return {
    id: m.id,
    senderUserId: m.sender_user_id,
    senderName: m.sender_name,
    senderRole: m.sender_role,
    message: m.message,
    attachmentUrl: m.attachment_url,
    attachmentType: m.attachment_url ? m.attachment_type || 'image' : null,
    seen: Boolean(m.seen),
    createdAt: m.created_at,
  };
}

// The agent's opening message is stored as the ticket's description, not as
// a ticket_messages row — without this, staff never saw the first thing the
// agent wrote (only the agent's own timeline included it).
function toOpeningMessage(t, messages) {
  const text = String(t.description || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id: `opening-${t.id}`,
    senderUserId: t.created_by_user_id,
    senderName: t.created_by_name,
    senderRole: 'agency_owner',
    message: text,
    attachmentUrl: null,
    attachmentType: null,
    seen: messages.some((m) => m.sender_user_id !== t.created_by_user_id),
    createdAt: t.created_at,
    opening: true,
  };
}

async function markTicketSeen(req, res, next) {
  try {
    const ticket = await findTicketForAdmin(req.params.id);
    if (!ticket || !(await assertOwnAgencyTicket(req, ticket))) return res.status(404).json({ error: 'not_found' });
    await markMessagesSeen(ticket.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

module.exports.markTicketSeen = markTicketSeen;

function toPublicTicket(t) {
  return {
    id: t.id,
    agencyId: t.agency_id,
    agencyName: t.agency_name,
    createdByUserId: t.created_by_user_id,
    createdByName: t.created_by_name,
    createdByEmail: t.created_by_email,
    subject: t.subject,
    description: t.description,
    status: t.status || 'new',
    priority: t.priority || 'medium',
    category: t.category || 'general',
    assignedToUserId: t.assigned_to_user_id || null,
    assignedToName: t.assigned_to_name || null,
    firstResponseAt: t.first_response_at || null,
    resolvedAt: t.resolved_at || null,
    reopenedCount: Number(t.reopened_count) || 0,
    lastMessageAt: t.last_message_at || t.updated_at,
    lastMessage: t.last_message ?? undefined,
    lastAttachmentType: t.last_attachment_type ?? undefined,
    unreadCount: t.unread_count != null ? Number(t.unread_count) : undefined,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

const ACTIVITY_LABELS = {
  status: 'Status changed',
  priority: 'Priority changed',
  category: 'Category changed',
  assigned_to_user_id: 'Assignment changed',
};

// Merges audit_logs (assignment/status changes) with ticket_messages
// (replies) into one chronological feed — same pattern
// fdOperationsAdmin.controller.js#buildActivityHistory established (Task 12):
// each source already durably records itself, this just reads them back
// together.
function buildActivityHistory({ auditLogs, messages }) {
  const items = [];
  for (const log of auditLogs) {
    const parse = (v) => { try { return JSON.parse(v); } catch { return v; } };
    const label = ACTIVITY_LABELS[log.field] || 'Chat activity';
    const to = log.new_value != null ? parse(log.new_value) : null;
    items.push({ type: 'activity', description: to != null && log.field !== 'assigned_to_user_id' ? `${label} to ${String(to).replace(/_/g, ' ')}` : label, at: log.created_at, by: log.actor_full_name || null });
  }
  for (const m of messages) {
    const text = m.message || (m.attachment_type === 'audio' ? 'Voice message' : m.attachment_url ? 'Photo' : '');
    items.push({ type: 'message', description: `Reply — "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`, at: m.created_at, by: m.sender_name });
  }
  return items.sort((a, b) => new Date(a.at) - new Date(b.at));
}

// Team Portal Support Tickets scoping (Access Feature 'supportTickets',
// relationship_manager only — sales_manager has no such key in
// LM_FEATURE_KEYS). Applied to list below and to get/update/reply via
// assertOwnAgencyTicket. Never applies to support/super_admin, who keep
// seeing every ticket exactly as before.
async function ownAgencyIds(req) {
  const own = await listAgenciesByRmIds([req.user.id]);
  return own.map((a) => a.id);
}

async function assertOwnAgencyTicket(req, ticket) {
  if (req.user.role !== 'relationship_manager') return true;
  const ids = await ownAgencyIds(req);
  return ids.includes(ticket.agency_id);
}

// `undefined` = no scoping (support/super_admin); `[]` = an RM with no
// agencies, who therefore sees nothing.
async function scopedAgencyIds(req) {
  return req.user.role === 'relationship_manager' ? ownAgencyIds(req) : undefined;
}

async function listTickets(req, res, next) {
  try {
    const { search, page, pageSize } = req.query;

    const agencyIds = await scopedAgencyIds(req);
    if (agencyIds && agencyIds.length === 0) {
      return res.json({ tickets: [], pagination: { total: 0, page: 1, pageSize: Number(pageSize) || 20, totalPages: 1 } });
    }

    const { rows, total, page: currentPage, pageSize: limit } = await listTicketsForAdmin({
      agencyIds,
      search,
      page,
      pageSize,
    });

    res.json({
      tickets: rows.map(toPublicTicket),
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.listTickets = listTickets;

async function getTicket(req, res, next) {
  try {
    const ticket = await findTicketForAdmin(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'not_found' });
    if (!(await assertOwnAgencyTicket(req, ticket))) return res.status(404).json({ error: 'not_found' });

    await markMessagesSeen(ticket.id, req.user.id);

    const [messages, auditLogs] = await Promise.all([
      listMessagesForTicket(ticket.id),
      listAuditLogsForEntity('support_ticket', ticket.id),
    ]);

    res.json({
      ticket: toPublicTicket(ticket),
      messages: [toOpeningMessage(ticket, messages), ...messages.map(toPublicMessage)],
      activity: buildActivityHistory({ auditLogs, messages }),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getTicket = getTicket;

async function replyToTicket(req, res, next) {
  try {
    const ticket = await findTicketForAdmin(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'not_found' });
    if (!(await assertOwnAgencyTicket(req, ticket))) return res.status(404).json({ error: 'not_found' });

    const message = await insertTicketMessage({ ticketId: ticket.id, senderUserId: req.user.id, message: req.body.message, fromStaff: true });

    await notifyAgencyOfReply(ticket, { senderName: req.user.full_name, messagePreview: req.body.message.slice(0, 140) });

    res.status(201).json({ message: toPublicMessage({ ...message, sender_name: req.user.full_name, sender_role: req.user.role }) });
  } catch (err) {
    next(err);
  }
}

module.exports.replyToTicket = replyToTicket;

// Shared by the photo and voice-note endpoints — only the upload field and
// the stored attachment type differ.
function replyWithAttachment(attachmentType) {
  return async function replyWithAttachmentToTicket(req, res, next) {
    try {
      const ticket = await findTicketForAdmin(req.params.id);
      if (!ticket || !(await assertOwnAgencyTicket(req, ticket))) return res.status(404).json({ error: 'not_found' });
      if (!req.file) return res.status(400).json({ error: 'file_required', message: 'No file was uploaded' });
      const uploaded = await uploadBuffer(req.file.buffer, { folderParts: ['support-chat', ticket.id] });
      const message = await insertTicketMessage({ ticketId: ticket.id, senderUserId: req.user.id, message: req.body.message || '', attachmentUrl: uploaded.secure_url, attachmentType, fromStaff: true });
      await notifyAgencyOfReply(ticket, { senderName: req.user.full_name, messagePreview: req.body.message || (attachmentType === 'audio' ? 'Voice message' : 'Image attachment') });
      res.status(201).json({ message: toPublicMessage({ ...message, sender_name: req.user.full_name, sender_role: req.user.role }) });
    } catch (err) { next(err); }
  };
}

module.exports.replyWithImageToTicket = replyWithAttachment('image');
module.exports.replyWithVoiceToTicket = replyWithAttachment('audio');

const WORKFLOW_FIELDS = [
  ['status', 'status'],
  ['priority', 'priority'],
  ['category', 'category'],
  ['assignedToUserId', 'assigned_to_user_id'],
];

async function updateTicket(req, res, next) {
  try {
    const ticket = await findTicketForAdmin(req.params.id);
    if (!ticket || !(await assertOwnAgencyTicket(req, ticket))) return res.status(404).json({ error: 'not_found' });

    if (req.body.assignedToUserId) {
      const assignees = await listSupportAssignees();
      if (!assignees.some((a) => a.id === req.body.assignedToUserId)) {
        return res.status(400).json({ error: 'invalid_assignee', message: 'That staff member cannot be assigned support chats' });
      }
    }

    await updateTicketWorkflow(ticket.id, req.body);

    const changed = WORKFLOW_FIELDS.filter(([key, column]) => req.body[key] !== undefined && (req.body[key] || null) !== (ticket[column] || null));
    await Promise.all(
      changed.map(([key, column]) =>
        insertAuditLog({ actorUserId: req.user.id, entity: 'support_ticket', entityId: ticket.id, field: column, oldValue: ticket[column] ?? null, newValue: req.body[key] ?? null })
      )
    );

    const updated = await findTicketForAdmin(ticket.id);
    notifyStaffOfUpdate(updated);
    res.json({ ticket: toPublicTicket(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports.updateTicket = updateTicket;

async function listAssignees(req, res, next) {
  try {
    const rows = await listSupportAssignees();
    res.json({ agents: rows.map((u) => ({ id: u.id, fullName: u.full_name, email: u.email, role: u.role })) });
  } catch (err) {
    next(err);
  }
}

module.exports.listAssignees = listAssignees;

// --- Chat Logs & Analytics -------------------------------------------------

// An RM with no agencies still gets a fully-shaped (all-zero) dashboard —
// the model returns nothing for an empty agency scope.
async function getAnalytics(req, res, next) {
  try {
    res.json(await supportAnalytics.getDashboard({ agencyIds: await scopedAgencyIds(req), query: req.query }));
  } catch (err) {
    next(err);
  }
}

module.exports.getAnalytics = getAnalytics;

async function getAnalyticsLogs(req, res, next) {
  try {
    res.json(await supportAnalytics.getLogs({ agencyIds: await scopedAgencyIds(req), query: req.query }));
  } catch (err) {
    next(err);
  }
}

module.exports.getAnalyticsLogs = getAnalyticsLogs;

async function exportAnalyticsLogs(req, res, next) {
  try {
    const csv = await supportAnalytics.exportLogsCsv({ agencyIds: await scopedAgencyIds(req), query: req.query });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat-logs-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports.exportAnalyticsLogs = exportAnalyticsLogs;
