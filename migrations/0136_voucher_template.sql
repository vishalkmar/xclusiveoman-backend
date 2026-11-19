-- Voucher Manager: per-voucher editable template (logo + size, header text,
-- special-offers title, remarks stamp/signature, notes, footer contact) so a
-- voucher matches the supplier's real confirmation layout. NULL on older rows
-- means "use the frontend's default template text" for that part.
--
-- The real confirmations leave Booking Reference No / Member ID / Children /
-- Promotion etc. blank, so the count columns become nullable too.
ALTER TABLE vouchers
  MODIFY rooms INT NULL,
  MODIFY extra_beds INT NULL,
  MODIFY adults INT NULL,
  MODIFY children INT NULL,
  ADD COLUMN logo_url VARCHAR(1000) NULL,
  ADD COLUMN logo_width INT NULL,
  ADD COLUMN logo_height INT NULL,
  ADD COLUMN header_title VARCHAR(120) NULL,
  ADD COLUMN header_title_accent VARCHAR(120) NULL,
  ADD COLUMN header_subtitle VARCHAR(500) NULL,
  ADD COLUMN special_offers_title VARCHAR(255) NULL,
  ADD COLUMN stamp_url VARCHAR(1000) NULL,
  ADD COLUMN stamp_width INT NULL,
  ADD COLUMN stamp_height INT NULL,
  ADD COLUMN signature_label VARCHAR(255) NULL,
  ADD COLUMN notes TEXT NULL,
  ADD COLUMN footer_contact TEXT NULL;
