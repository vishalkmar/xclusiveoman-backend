-- One-time cleanup for 0111_booking_seat_hold.sql: self-service FD bookings
-- created before seat holds existed, still unpaid and still holding seats
-- with no time limit (the agent never paid, or never reached checkout).
-- Marking their hold as already lapsed lets jobs/seatHoldRelease.job.js
-- release them on its next run — it checks any open Cashfree attempt with
-- Cashfree first, so a booking that was actually paid is confirmed, not
-- released. A booking with an NEFT slip awaiting verification is skipped
-- here (and by the release itself). The bookings stay as they are; if the
-- agent pays later, the seats are taken back if still free.
UPDATE bookings b
SET b.seat_hold_expires_at = now()
WHERE b.seats_held = 1
  AND b.status = 'pending_payment'
  AND b.deposit_paid <= 0
  AND b.created_via = 'self_service'
  AND b.fd_departure_date_id IS NOT NULL
  AND b.seat_hold_expires_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.booking_id = b.id AND p.status = 'pending_verification'
  );
