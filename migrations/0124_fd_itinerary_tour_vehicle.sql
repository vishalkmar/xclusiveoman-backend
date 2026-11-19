-- The vehicle chosen for a tour placed in an FD package's day-by-day itinerary.
-- vehicle_key is the "key" of one of the tour's vehicle_prices rows (the
-- vehicle's id for rows linked to the Vehicles tab). The package is priced
-- with that vehicle's per-person price (price / max passengers), whatever the
-- group size. NULL for non-tour items and for tours placed before this, which
-- keep being priced by group size.
ALTER TABLE fd_itinerary_items
  ADD COLUMN vehicle_key VARCHAR(100) NULL;
