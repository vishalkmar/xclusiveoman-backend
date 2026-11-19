-- Payments → Package Controller shows when each FD package's pre-booking
-- setting was last changed, and by whom. NULL until the setting is first
-- saved from that page (the list falls back to the package's updated_at).
ALTER TABLE fd_packages
  ADD COLUMN prebooking_updated_at DATETIME NULL,
  ADD COLUMN prebooking_updated_by_user_id CHAR(36) NULL,
  ADD CONSTRAINT fk_fd_packages_prebooking_updated_by
    FOREIGN KEY (prebooking_updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
