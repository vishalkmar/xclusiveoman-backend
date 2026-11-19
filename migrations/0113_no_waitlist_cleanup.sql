-- Cleanup for the switch to "no waitlist, no lingering pending bookings"
-- (services/booking.service.js, services/seatHold.service.js):
--   - a booking for a full departure is now refused outright instead of
--     being saved as 'waitlisted';
--   - an unpaid booking whose seat hold ends is cancelled, and its payment
--     attempt closed, instead of staying 'pending_payment'.

-- 1. Waitlisted bookings that never took any money: remove them. Only rows
--    with no payments, transactions or reviews (the foreign keys without
--    ON DELETE CASCADE); travellers, add-ons and vouchers cascade.
--    Waitlisted bookings that did take money are left alone for an admin.
DELETE b FROM bookings b
WHERE b.status = 'waitlisted'
  AND b.deposit_paid <= 0
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.booking_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = b.id);

-- 2. Unpaid bookings whose seats were already released (0111/0112) but
--    still read 'pending_payment': close their open payment attempts and
--    cancel them, as a release now does.
UPDATE payments p
JOIN bookings b ON b.id = p.booking_id
SET p.status = 'cancelled', p.updated_at = now()
WHERE b.status = 'pending_payment'
  AND b.deposit_paid <= 0
  AND b.seats_held = 0
  AND b.fd_departure_date_id IS NOT NULL
  AND p.status IN ('pending', 'awaiting_payment');

UPDATE bookings b
SET b.status = 'cancelled', b.seat_hold_expires_at = NULL, b.updated_at = now()
WHERE b.status = 'pending_payment'
  AND b.deposit_paid <= 0
  AND b.seats_held = 0
  AND b.fd_departure_date_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.booking_id = b.id AND p.status IN ('pending_verification', 'awaiting_confirmation')
  );
