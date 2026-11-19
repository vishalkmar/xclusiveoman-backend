-- Gallery photos: the admin uploads each one as Horizontal (landscape) or
-- Vertical (portrait) in Gallery Management, and the browser records its
-- real pixel size. The public Gallery page lays tiles out by orientation and
-- sizes each image from width/height so no photo is cropped. All nullable —
-- older rows (and landing-page card slots) fall back to detecting it on load.
ALTER TABLE gallery_items
  ADD COLUMN orientation ENUM('landscape', 'portrait') NULL AFTER image_url,
  ADD COLUMN width INT NULL AFTER orientation,
  ADD COLUMN height INT NULL AFTER width;
