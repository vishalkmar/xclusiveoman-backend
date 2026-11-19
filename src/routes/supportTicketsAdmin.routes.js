const {
  Router
} = require('express');

const ticketsAdminController = require('../controllers/supportTicketsAdmin.controller.js');

const {
  requireAuth,
  requireRole,
  requireFeature
} = require('../middleware/auth.js');
const { upload, audioUpload } = require('../middleware/upload.js');

const {
  validateBody,
  ticketMessageSchema,
  updateTicketWorkflowSchema
} = require('../validation/schemas.js');

const {
  messageLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();

// Admin Support & Helpdesk (Task 18 — Screen 28, SUP-2/SUP-3). Its own RBAC
// gate, independent of every other admin feature — support+super_admin,
// per the documentation's own role scoping (§4: "Finance / Support /
// Sales-Marketing... [scoped to] NEFT verification, helpdesk, and
// campaigns respectively"). Widened to also admit relationship_manager —
// the Team Portal's Support Tickets Access Feature, gated for real by
// requireFeature('supportTickets') below and scoped in the controller to
// just an RM's own assigned agencies (assertOwnAgencyTicket). sales_manager
// deliberately stays excluded — Support Tickets isn't one of LM_FEATURE_KEYS.
router.use(requireAuth, requireRole('support', 'super_admin', 'relationship_manager'));
router.use(requireFeature('supportTickets'));

// Literal path before the :id routes — same ordering
// packageRequestsAdmin.routes.js already uses for its own
// lead-manager-candidates route, so Express never tries to match this
// against :id. Left support+super_admin-only in practice — an RM has
// nothing to assign a ticket *to* here (listAssignmentCandidates only ever
// returns support staff/super_admins), so this simply comes back a usable
// but pointless empty-ish dropdown for one rather than needing its own gate.
router.get('/', ticketsAdminController.listTickets);
// Chat Logs & Analytics + assignee list — literal paths, so before /:id.
router.get('/analytics', ticketsAdminController.getAnalytics);
router.get('/analytics/logs', ticketsAdminController.getAnalyticsLogs);
router.get('/analytics/export', ticketsAdminController.exportAnalyticsLogs);
router.get('/assignees', ticketsAdminController.listAssignees);
router.get('/:id', ticketsAdminController.getTicket);
router.patch('/:id', validateBody(updateTicketWorkflowSchema), ticketsAdminController.updateTicket);
router.post('/:id/messages', messageLimiter, validateBody(ticketMessageSchema), ticketsAdminController.replyToTicket);
router.post('/:id/messages/image', messageLimiter, upload.single('image'), ticketsAdminController.replyWithImageToTicket);
router.post('/:id/messages/voice', messageLimiter, audioUpload.single('audio'), ticketsAdminController.replyWithVoiceToTicket);
router.post('/:id/seen', ticketsAdminController.markTicketSeen);

module.exports = router;
