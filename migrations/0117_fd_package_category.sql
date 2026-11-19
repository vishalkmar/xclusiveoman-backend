ALTER TABLE fd_packages ADD COLUMN category VARCHAR(100) NULL;

INSERT IGNORE INTO categories (id, name, category)
SELECT UUID(), 'fd_package', theme FROM fd_packages
WHERE theme IS NOT NULL AND theme <> '';
