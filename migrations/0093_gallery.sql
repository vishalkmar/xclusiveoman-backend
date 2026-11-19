CREATE TABLE gallery_items (
  id CHAR(36) PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  image_url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_by_user_id CHAR(36),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_gallery_items_created_by FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_gallery_items_category_order ON gallery_items(category, sort_order, created_at);
