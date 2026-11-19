const { pool } = require('../db/pool.js');
const { newId } = require('../utils/id.js');

// Visa System (0125_visa_system.sql). Types/categories are admin-managed;
// applications/applicants belong to one agency and are only ever read or
// written through an agency-scoped lookup (findApplicationForAgency).

// Display names for an application. Older applications have a visa
// type/category; ones made since Visa Packages (0130) have NULLs there and a
// copy of the package's details, shown as "30-day visa" + "Single-Entry".
// Every SELECT that names an application's visa uses this, with LEFT JOINs
// on visa_types / visa_categories.
function visaLabelSql(app = 'va', type = 'vt', category = 'vc') {
  return `COALESCE(${type}.name, CONCAT(${app}.package_duration_days, '-day visa')) AS visa_type_name,
         COALESCE(${category}.name, ${app}.package_entry_type) AS visa_category_name`;
}

module.exports.visaLabelSql = visaLabelSql;

// ---- Types ---------------------------------------------------------------

async function listVisaTypes({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM visa_types ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, name`
  );
  return rows;
}

module.exports.listVisaTypes = listVisaTypes;

async function findVisaTypeById(id) {
  const { rows } = await pool.query('SELECT * FROM visa_types WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findVisaTypeById = findVisaTypeById;

async function createVisaType({ name, description, isActive = true, sortOrder = 0 }) {
  const id = newId();
  await pool.query(
    'INSERT INTO visa_types (id, name, description, is_active, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, name, description || null, isActive ? 1 : 0, sortOrder]
  );
  return findVisaTypeById(id);
}

module.exports.createVisaType = createVisaType;

async function updateVisaType(id, { name, description, isActive, sortOrder }) {
  await pool.query(
    `UPDATE visa_types
     SET name = COALESCE(?, name),
         description = CASE WHEN ? THEN ? ELSE description END,
         is_active = COALESCE(?, is_active),
         sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [
      name ?? null,
      description !== undefined,
      description || null,
      isActive === undefined ? null : isActive ? 1 : 0,
      sortOrder ?? null,
      id,
    ]
  );
  return findVisaTypeById(id);
}

module.exports.updateVisaType = updateVisaType;

async function deleteVisaType(id) {
  const { rowCount } = await pool.query('DELETE FROM visa_types WHERE id = ?', [id]);
  return rowCount > 0;
}

module.exports.deleteVisaType = deleteVisaType;

// ---- Categories ----------------------------------------------------------

async function listVisaCategories({ typeId, activeOnly = false } = {}) {
  const clauses = [];
  const values = [];
  if (typeId) {
    clauses.push('visa_type_id = ?');
    values.push(typeId);
  }
  if (activeOnly) clauses.push('is_active = 1');
  const { rows } = await pool.query(
    `SELECT * FROM visa_categories ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY sort_order, name`,
    values
  );
  return rows;
}

module.exports.listVisaCategories = listVisaCategories;

async function findVisaCategoryById(id) {
  const { rows } = await pool.query('SELECT * FROM visa_categories WHERE id = ?', [id]);
  return rows[0] || null;
}

module.exports.findVisaCategoryById = findVisaCategoryById;

