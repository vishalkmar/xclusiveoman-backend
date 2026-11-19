-- Standalone Visa System (agent "Apply for Visa" flow), separate from the
-- older single-price visa add-on on packages (0051_visa_catalog.sql).
--   visa_types       - admin-managed top level ("Tourist", "Business", ...)
--   visa_categories  - admin-managed options under a type ("30 days single
--                      entry", ...), each with its own OMR price
--   visa_applications- one per agent submission: chosen type/category + the
--                      agency that owns it
--   visa_applicants  - one row per person on an application (name, photo,
--                      photo verification result, passport pages)
CREATE TABLE visa_types (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visa_types_name (name)
);

CREATE TABLE visa_categories (
  id CHAR(36) NOT NULL PRIMARY KEY,
  visa_type_id CHAR(36) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  price DECIMAL(12,3),
  processing_time VARCHAR(100),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visa_categories_type_name (visa_type_id, name),
  CONSTRAINT fk_visa_categories_type FOREIGN KEY (visa_type_id) REFERENCES visa_types(id) ON DELETE CASCADE
);

CREATE TABLE visa_applications (
  id CHAR(36) NOT NULL PRIMARY KEY,
  agency_id CHAR(36) NOT NULL,
  created_by_user_id CHAR(36) NOT NULL,
  visa_type_id CHAR(36) NOT NULL,
  visa_category_id CHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_visa_applications_agency FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE CASCADE,
  CONSTRAINT fk_visa_applications_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_visa_applications_type FOREIGN KEY (visa_type_id) REFERENCES visa_types(id),
  CONSTRAINT fk_visa_applications_category FOREIGN KEY (visa_category_id) REFERENCES visa_categories(id)
);

CREATE INDEX idx_visa_applications_agency ON visa_applications(agency_id, created_at);

-- photo_status: pending (no photo yet) | approved (all checks passed) |
-- needs_review (saved, but the AI check couldn't run — staff verify by eye)
-- photo_check: the full check report (client + server + AI) as JSON.
CREATE TABLE visa_applicants (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  position INT NOT NULL,
  full_name VARCHAR(200),
  photo_url TEXT,
  photo_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  photo_check JSON,
  photo_source VARCHAR(20),
  passport_front_url TEXT,
  passport_back_url TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_visa_applicants_application FOREIGN KEY (application_id) REFERENCES visa_applications(id) ON DELETE CASCADE
);

CREATE INDEX idx_visa_applicants_application ON visa_applicants(application_id, position);
