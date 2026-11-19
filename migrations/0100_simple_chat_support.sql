-- Support is a simple shared chat now; remove ticket workflow fields.
ALTER TABLE support_tickets
  DROP FOREIGN KEY fk_support_tickets_assigned,
  DROP INDEX idx_support_tickets_status,
  DROP INDEX idx_support_tickets_assigned,
  DROP COLUMN priority,
  DROP COLUMN status,
  DROP COLUMN assigned_to_user_id;
