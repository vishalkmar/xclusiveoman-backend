-- Vehicles master list (Product Catalog > Vehicles tab). A tour's pricing by
-- vehicle picks its vehicles from here instead of typing a name and passenger
-- range each time; the price entered against a vehicle on a tour is the total
-- for that vehicle filled to capacity (per-person = price / max_pax).
--   name    - shown in the tour pricing dropdown ("Sedan", "20 Seater Bus", ...)
--   min_pax - smallest group that travels in this vehicle
--   max_pax - its capacity (the divisor for the per-person price)
-- Seeded with the five vehicles tours were already priced against.
CREATE TABLE vehicles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  min_pax INT NOT NULL,
  max_pax INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicles_name (name)
);

INSERT INTO vehicles (id, name, min_pax, max_pax) VALUES
  (UUID(), 'Sedan', 1, 3),
  (UUID(), 'Land Cruiser', 4, 6),
  (UUID(), '20 Seater Bus', 7, 20),
  (UUID(), '35 Seater Bus', 21, 35),
  (UUID(), '50 Seater Bus', 36, 50);
