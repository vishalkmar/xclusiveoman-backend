-- The price an FD package is offered at once the platform fee is applied, kept
-- on the package itself so the admin screens show (and can sort/export) it
-- without recomputing, and refreshed whenever something that feeds it changes:
-- the package or its itinerary is saved, the global platform-fee setting is
-- updated, or a package's own fee setting is changed.
--   rate_with_fee        - per-person rate (at the 2-traveller baseline) with
--                          the platform fee added; the same figure agents are
--                          quoted for this package.
--   platform_fee_applied - the percentage that was added (0 when the fee is
--                          disabled or the package is set to "none").
ALTER TABLE fd_packages
  ADD COLUMN rate_with_fee DECIMAL(12,3) NULL,
  ADD COLUMN platform_fee_applied DECIMAL(5,2) NULL;
