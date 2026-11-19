const {
  createTicket,
  listTicketsForAgency,
  findTicketForAgency,
  insertTicketMessage,
  listMessagesForTicket
  ,markMessagesSeen
} = require('../models/supportTickets.model.js');

const {
  notifyStaffOfReply
} = require('../services/supportTicketNotify.service.js');
const { uploadBuffer } = require('../services/cloudinary.service.js');

// Agent-side Support & Helpdesk (Task 18 — SUP-1/SUP-3). Mounted at
// /api/support/tickets with the existing agency_owner/agency_staff gate —
// every handler re-scopes to req.user.agency_id, same ownership posture as
// bookings.controller.js/payments.controller.js.

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

function toPublicTicket(t, messages) {
  return {
    id: t.id,
    subject: t.subject,
    description: t.description,
    status: t.status || 'new',
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    messages: (messages || []).map(toPublicMessage),
  };
}

async function listMyTickets(req, res, next) {
  try {
    const tickets = await listTicketsForAgency(req.user.agency_id);
    const withMessages = await Promise.all(
      tickets.map(async (t) => toPublicTicket(t, await listMessagesForTicket(t.id)))
    );
    res.json({ tickets: withMessages });
  } catch (err) {
    next(err);
  }
}

module.exports.listMyTickets = listMyTickets;

async function createMyTicket(req, res, next) {
  try {
    const { subject, description } = req.body;
    const ticket = await createTicket({
      agencyId: req.user.agency_id,
      createdByUserId: req.user.id,
      subject,
      description,
    });
    // A brand-new chat must reach staff live too, not only later replies.
    await notifyStaffOfReply(ticket, { senderName: req.user.full_name, messagePreview: String(description).replace(/<[^>]*>/g, ' ').slice(0, 140) });
    res.status(201).json({ ticket: toPublicTicket(ticket, []) });
  } catch (err) {
    next(err);
  }
}

module.exports.createMyTicket = createMyTicket;

async function replyToMyTicket(req, res, next) {
  try {
    const ticket = await findTicketForAgency(req.params.id, req.user.agency_id);
    if (!ticket) return res.status(404).json({ error: 'not_found' });

    const message = await insertTicketMessage({ ticketId: ticket.id, senderUserId: req.user.id, message: req.body.message });

    await notifyStaffOfReply(ticket, { senderName: req.user.full_name, messagePreview: req.body.message.slice(0, 140) });

    res.status(201).json({ message: toPublicMessage({ ...message, sender_name: req.user.full_name, sender_role: req.user.role }) });
  } catch (err) {
    next(err);
  }
}

async function markMyTicketSeen(req, res, next) {
  try {
    const ticket = await findTicketForAgency(req.params.id, req.user.agency_id);
    if (!ticket) return res.status(404).json({ error: 'not_found' });
    await markMessagesSeen(ticket.id, req.user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

module.exports.markMyTicketSeen = markMyTicketSeen;

module.exports.replyToMyTicket = replyToMyTicket;

// Shared by the photo and voice-note endpoints — only the upload field and
// the stored attachment type differ.
function replyWithAttachment(attachmentType) {
  return async function replyWithAttachmentToMyTicket(req, res, next) {
    try {
      const ticket = await findTicketForAgency(req.params.id, req.user.agency_id);
      if (!ticket) return res.status(404).json({ error: 'not_found' });
      if (!req.file) return res.status(400).json({ error: 'file_required', message: 'No file was uploaded' });
      const uploaded = await uploadBuffer(req.file.buffer, { folderParts: ['support-chat', ticket.id] });
      const message = await insertTicketMessage({ ticketId: ticket.id, senderUserId: req.user.id, message: req.body.message || '', attachmentUrl: uploaded.secure_url, attachmentType });
      await notifyStaffOfReply(ticket, { senderName: req.user.full_name, messagePreview: req.body.message || (attachmentType === 'audio' ? 'Voice message' : 'Image attachment') });
      res.status(201).json({ message: toPublicMessage({ ...message, sender_name: req.user.full_name, sender_role: req.user.role }) });
    } catch (err) { next(err); }
  };
}

module.exports.replyWithImageToMyTicket = replyWithAttachment('image');
module.exports.replyWithVoiceToMyTicket = replyWithAttachment('audio');
