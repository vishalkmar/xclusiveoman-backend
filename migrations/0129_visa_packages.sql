-- Visa packages — admin-made visa cards (Visa Setup → Visa Packages): how
-- long the visa is for, its entry type, how long it stays valid and the
-- longest single stay. Every field is required. Day counts come from the
-- admin's presets (10 / 30 / 90 days, …) or a custom number; the entry type
-- is Single-Entry / Double-Entry / Multiple-Entry or a custom label.
--
-- The agent Visa page's hero image is NOT part of a package — it's one
-- global image kept in app_settings ('visa_hero'), see visaHero.service.js.
CREATE TABLE visa_packages (
  id CHAR(36) NOT NULL PRIMARY KEY,
  duration_days INT NOT NULL,
  entry_type VARCHAR(60) NOT NULL,
  valid_for_days INT NOT NULL,
  max_stay_days INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_visa_packages_duration CHECK (duration_days > 0),
  CONSTRAINT chk_visa_packages_valid_for CHECK (valid_for_days > 0),
  CONSTRAINT chk_visa_packages_max_stay CHECK (max_stay_days > 0)
);
