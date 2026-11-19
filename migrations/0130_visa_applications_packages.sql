-- Agents now apply for a Visa Package (0129_visa_packages.sql) instead of a
-- visa type + category — the admin Visa Types / Categories tabs are gone.
--
-- visa_type_id / visa_category_id become optional: applications made before
-- this keep theirs (and their labels); new ones leave them NULL and point at
-- the package instead. The package's details are copied onto the
-- application at the time it's made, so editing or deleting a package later
-- never changes what an existing application was for.
ALTER TABLE visa_applications
  MODIFY visa_type_id CHAR(36) NULL,
  MODIFY visa_category_id CHAR(36) NULL,
  ADD COLUMN visa_package_id CHAR(36) NULL AFTER visa_category_id,
  ADD COLUMN package_duration_days INT NULL AFTER visa_package_id,
  ADD COLUMN package_entry_type VARCHAR(60) NULL AFTER package_duration_days,
  ADD COLUMN package_valid_for_days INT NULL AFTER package_entry_type,
  ADD COLUMN package_max_stay_days INT NULL AFTER package_valid_for_days,
  ADD CONSTRAINT fk_visa_applications_package FOREIGN KEY (visa_package_id) REFERENCES visa_packages(id) ON DELETE SET NULL;
