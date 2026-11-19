const model = require('../models/vouchers.model.js');
const { uploadBuffer } = require('../services/cloudinary.service.js');

// The supplier's real confirmations leave several fields blank (Booking
// Reference No, Member ID, Number of Children, Promotion, ...), so only the
// fields a voucher can't make sense without are mandatory.
const REQUIRED = ['bookingId', 'client', 'property', 'arrival', 'departure', 'status'];
const STATUSES = new Set(['Ready', 'Draft', 'Cancelled']);
const INT_FIELDS = ['rooms', 'extraBeds', 'adults', 'children', 'logoWidth', 'logoHeight', 'stampWidth', 'stampHeight'];
const MAX_LEN = {
  logoUrl: 1000, stampUrl: 1000, headerTitle: 120, headerTitleAccent: 120, headerSubtitle: 500,
  specialOffersTitle: 255, signatureLabel: 255, notes: 20000, footerContact: 2000,
};

function validate(body) {
  const errors = {};
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === null || String(body[key]).trim() === '') errors[key] = 'required';
  }
  if (body.status && !STATUSES.has(body.status)) errors.status = 'invalid';
  for (const key of INT_FIELDS) {
    const v = body[key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10000) errors[key] = 'invalid_number';
  }
  for (const [key, max] of Object.entries(MAX_LEN)) {
    if (body[key] != null && String(body[key]).length > max) errors[key] = 'too_long';
  }
  for (const key of ['logoUrl', 'stampUrl']) {
    const v = body[key];
    if (v && !/^(https:\/\/|\/)/.test(String(v))) errors[key] = 'invalid_url';
  }
  if (body.arrival && body.departure && String(body.departure).slice(0, 10) < String(body.arrival).slice(0, 10)) {
    errors.departure = 'before_arrival';
  }
  return errors;
}

function rejectInvalid(res, errors) {
  const keys = Object.keys(errors);
  if (!keys.length) return false;
  res.status(400).json({
    error: 'validation_error',
    message: `Please check: ${keys.join(', ')}`,
    missing: keys.filter((k) => errors[k] === 'required'),
    fields: errors,
  });
  return true;
}

async function list(req, res, next) {
  try { res.json({ vouchers: await model.listVouchers(req.query) }); } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    if (rejectInvalid(res, validate(req.body))) return;
    res.status(201).json({ voucher: await model.createVoucher(req.body) });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    if (rejectInvalid(res, validate(req.body))) return;
    const voucher = await model.updateVoucher(req.params.id, req.body);
    if (!voucher) return res.status(404).json({ error: 'voucher_not_found' });
    res.json({ voucher });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const voucher = await model.findVoucher(req.params.id);
    if (!voucher) return res.status(404).json({ error: 'voucher_not_found' });
    await model.deleteVoucher(req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
}

// Logo / stamp image for a voucher template -> Cloudinary URL.
async function uploadAsset(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'missing_file', message: 'Upload an image' });
    if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ error: 'invalid_file', message: 'Upload a PNG, JPG or WEBP image' });
    const uploaded = await uploadBuffer(req.file.buffer, { folderParts: ['vouchers'], resourceType: 'image' });
    res.status(201).json({ url: uploaded.secure_url, width: uploaded.width, height: uploaded.height });
  } catch (err) { next(err); }
}

module.exports = { list, create, update, remove, uploadAsset };
