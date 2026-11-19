const { pool } = require('../db/pool.js');
const { randomUUID } = require('crypto');

// camelCase API field -> DB column. Order here is the INSERT/UPDATE order.
// `kind`: 'text' = NOT NULL text column ('' when blank), 'int' = nullable
// count, 'date' = arrival/departure, 'opt' = nullable template text (NULL
// means "use the default template text"; '' means "deliberately empty").
const FIELDS = [
  ['bookingId', 'booking_id', 'text'],
  ['bookingReference', 'booking_reference', 'text'],
  ['client', 'client', 'text'],
  ['memberId', 'member_id', 'text'],
  ['country', 'country', 'text'],
  ['property', 'property_name', 'text'],
  ['address', 'address', 'text'],
  ['propertyContact', 'property_contact', 'text'],
  ['rooms', 'rooms', 'int'],
  ['extraBeds', 'extra_beds', 'int'],
  ['adults', 'adults', 'int'],
  ['children', 'children', 'int'],
  ['roomType', 'room_type', 'text'],
  ['promotion', 'promotion', 'text'],
  ['inclusions', 'inclusions', 'text'],
  ['included', 'included', 'text'],
  ['arrival', 'arrival', 'date'],
  ['departure', 'departure', 'date'],
  ['bookedAndPayableBy', 'booked_and_payable_by', 'text'],
  ['remarks', 'remarks', 'text'],
  ['status', 'status', 'text'],
  ['logoUrl', 'logo_url', 'opt'],
  ['logoWidth', 'logo_width', 'int'],
  ['logoHeight', 'logo_height', 'int'],
  ['headerTitle', 'header_title', 'opt'],
  ['headerTitleAccent', 'header_title_accent', 'opt'],
  ['headerSubtitle', 'header_subtitle', 'opt'],
  ['specialOffersTitle', 'special_offers_title', 'opt'],
  ['stampUrl', 'stamp_url', 'opt'],
  ['stampWidth', 'stamp_width', 'int'],
  ['stampHeight', 'stamp_height', 'int'],
  ['signatureLabel', 'signature_label', 'opt'],
  ['notes', 'notes', 'opt'],
  ['footerContact', 'footer_contact', 'opt'],
];

const COLUMNS = ['id', ...FIELDS.map(([, col]) => col), 'created_at', 'updated_at'].join(', ');

function toDbValue(value, kind) {
  if (kind === 'int') {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (kind === 'opt') return value === undefined || value === null ? null : String(value);
  if (kind === 'date') return value ? String(value).slice(0, 10) : null;
  return value === undefined || value === null ? '' : String(value).trim();
}

// mysql2 turns a DATE into a JS Date at this server's local midnight; sent
// as-is it serialises to UTC and can show a day early in a browser in a
// different timezone. Send the calendar date itself instead.
function dateOnly(value) {
  if (!(value instanceof Date)) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function publicVoucher(row) {
  const out = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const [key, col, kind] of FIELDS) out[key] = kind === 'date' ? dateOnly(row[col]) : row[col];
  // Legacy aliases the list/download code still reads.
  out.propertyName = row.property_name;
  return out;
}

async function listVouchers({ search, status, createdFrom, createdTo }) {
  const where = [];
  const values = [];
  if (search) {
    where.push('(LOWER(booking_id) LIKE LOWER(?) OR LOWER(member_id) LIKE LOWER(?) OR LOWER(client) LIKE LOWER(?) OR LOWER(property_name) LIKE LOWER(?))');
    values.push(...[search, search, search, search].map((x) => `%${x}%`));
  }
  if (status && status !== 'All') { where.push('status = ?'); values.push(status); }
  if (createdFrom) { where.push('DATE(created_at) >= ?'); values.push(createdFrom); }
  if (createdTo) { where.push('DATE(created_at) <= ?'); values.push(createdTo); }
  const result = await pool.query(
    `SELECT ${COLUMNS} FROM vouchers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
    values
  );
  return result.rows.map(publicVoucher);
}

async function findVoucher(id) {
  const result = await pool.query(`SELECT ${COLUMNS} FROM vouchers WHERE id = ?`, [id]);
  return result.rows[0] ? publicVoucher(result.rows[0]) : null;
}

async function createVoucher(data) {
  const id = randomUUID();
  const cols = FIELDS.map(([, col]) => col);
  const values = FIELDS.map(([key, , kind]) => toDbValue(data[key], kind));
  await pool.query(
    `INSERT INTO vouchers (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
    [id, ...values]
  );
  return findVoucher(id);
}

async function updateVoucher(id, data) {
  const sets = FIELDS.map(([, col]) => `${col} = ?`).join(', ');
  const values = FIELDS.map(([key, , kind]) => toDbValue(data[key], kind));
  await pool.query(`UPDATE vouchers SET ${sets} WHERE id = ?`, [...values, id]);
  return findVoucher(id);
}

async function deleteVoucher(id) {
  await pool.query('DELETE FROM vouchers WHERE id = ?', [id]);
}

module.exports = { listVouchers, findVoucher, createVoucher, updateVoucher, deleteVoucher, FIELDS };
