-- Tours are priced per vehicle, by group size, instead of one per-person
-- price: each column is the TOTAL price for the whole group travelling in
-- that vehicle (src/utils/tourPricing.js holds the pax ranges):
--   Sedan          1-3 people
--   Land Cruiser   4-6 people
--   20 Seater Bus  7-20 people
--   35 Seater Bus  21-35 people
--   50 Seater Bus  36-50 people
-- The old per-person `price` column stays for tours created before this and
-- is only used as a fallback while a tour has no vehicle prices set.
ALTER TABLE tours
  ADD COLUMN price_sedan DECIMAL(12,2) NULL,
  ADD COLUMN price_land_cruiser DECIMAL(12,2) NULL,
  ADD COLUMN price_bus_20 DECIMAL(12,2) NULL,
  ADD COLUMN price_bus_35 DECIMAL(12,2) NULL,
  ADD COLUMN price_bus_50 DECIMAL(12,2) NULL;
