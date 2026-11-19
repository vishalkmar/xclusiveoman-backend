-- Chat Logs & Analytics. 0100 reduced support to a plain chat; the
-- analytics dashboard needs a lightweight workflow back on top of it, with
-- chat-oriented values (status is maintained automatically as messages
-- arrive — see supportTickets.model.js#insertTicketMessage), plus voice-note
-- attachments on messages.
ALTER TABLE support_tickets
  ADD COLUMN status ENUM('new', 'open', 'waiting_admin', 'waiting_user', 'resolved', 'closed') NOT NULL DEFAULT 'new',
  ADD COLUMN priority ENUM('low', 'medium', 'high', 'urgent') NOT NULL DEFAULT 'medium',
  ADD COLUMN category ENUM('booking', 'payment', 'cancellation', 'account', 'technical', 'general', 'other') NOT NULL DEFAULT 'general',
  ADD COLUMN assigned_to_user_id CHAR(36) NULL,
  ADD COLUMN first_response_at DATETIME NULL,
  ADD COLUMN resolved_at DATETIME NULL,
  ADD COLUMN reopened_count INT NOT NULL DEFAULT 0,
  ADD COLUMN last_message_at DATETIME NULL,
  ADD CONSTRAINT fk_support_tickets_assignee FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_support_tickets_status ON support_tickets(status);
CREATE INDEX idx_support_tickets_assignee ON support_tickets(assigned_to_user_id);
CREATE INDEX idx_support_tickets_created ON support_tickets(created_at);

ALTER TABLE ticket_messages ADD COLUMN attachment_type VARCHAR(16) NULL;

UPDATE ticket_messages SET attachment_type = 'image' WHERE attachment_url IS NOT NULL;

-- Backfill existing chats. Staff = users with no agency (users.model.js#listStaff).
UPDATE support_tickets t SET
  first_response_at = (
    SELECT MIN(tm.created_at) FROM ticket_messages tm JOIN users u ON u.id = tm.sender_user_id
    WHERE tm.ticket_id = t.id AND u.agency_id IS NULL
  ),
  last_message_at = COALESCE((SELECT MAX(tm.created_at) FROM ticket_messages tm WHERE tm.ticket_id = t.id), t.created_at);

UPDATE support_tickets t SET status = CASE
  WHEN t.first_response_at IS NULL THEN 'new'
  WHEN (
    SELECT u.agency_id FROM ticket_messages tm JOIN users u ON u.id = tm.sender_user_id
    WHERE tm.ticket_id = t.id ORDER BY tm.created_at DESC LIMIT 1
  ) IS NULL THEN 'waiting_user'
  ELSE 'waiting_admin'
END;
