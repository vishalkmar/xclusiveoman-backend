-- Agent Sign Up (Register.jsx) now asks which kind of document is being
-- uploaded — IATA certificate, GST certificate or Company Registration —
-- alongside the document itself (license_document_url, 0068) and its number
-- (the existing license_number column). NULL for agencies registered before
-- this, or created admin-side.
-- The optional company logo picked at Sign Up goes into the existing
-- agencies.logo_asset_url column (the same one the agent's Profile page
-- edits), so it needs no new column.
ALTER TABLE agencies
  ADD COLUMN license_document_type ENUM('iata', 'gst', 'company_registration') NULL AFTER license_number;
