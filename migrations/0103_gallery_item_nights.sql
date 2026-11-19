-- Landing page Signature Tours cards: the "4N | 5D" nights/days badge,
-- editable per card from admin Gallery Management.
ALTER TABLE gallery_items ADD COLUMN nights VARCHAR(40) NULL AFTER price;
