-- The initial FD platform-fee default is 4%. Existing explicit admin choices
-- are preserved; this only changes installations still on the old seed value.
UPDATE app_settings
SET setting_value = JSON_OBJECT('enabled', true, 'percentage', 4)
WHERE setting_key = 'fd_platform_fee'
  AND JSON_EXTRACT(setting_value, '$.enabled') = false
  AND JSON_EXTRACT(setting_value, '$.percentage') = 0;
