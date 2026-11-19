const { uploadBuffer } = require('../services/cloudinary.service.js');
const {
  listGalleryItems,
  createGalleryItem,
  findGalleryItem,
  updateGalleryItem,
  removeGalleryItem,
} = require('../models/gallery.model.js');

async function list(req, res, next) {
  try { res.json({ gallery: await listGalleryItems() }); } catch (err) { next(err); }
}

// Landing page card slots — Signature Tours ('landing-tour-1'..'-3'),
// Activities ('landing-activity-1'..'-6') and Transfers
// ('landing-transfer-1'..'-2').
// Every field on a slot is optional — an empty field falls back to the
// card's built-in content on the public page — so a slot may be saved with
// just new text and no image, or just an image and no title.
const LANDING_CARD_SLOT_RE = /^landing-(tour|activity|transfer)-\d+$/;

// Photo shape (0106_gallery_item_orientation.sql) — the admin's chosen
// orientation plus the image's measured pixel size. Anything malformed is
// dropped rather than rejected: these only steer layout, and the public page
// can always detect orientation from the image itself.
const ORIENTATIONS = new Set(['landscape', 'portrait']);
function photoShape(body) {
  const dimension = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 && n <= 20000 ? n : undefined;
  };
  return {
    orientation: ORIENTATIONS.has(body.orientation) ? body.orientation : undefined,
    width: dimension(body.width),
    height: dimension(body.height),
  };
}

async function create(req, res, next) {
  try {
    const { category, description, duration, price, nights } = req.body;
    let { title, imageUrl } = req.body;
    if (category && LANDING_CARD_SLOT_RE.test(category)) {
      title = title || '';
      imageUrl = imageUrl || '';
    } else if (!category || !title || !imageUrl) {
      return res.status(400).json({ error: 'invalid_gallery_item', message: 'Category, title and imageUrl are required' });
    }
    const item = await createGalleryItem({ category, title, description, duration, price, nights, imageUrl, ...photoShape(req.body), createdByUserId: req.user.id });
    res.status(201).json({ galleryItem: item });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    if ('orientation' in req.body && !ORIENTATIONS.has(req.body.orientation)) {
      return res.status(400).json({ error: 'invalid_orientation', message: 'Orientation must be landscape or portrait' });
    }
    const item = await updateGalleryItem(req.params.id, { ...req.body, ...photoShape(req.body) });
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json({ galleryItem: item });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try { await removeGalleryItem(req.params.id); res.status(204).send(); } catch (err) { next(err); }
}

async function uploadImage(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing_file', message: 'Upload an image' });
    const uploaded = await uploadBuffer(req.file.buffer, { folderParts: ['gallery'] });
    res.status(201).json({ url: uploaded.secure_url });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, uploadImage };
