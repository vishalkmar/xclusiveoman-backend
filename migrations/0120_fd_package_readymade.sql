-- Package type: a Fixed Departure package (dated departures with seat
-- inventory — the original and default kind) or a Readymade package (no
-- departure dates or seats; instead it is offered from every city, or from a
-- chosen list of departure cities).
--   type             — 'fd_package' | 'readymade'. Every existing package is an
--                      FD package. Only a draft can change type (the editor's
--                      two tabs), so a published package keeps its kind.
--   all_cities       — Readymade only: offered from all cities.
--   departure_cities — Readymade only: JSON array of departure city names (the
--                      same names as departure_locations.name) used when
--                      all_cities is off. Kept empty while all_cities is on.
ALTER TABLE fd_packages
  ADD COLUMN type ENUM('fd_package', 'readymade') NOT NULL DEFAULT 'fd_package',
  ADD COLUMN all_cities TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN departure_cities JSON NULL;
