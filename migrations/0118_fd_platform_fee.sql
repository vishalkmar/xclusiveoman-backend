-- FD platform fee: a hidden percentage added to the calculated package rate.
-- Global default lives in app_settings; each package can follow it, override it,
-- or disable the fee.
INSERT INTO app_settings (setting_key, setting_value)
  VALUES ('fd_platform_fee', JSON_OBJECT('enabled', true, 'percentage', 4));

ALTER TABLE fd_packages
  ADD COLUMN platform_fee_mode ENUM('global', 'none', 'custom') NOT NULL DEFAULT 'global',
  ADD COLUMN platform_fee_percentage DECIMAL(5,2) NULL;
