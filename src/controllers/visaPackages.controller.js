const {
  listVisaPackages,
  findVisaPackageById,
  createVisaPackage,
  updateVisaPackage,
  deleteVisaPackage,
} = require('../models/visaPackages.model.js');
const { getVisaHero, saveVisaHero } = require('../services/visaHero.service.js');
const { uploadBuffer, deleteImagesByUrl } = require('../services/cloudinary.service.js');

// Admin Create Visa → Visa Packages (visa cards: duration, entry type, valid
// for, maximum stay and an image — all required) and the agent Visa page's
// hero image (one global image, not part of any package).
//
// Create / update arrive as multipart form data (the fields + `image`):
// coercePackageForm turns the text fields back into numbers/booleans before
// validateBody(visaPackageSchema) runs. The image is required for a new
// package; on update it's optional, but the package must end up with one.

function toPublicVisaPackage(row) {
  return {
    id: row.id,
    durationDays: Number(row.duration_days),
    entryType: row.entry_type,
    validForDays: Number(row.valid_for_days),
    maxStayDays: Number(row.max_stay_days),
    imageUrl: row.image_url || null,
    priceMode: row.price_mode || 'global',
    priceMethod: row.price_mode || 'global',
    customPrice: row.custom_price == null ? null : Number(row.custom_price),
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports.toPublicVisaPackage = toPublicVisaPackage;

async function getPackages(req, res, next) {
  try {
    const rows = await listVisaPackages();
    res.json({ packages: rows.map(toPublicVisaPackage) });
  } catch (err) {
    next(err);
  }
}

module.exports.getPackages = getPackages;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Multipart sends every field as text — back to the types the schema expects.
function coercePackageForm(req, res, next) {
  const b = req.body || {};
  const num = (v) => (v === undefined || v === '' ? v : Number(v));
  const bool = (v) => (v === undefined || v === '' ? undefined : v === true || v === 'true' || v === '1');
  req.body = {
    ...b,
    durationDays: num(b.durationDays),
    validForDays: num(b.validForDays),
    maxStayDays: num(b.maxStayDays),
    ...(b.sortOrder !== undefined ? { sortOrder: num(b.sortOrder) } : {}),
    ...(b.isActive !== undefined ? { isActive: bool(b.isActive) } : {}),
    ...(b.priceMode !== undefined ? { priceMode: b.priceMode } : {}),
    ...(b.priceMethod !== undefined ? { priceMethod: b.priceMethod } : {}),
    ...(b.customPrice !== undefined ? { customPrice: num(b.customPrice) } : {}),
  };
  next();
}

module.exports.coercePackageForm = coercePackageForm;

function badImage(req, res) {
  if (req.file && !IMAGE_TYPES.has(req.file.mimetype)) {
    res.status(400).json({ error: 'invalid_image', message: 'The visa image must be a JPG, PNG or WebP.' });
    return true;
  }
  return false;
}

async function uploadPackageImage(file) {
  const uploaded = await uploadBuffer(file.buffer, { folderParts: ['visa', 'packages'], resourceType: 'image' });
  return uploaded.secure_url;
}

async function postPackage(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing_image', message: 'Add an image for this visa package.' });
    if (badImage(req, res)) return;
    const imageUrl = await uploadPackageImage(req.file);
    const row = await createVisaPackage({ ...req.body, imageUrl });
    res.status(201).json({ package: toPublicVisaPackage(row) });
  } catch (err) {
    next(err);
  }
}

module.exports.postPackage = postPackage;

async function putPackage(req, res, next) {
  try {
    const existing = await findVisaPackageById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (badImage(req, res)) return;
    // Every package needs an image — older ones get theirs on this edit.
    if (!req.file && !existing.image_url) {
      return res.status(400).json({ error: 'missing_image', message: 'Add an image for this visa package.' });
    }
    const imageUrl = req.file ? await uploadPackageImage(req.file) : null;
    const row = await updateVisaPackage(req.params.id, { ...req.body, imageUrl });
    // Replaced: delete the old image (best effort).
    if (imageUrl && existing.image_url && existing.image_url !== imageUrl) deleteImagesByUrl([existing.image_url]).catch(() => {});
    res.json({ package: toPublicVisaPackage(row) });
  } catch (err) {
    next(err);
  }
}

module.exports.putPackage = putPackage;

async function removePackage(req, res, next) {
  try {
    const existing = await findVisaPackageById(req.params.id);
    if (!existing || !(await deleteVisaPackage(req.params.id))) return res.status(404).json({ error: 'not_found' });
    if (existing.image_url) deleteImagesByUrl([existing.image_url]).catch(() => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports.removePackage = removePackage;

// ---- Hero image ------------------------------------------------------------------

async function getHero(req, res, next) {
  try {
    res.json({ hero: await getVisaHero() });
  } catch (err) {
    next(err);
  }
}

module.exports.getHero = getHero;

const HERO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Replaces the hero image (only ever one): uploads the new one, saves it,
// then deletes the old one from Cloudinary.
async function postHero(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing_file', message: 'Choose an image for the Visa page hero.' });
    if (!HERO_TYPES.has(req.file.mimetype)) {
      return res.status(400).json({ error: 'invalid_file', message: 'The hero image must be a JPG, PNG or WebP.' });
    }
    const previous = (await getVisaHero()).imageUrl;
    const uploaded = await uploadBuffer(req.file.buffer, { folderParts: ['visa', 'hero'] });
    const hero = await saveVisaHero(uploaded.secure_url, req.user.id);
    if (previous && previous !== uploaded.secure_url) deleteImagesByUrl([previous]).catch(() => {});
    res.status(201).json({ hero });
  } catch (err) {
    next(err);
  }
}

module.exports.postHero = postHero;

async function deleteHero(req, res, next) {
  try {
    const previous = (await getVisaHero()).imageUrl;
    const hero = await saveVisaHero(null, req.user.id);
    if (previous) deleteImagesByUrl([previous]).catch(() => {});
    res.json({ hero });
  } catch (err) {
    next(err);
  }
}

module.exports.deleteHero = deleteHero;
