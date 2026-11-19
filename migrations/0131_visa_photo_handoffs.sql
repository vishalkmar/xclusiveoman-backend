-- "Scan with phone" on the visa photo step: the agent's computer shows a QR
-- code, the traveller's phone opens it (no login) and takes the photo with
-- its front camera, and the photo is saved to that one traveller.
--
-- The QR carries a random token; only its SHA-256 is stored here (same as
-- password reset links). A token works for exactly one traveller, expires
-- after a few minutes, and is used up once a photo is saved.
--
-- status: pending (QR shown) | opened (phone opened the link) |
--         completed (photo saved) | cancelled (agent closed it / made a new QR)
CREATE TABLE visa_photo_handoffs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  applicant_id CHAR(36) NOT NULL,
  agency_id CHAR(36) NOT NULL,
  created_by_user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  opened_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visa_photo_handoffs_token (token_hash),
  CONSTRAINT fk_visa_photo_handoffs_application FOREIGN KEY (application_id) REFERENCES visa_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_visa_photo_handoffs_applicant FOREIGN KEY (applicant_id) REFERENCES visa_applicants(id) ON DELETE CASCADE,
  CONSTRAINT fk_visa_photo_handoffs_agency FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE,
  CONSTRAINT fk_visa_photo_handoffs_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_visa_photo_handoffs_applicant ON visa_photo_handoffs(applicant_id, status);
