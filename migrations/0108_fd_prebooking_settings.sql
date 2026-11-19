-- Admin "Payments → Package Controller": controls the FD pre-booking
-- (deposit) payment an agent makes to hold seats.
--
-- app_settings is a small key/value store for portal-wide admin settings.
-- 'fd_prebooking' holds the global rule: { enabled, percentage }. When enabled,
-- a booking more than 15 days before departure pays `percentage`% of the
-- total now; when disabled, the full amount is due at booking.
CREATE TABLE app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by_user_id CHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_app_settings_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO app_settings (setting_key, setting_value)
  VALUES ('fd_prebooking', JSON_OBJECT('enabled', true, 'percentage', 10));

-- Per-package override of the global rule:
--   'global' — follow the global setting (default, so existing packages are unchanged)
--   'none'   — no pre-booking: the full amount is due at booking
--   'custom' — prebooking_percentage% of the total, whatever the global setting says
ALTER TABLE fd_packages
  ADD COLUMN prebooking_mode ENUM('global', 'none', 'custom') NOT NULL DEFAULT 'global',
  ADD COLUMN prebooking_percentage DECIMAL(5,2) NULL;
