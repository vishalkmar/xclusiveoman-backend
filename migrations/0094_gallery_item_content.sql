ALTER TABLE gallery_items
  ADD COLUMN description TEXT NULL AFTER title,
  ADD COLUMN duration VARCHAR(120) NULL AFTER description,
  ADD COLUMN price VARCHAR(120) NULL AFTER duration;
