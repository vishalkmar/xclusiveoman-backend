const {
  Router
} = require('express');

const ticketsController = require('../controllers/supportTicketsAgent.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');
const { upload, audioUpload } = require('../middleware/upload.js');

const {
  validateBody,
  createTicketSchema,
  ticketMessageSchema
} = require('../validation/schemas.js');

const {
  messageLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

// Agent Support & Helpdesk (Task 18 — Screen 27, SUP-1/SUP-3). Mounted at
// /api/support/tickets — same existing agency_owner/agency_staff gate every
// other agent-facing router in this codebase uses.
router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

router.get('/', ticketsController.listMyTickets);
router.post('/', messageLimiter, validateBody(createTicketSchema), ticketsController.createMyTicket);
router.post('/:id/messages', messageLimiter, validateBody(ticketMessageSchema), ticketsController.replyToMyTicket);
router.post('/:id/messages/image', messageLimiter, upload.single('image'), ticketsController.replyWithImageToMyTicket);
router.post('/:id/messages/voice', messageLimiter, audioUpload.single('audio'), ticketsController.replyWithVoiceToMyTicket);
router.post('/:id/seen', ticketsController.markMyTicketSeen);

module.exports = router;
