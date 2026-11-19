-- Visa System — passport step (agent uploads front/back or the whole
-- passport; Gemini picks out the pages and extracts the details; the agent
-- reviews/edits them). passport_front_url / passport_back_url already exist
-- (0125_visa_system.sql).
--   passport_status : pending (nothing uploaded) | scanned (read, all hard
--                     checks passed) | needs_review (read with problems, or
--                     no AI — details typed by hand) | confirmed (agent
--                     reviewed and saved the details)
--   passport_scan   : the full scan report (page classification, checks,
--                     MRZ result, AI's raw reading) as JSON
--   passport_details: the details as last saved (extracted, then edited)
ALTER TABLE visa_applicants
  ADD COLUMN passport_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN passport_scan JSON,
  ADD COLUMN passport_details JSON;
