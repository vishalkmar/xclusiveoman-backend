CREATE TABLE categories (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(30) NOT NULL,
  category VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY categories_name_category_unique (name, category)
);

INSERT IGNORE INTO categories (id, name, category)
SELECT UUID(), 'meal', category FROM meals
WHERE category IS NOT NULL AND category <> '' GROUP BY category;
