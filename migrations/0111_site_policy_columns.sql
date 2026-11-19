ALTER TABLE site_terms
  ADD COLUMN terms_html TEXT NULL,
  ADD COLUMN privacy_html TEXT NULL,
  ADD COLUMN disclaimer_html TEXT NULL,
  ADD COLUMN refund_html TEXT NULL;

UPDATE site_terms
SET terms_html = body_html
WHERE terms_html = '' AND body_html <> '';
