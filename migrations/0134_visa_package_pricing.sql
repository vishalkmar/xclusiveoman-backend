-- Per-visa fee overrides. global follows app_settings.visa_price.
ALTER TABLE visa_packages
  ADD COLUMN price_mode ENUM('global', 'custom') NOT NULL DEFAULT 'global' AFTER image_url,
  ADD COLUMN custom_price DECIMAL(12,3) NULL AFTER price_mode;
