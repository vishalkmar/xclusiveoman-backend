-- Admin visa processing. Once an application is paid ('submitted'), ops
-- collect each traveller's documents, start processing, and upload the
-- issued visa per traveller — which the agent can then download.
--
-- Application status: submitted -> processing (admin started work, or the
-- first visa was uploaded) -> approved (every traveller decided, at least
-- one visa issued) | rejected (every traveller rejected, or the whole
-- request rejected by the admin).
--
-- Per traveller (visa_applicants.visa_status):
--   pending  — no decision yet
--   issued   — visa uploaded (visa_document_url), available to the agent
--   rejected — refused (visa_rejection_reason)
ALTER TABLE visa_applicants
  ADD COLUMN visa_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN visa_document_url TEXT NULL,
  ADD COLUMN visa_document_name VARCHAR(200) NULL,
  ADD COLUMN visa_document_type VARCHAR(10) NULL,
  ADD COLUMN visa_number VARCHAR(60) NULL,
  ADD COLUMN visa_valid_until DATE NULL,
  ADD COLUMN visa_issued_at DATETIME NULL,
  ADD COLUMN visa_issued_by_user_id CHAR(36) NULL,
  ADD COLUMN visa_rejection_reason TEXT NULL,
  ADD CONSTRAINT fk_visa_applicants_issued_by FOREIGN KEY (visa_issued_by_user_id) REFERENCES users(id),
  ADD CONSTRAINT chk_visa_applicants_visa_status CHECK (visa_status IN ('pending', 'issued', 'rejected'));

ALTER TABLE visa_applications
  ADD COLUMN processing_started_at DATETIME NULL,
  ADD COLUMN completed_at DATETIME NULL,
  ADD COLUMN rejection_reason TEXT NULL;

CREATE INDEX idx_visa_applications_status ON visa_applications(status, submitted_at);

-- Tracking timeline for one application: what happened, to which traveller
-- (null = the whole application), by whom.
--   submitted, processing_started, visa_issued, visa_replaced, visa_removed,
--   traveller_rejected, application_approved, application_rejected
CREATE TABLE visa_application_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  applicant_id CHAR(36) NULL,
  event VARCHAR(40) NOT NULL,
  message TEXT NULL,
  actor_user_id CHAR(36) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_visa_application_events_app (application_id, created_at),
  CONSTRAINT fk_visa_application_events_app FOREIGN KEY (application_id) REFERENCES visa_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_visa_application_events_applicant FOREIGN KEY (applicant_id) REFERENCES visa_applicants(id) ON DELETE SET NULL,
  CONSTRAINT fk_visa_application_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
);
