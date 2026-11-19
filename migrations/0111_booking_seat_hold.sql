-- Seat holds for unpaid FD bookings (services/seatHold.service.js).
-- createFdBooking takes seats (fd_departure_dates.seats_booked) the moment a
-- booking is created, before any money arrives, and nothing ever gave them
-- back — a declined/failed/abandoned Cashfree payment left them taken
-- forever. These columns let an unpaid booking let go of its seats and take
-- them back again on the next "Pay" click.
--   seats_held           — 1 while this booking's pax are counted in its
--                          departure's seats_booked, 0 once released.
--   seat_hold_expires_at — set when a Cashfree checkout starts; if the
--                          booking is still unpaid after it, the seats are
--                          released (jobs/seatHoldRelease.job.js). NULL = no
--                          time limit (booking not yet at checkout, or an
--                          NEFT slip awaiting verification).
ALTER TABLE bookings
  ADD COLUMN seats_held TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN seat_hold_expires_at DATETIME NULL;

-- Every existing FD booking that wasn't waitlisted did take its seats.
UPDATE bookings
SET seats_held = 1
WHERE fd_departure_date_id IS NOT NULL AND status <> 'waitlisted';

CREATE INDEX idx_bookings_seat_hold ON bookings (seats_held, status, seat_hold_expires_at);
