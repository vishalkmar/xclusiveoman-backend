-- Persist the human-facing visa application reference separately from the
-- UUID primary key. UUIDs remain unchanged for existing relationships/routes.
ALTER TABLE visa_applications
  ADD COLUMN reference VARCHAR(20) NULL AFTER id;

UPDATE visa_applications
SET reference = CONCAT('VISA-', UPPER(LEFT(REPLACE(id, '-', ''), 8)))
WHERE reference IS NULL;

ALTER TABLE visa_applications
  MODIFY reference VARCHAR(20) NOT NULL,
  ADD UNIQUE KEY uq_visa_applications_reference (reference);