async function createVisaCategory({ visaTypeId, name, description, price, processingTime, isActive = true, sortOrder = 0 }) {
  const id = newId();
  await pool.query(
    `INSERT INTO visa_categories (id, visa_type_id, name, description, price, processing_time, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, visaTypeId, name, description || null, price ?? null, processingTime || null, isActive ? 1 : 0, sortOrder]
  );
  return findVisaCategoryById(id);
}

module.exports.createVisaCategory = createVisaCategory;

async function updateVisaCategory(id, { visaTypeId, name, description, price, processingTime, isActive, sortOrder }) {
  await pool.query(
    `UPDATE visa_categories
     SET visa_type_id = COALESCE(?, visa_type_id),
         name = COALESCE(?, name),
         description = CASE WHEN ? THEN ? ELSE description END,
         price = CASE WHEN ? THEN ? ELSE price END,
         processing_time = CASE WHEN ? THEN ? ELSE processing_time END,
         is_active = COALESCE(?, is_active),
         sort_order = COALESCE(?, sort_order)
     WHERE id = ?`,
    [
      visaTypeId ?? null,
      name ?? null,
      description !== undefined,
      description || null,
      price !== undefined,
      price ?? null,
      processingTime !== undefined,
      processingTime || null,
      isActive === undefined ? null : isActive ? 1 : 0,
      sortOrder ?? null,
      id,
    ]
  );
  return findVisaCategoryById(id);
}

module.exports.updateVisaCategory = updateVisaCategory;

async function deleteVisaCategory(id) {
  const { rowCount } = await pool.query('DELETE FROM visa_categories WHERE id = ?', [id]);
  return rowCount > 0;
}

module.exports.deleteVisaCategory = deleteVisaCategory;

// A type/category already used by an application can't be deleted (FK) —
// it's deactivated instead so existing applications keep their labels.
async function isVisaTypeInUse(id) {
  const { rows } = await pool.query('SELECT 1 FROM visa_applications WHERE visa_type_id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

module.exports.isVisaTypeInUse = isVisaTypeInUse;

async function isVisaCategoryInUse(id) {
  const { rows } = await pool.query('SELECT 1 FROM visa_applications WHERE visa_category_id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

module.exports.isVisaCategoryInUse = isVisaCategoryInUse;

// ---- Applications --------------------------------------------------------

// `visaPackage` is the visa_packages row the agent chose; its details are
// copied onto the application (see 0130_visa_applications_packages.sql).
async function createApplication({ agencyId, userId, visaPackage, members }) {
  const id = newId();
  const reference = `VISA-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO visa_applications
         (id, reference, agency_id, created_by_user_id, visa_package_id,
          package_duration_days, package_entry_type, package_valid_for_days, package_max_stay_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        reference,
        agencyId,
        userId,
        visaPackage.id,
        visaPackage.duration_days,
        visaPackage.entry_type,
        visaPackage.valid_for_days,
        visaPackage.max_stay_days,
      ]
    );
    for (let position = 1; position <= members; position += 1) {
      await client.query('INSERT INTO visa_applicants (id, application_id, position) VALUES (?, ?, ?)', [
        newId(),
        id,
        position,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return id;
}

module.exports.createApplication = createApplication;

// created_by_user_id is a foreign key to users — the agent (owner or staff)
// who started the application; their name comes along for "Applied by".
const APPLICATION_SELECT = `
  SELECT visa_applications.*,
         ${visaLabelSql('visa_applications', 'visa_types', 'visa_categories')},
         visa_categories.price AS visa_category_price,
         visa_categories.processing_time AS visa_category_processing_time,
         users.full_name AS created_by_name
  FROM visa_applications
  LEFT JOIN visa_types ON visa_types.id = visa_applications.visa_type_id
  LEFT JOIN visa_categories ON visa_categories.id = visa_applications.visa_category_id
  LEFT JOIN users ON users.id = visa_applications.created_by_user_id`;

async function findApplicationForAgency(id, agencyId, createdByUserId = null) {
  const params = [id, agencyId];
  let ownerClause = '';
  if (createdByUserId) {
    ownerClause = ' AND visa_applications.created_by_user_id = ?';
    params.push(createdByUserId);
  }
  const { rows } = await pool.query(`${APPLICATION_SELECT} WHERE visa_applications.id = ? AND visa_applications.agency_id = ?${ownerClause}`, params);
  return rows[0] || null;
}

module.exports.findApplicationForAgency = findApplicationForAgency;

// Every application of the agency (all its agents), newest first, with
// progress counts per step and the traveller names (for the list's search).
async function listApplicationsForAgency(agencyId, createdByUserId = null) {
  const ownerClause = createdByUserId ? ' AND visa_applications.created_by_user_id = ?' : '';
  const params = createdByUserId ? [agencyId, createdByUserId] : [agencyId];
  const { rows } = await pool.query(
    `SELECT a.*, COUNT(p.id) AS applicant_count,
            SUM(p.full_name IS NOT NULL AND p.full_name <> '') AS names_done,
            SUM(p.photo_status <> 'pending') AS photos_done,
            SUM(p.passport_status <> 'pending') AS passports_uploaded,
            SUM(p.passport_status = 'confirmed') AS passports_done,
            SUM(p.visa_status = 'issued') AS visas_issued,
            GROUP_CONCAT(p.full_name ORDER BY p.position SEPARATOR '|') AS traveller_names
     FROM (${APPLICATION_SELECT} WHERE visa_applications.agency_id = ?${ownerClause}) a
     LEFT JOIN visa_applicants p ON p.application_id = a.id
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
    params
  );
  return rows;
}

module.exports.listApplicationsForAgency = listApplicationsForAgency;

async function listApplicants(applicationId) {
  const { rows } = await pool.query('SELECT * FROM visa_applicants WHERE application_id = ? ORDER BY position', [
    applicationId,
  ]);
  return rows;
}

module.exports.listApplicants = listApplicants;

// Names page: the submitted list is the new truth — existing rows (by id)
// are renamed and re-ordered, new entries are added, rows left out are
// removed (along with any photo they had).
async function syncApplicantNames(applicationId, applicants) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT id FROM visa_applicants WHERE application_id = ? FOR UPDATE', [
      applicationId,
    ]);
    const existingIds = new Set(existing.map((r) => r.id));
    const keptIds = new Set();

    for (const [index, applicant] of applicants.entries()) {
      const position = index + 1;
      if (applicant.id && existingIds.has(applicant.id)) {
        keptIds.add(applicant.id);
        await client.query('UPDATE visa_applicants SET full_name = ?, position = ? WHERE id = ?', [
          applicant.fullName,
          position,
          applicant.id,
        ]);
      } else {
        await client.query('INSERT INTO visa_applicants (id, application_id, position, full_name) VALUES (?, ?, ?, ?)', [
          newId(),
          applicationId,
          position,
          applicant.fullName,
        ]);
      }
    }
    for (const id of existingIds) {
      if (!keptIds.has(id)) await client.query('DELETE FROM visa_applicants WHERE id = ?', [id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports.syncApplicantNames = syncApplicantNames;

async function saveApplicantPhoto(applicantId, { photoUrl, photoStatus, photoCheck, photoSource }) {
  await pool.query(
    `UPDATE visa_applicants SET photo_url = ?, photo_status = ?, photo_check = ?, photo_source = ? WHERE id = ?`,
    [photoUrl, photoStatus, JSON.stringify(photoCheck), photoSource, applicantId]
  );
}

module.exports.saveApplicantPhoto = saveApplicantPhoto;

async function saveApplicantPassportScan(applicantId, { frontUrl, backUrl, status, scan, details }) {
  await pool.query(
    `UPDATE visa_applicants
     SET passport_front_url = ?, passport_back_url = ?, passport_status = ?, passport_scan = ?, passport_details = ?
     WHERE id = ?`,
    [frontUrl, backUrl, status, JSON.stringify(scan), JSON.stringify(details), applicantId]
  );
}

module.exports.saveApplicantPassportScan = saveApplicantPassportScan;

async function saveApplicantPassportDetails(applicantId, { details, status, fullName }) {
  await pool.query(
    `UPDATE visa_applicants
     SET passport_details = ?, passport_status = ?, full_name = COALESCE(?, full_name)
     WHERE id = ?`,
    [JSON.stringify(details), status, fullName || null, applicantId]
  );
}

module.exports.saveApplicantPassportDetails = saveApplicantPassportDetails;

// The back page, once its passport number matched the front page's.
async function saveApplicantPassportBack(applicantId, { backUrl, scan, details }) {
  await pool.query(
    `UPDATE visa_applicants SET passport_back_url = ?, passport_scan = ?, passport_details = ? WHERE id = ?`,
    [backUrl, JSON.stringify(scan), JSON.stringify(details), applicantId]
  );
}

module.exports.saveApplicantPassportBack = saveApplicantPassportBack;

async function saveApplicantPassportScanResult(applicantId, scan) {
  await pool.query(`UPDATE visa_applicants SET passport_scan = ? WHERE id = ?`, [JSON.stringify(scan), applicantId]);
}

module.exports.saveApplicantPassportScanResult = saveApplicantPassportScanResult;

// Removes the passport entirely: images, scan result and extracted details
// (the Cloudinary files are deleted by the controller first).
async function clearApplicantPassport(applicantId) {
  await pool.query(
    `UPDATE visa_applicants
     SET passport_front_url = NULL, passport_back_url = NULL, passport_status = 'pending',
         passport_scan = NULL, passport_details = NULL
     WHERE id = ?`,
    [applicantId]
  );
}

module.exports.clearApplicantPassport = clearApplicantPassport;

async function clearApplicantPhoto(applicantId) {
  await pool.query(
    `UPDATE visa_applicants
     SET photo_url = NULL, photo_status = 'pending', photo_check = NULL, photo_source = NULL
     WHERE id = ?`,
    [applicantId]
  );
}

module.exports.clearApplicantPhoto = clearApplicantPhoto;
