-- A vehicle's own price on the Vehicles tab: the total for the vehicle filled
-- to capacity. A tour that prices this vehicle starts from it (and can still
-- set its own figure); per-person is price / max_pax. NULL for vehicles that
-- were seeded before this and haven't been given a price yet.
ALTER TABLE vehicles
  ADD COLUMN price DECIMAL(12,2) NULL;
