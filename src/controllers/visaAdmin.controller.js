const {
  listVisaTypes,
  findVisaTypeById,
  createVisaType,
  updateVisaType,
  deleteVisaType,
  isVisaTypeInUse,
  listVisaCategories,
  findVisaCategoryById,
  createVisaCategory,
  updateVisaCategory,
  deleteVisaCategory,
  isVisaCategoryInUse,
} = require('../models/visa.model.js');
const { getVisaPrice, saveVisaPrice } = require('../services/visaPricing.service.js');
const { listVisaPackages, findVisaPackageById, updateVisaPackage } = require('../models/visaPackages.model.js');

function toPublicVisaPackagePricing(row) {
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
  };
}

// Admin "Visa Setup" page — the visa types and categories agents pick from
// on the agent "Apply for Visa" page (visa.controller.js).

function toPublicVisaType(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
  };
}

module.exports.toPublicVisaType = toPublicVisaType;

function toPublicVisaCategory(row) {
  return {
    id: row.id,
    visaTypeId: row.visa_type_id,
    name: row.name,
    description: row.description,
    processingTime: row.processing_time,
    isActive: !!row.is_active,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

module.exports.toPublicVisaCategory = toPublicVisaCategory;

function isDuplicate(err) {
  return err?.code === 'ER_DUP_ENTRY';
}

async function getTypes(req, res, next) {
  try {
    const rows = await listVisaTypes();
    res.json({ types: rows.map(toPublicVisaType) });
  } catch (err) {
    next(err);
  }
}

module.exports.getTypes = getTypes;

async function postType(req, res, next) {
  try {
    const row = await createVisaType(req.body);
    res.status(201).json({ type: toPublicVisaType(row) });
  } catch (err) {
    if (isDuplicate(err)) return res.status(409).json({ error: 'duplicate', message: 'A visa type with this name already exists.' });
    next(err);
  }
}

module.exports.postType = postType;

async function patchType(req, res, next) {
  try {
    if (!(await findVisaTypeById(req.params.id))) return res.status(404).json({ error: 'not_found' });
    const row = await updateVisaType(req.params.id, req.body);
    res.json({ type: toPublicVisaType(row) });
  } catch (err) {
    if (isDuplicate(err)) return res.status(409).json({ error: 'duplicate', message: 'A visa type with this name already exists.' });
    next(err);
  }
}

module.exports.patchType = patchType;

async function removeType(req, res, next) {
  try {
    if (await isVisaTypeInUse(req.params.id)) {
      return res.status(409).json({
        error: 'in_use',
        message: 'Agents have already applied under this visa type. Mark it inactive instead of deleting it.',
      });
    }
    if (!(await deleteVisaType(req.params.id))) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports.removeType = removeType;

async function getCategories(req, res, next) {
  try {
    const rows = await listVisaCategories({ typeId: req.query.typeId || undefined });
    res.json({ categories: rows.map(toPublicVisaCategory) });
  } catch (err) {
    next(err);
  }
}

module.exports.getCategories = getCategories;

async function postCategory(req, res, next) {
  try {
    if (!(await findVisaTypeById(req.body.visaTypeId))) {
      return res.status(400).json({ error: 'invalid_type', message: 'Choose an existing visa type.' });
    }
    const row = await createVisaCategory(req.body);
    res.status(201).json({ category: toPublicVisaCategory(row) });
  } catch (err) {
    if (isDuplicate(err)) {
      return res.status(409).json({ error: 'duplicate', message: 'This visa type already has a category with this name.' });
    }
    next(err);
  }
}

module.exports.postCategory = postCategory;

async function patchCategory(req, res, next) {
  try {
    if (!(await findVisaCategoryById(req.params.id))) return res.status(404).json({ error: 'not_found' });
    if (req.body.visaTypeId && !(await findVisaTypeById(req.body.visaTypeId))) {
      return res.status(400).json({ error: 'invalid_type', message: 'Choose an existing visa type.' });
    }
    const row = await updateVisaCategory(req.params.id, req.body);
    res.json({ category: toPublicVisaCategory(row) });
  } catch (err) {
    if (isDuplicate(err)) {
      return res.status(409).json({ error: 'duplicate', message: 'This visa type already has a category with this name.' });
    }
    next(err);
  }
}

module.exports.patchCategory = patchCategory;

async function removeCategory(req, res, next) {
  try {
    if (await isVisaCategoryInUse(req.params.id)) {
      return res.status(409).json({
        error: 'in_use',
        message: 'Agents have already applied under this category. Mark it inactive instead of deleting it.',
      });
    }
    if (!(await deleteVisaCategory(req.params.id))) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports.removeCategory = removeCategory;

// Payments → Package Controller → Visa tab: the ONE per-person visa price
// (visaPricing.service.js), the same for every visa package. Set only
// here (finance/ops/super admin) — Visa Setup has no price.
async function getVisaPricing(req, res, next) {
  try {
    const [pricing, packages] = await Promise.all([getVisaPrice(), listVisaPackages()]);
    res.json({
      ...pricing,
      visaPackageCount: packages.length,
      packages: packages.map(toPublicVisaPackagePricing),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getVisaPricing = getVisaPricing;

async function putVisaPrice(req, res, next) {
  try {
    res.json(await saveVisaPrice({ pricePerPerson: req.body.defaultPrice ?? req.body.pricePerPerson }, req.user.id));
  } catch (err) {
    next(err);
  }
}

module.exports.putVisaPrice = putVisaPrice;

async function putVisaPackagePrice(req, res, next) {
  try {
    const pkg = await findVisaPackageById(req.params.id);
    if (!pkg) return res.status(404).json({ error: 'not_found' });
    const priceMode = req.body.priceMethod || req.body.priceMode;
    const row = await updateVisaPackage(req.params.id, { ...pkg, durationDays: pkg.duration_days, entryType: pkg.entry_type, validForDays: pkg.valid_for_days, maxStayDays: pkg.max_stay_days, priceMode, priceMethod: priceMode, customPrice: req.body.customPrice });
    res.json({ package: toPublicVisaPackagePricing(row) });
  } catch (err) { next(err); }
}

module.exports.putVisaPackagePrice = putVisaPackagePrice;
