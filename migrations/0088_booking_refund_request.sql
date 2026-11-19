-- Agent-initiated refund requests (Request Refund button, BookingDetail).
-- Submitting one only flips status to 'cancellation_requested' and records
-- what was asked for — admin reviews and actions the actual Cashfree refund
-- separately, so these columns are a record of the request, not a payout.
ALTER TABLE bookings
  ADD COLUMN refund_requested_amount DECIMAL(12,2) NULL,
  ADD COLUMN refund_requested_at DATETIME NULL,
  ADD COLUMN refund_reason TEXT NULL;
