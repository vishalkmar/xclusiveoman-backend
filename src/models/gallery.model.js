const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');

async function listGalleryItems() {
  const { rows } = await pool.query('SELECT * FROM gallery_items ORDER BY category, sort_order, created_at');
  return rows;
}

async function createGalleryItem({ category, title, description, duration, price, nights, imageUrl, orientation, width, height, createdByUserId }) {
  const id = newId();
  await pool.query(
    'INSERT INTO gallery_items (id, category, title, description, duration, price, nights, image_url, orientation, width, height, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, category, title, description || null, duration || null, price || null, nights || null, imageUrl, orientation || null, width || null, height || null, createdByUserId || null]
  );
  return findGalleryItem(id);
}

async function findGalleryItem(id) {
  const { rows } = await pool.query('SELECT * FROM gallery_items WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateGalleryItem(id, { category, title, description, duration, price, nights, imageUrl, orientation, width, height }) {
  await pool.query(
    'UPDATE gallery_items SET category = COALESCE(?, category), title = COALESCE(?, title), description = COALESCE(?, description), duration = COALESCE(?, duration), price = COALESCE(?, price), nights = COALESCE(?, nights), image_url = COALESCE(?, image_url), orientation = COALESCE(?, orientation), width = COALESCE(?, width), height = COALESCE(?, height), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [category ?? null, title ?? null, description ?? null, duration ?? null, price ?? null, nights ?? null, imageUrl ?? null, orientation ?? null, width ?? null, height ?? null, id]
  );
  return findGalleryItem(id);
}

async function removeGalleryItem(id) {
  await pool.query('DELETE FROM gallery_items WHERE id = ?', [id]);
}

module.exports = { listGalleryItems, createGalleryItem, findGalleryItem, updateGalleryItem, removeGalleryItem };
