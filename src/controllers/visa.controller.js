const sharp = require('sharp');

const {
  createApplication,
  findApplicationForAgency,
  listApplicationsForAgency,
  listApplicants,
  syncApplicantNames,
  saveApplicantPhoto,
  saveApplicantPassportScan,
  saveApplicantPassportDetails,
  saveApplicantPassportBack,
  saveApplicantPassportScanResult,
  clearApplicantPassport,
  clearApplicantPhoto,
} = require('../models/visa.model.js');

const { listVisaPackages, findVisaPackageById } = require('../models/visaPackages.model.js');
const { getVisaPrice, getVisaPackagePrice } = require('../services/visaPricing.service.js');
const { getVisaHero } = require('../services/visaHero.service.js');
const { uploadBuffer, deleteImagesByUrl } = require('../services/cloudinary.service.js');
const { checkVisaPhoto } = require('../services/visaPhotoCheck.service.js');
const { scanPassport, validateDetails, PASSPORT_FIELDS } = require('../services/passportScan.service.js');
const { verifyBackPage, sameNumber } = require('../services/passportBackCheck.service.js');

// Agent "Apply for Visa" flow:
//   1. GET  /visa/types                  - active types, each with its active categories
//   2. POST /visa/applications           - type + category + member count -> draft
//   3. PUT  /visa/applications/:id/applicants - the members' names
//   4. POST /visa/applications/:id/applicants/:applicantId/photo - verified photo
// Every application handler re-checks agency ownership itself
// (findApplicationForAgency), never trusting the :id in the URL.

function toPublicApplicant(row) {
  return {
    id: row.id,
    reference: row.reference || `VISA-${String(row.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    position: row.position,
    fullName: row.full_name,
    photoUrl: row.photo_url,
    photoStatus: row.photo_status,
    photoSource: row.photo_source,
    photoCheck: row.photo_check
      ? {
          status: row.photo_check.status,
          checks: row.photo_check.checks,
          issues: row.photo_check.issues,
          clarity: row.photo_check.clarity,
          checkedAt: row.photo_check.checkedAt,
        }
      : null,
    passportFrontUrl: row.passport_front_url,
    passportBackUrl: row.passport_back_url,
    passportStatus: row.passport_status || 'pending',
    passportDetails: row.passport_details || null,
    passportScan: row.passport_scan
      ? {
          status: row.passport_scan.status,
          pages: row.passport_scan.pages,
          frontPageIndex: row.passport_scan.frontPageIndex,
          backPageIndex: row.passport_scan.backPageIndex,
          checks: row.passport_scan.checks,
          issues: row.passport_scan.issues,
          fieldWarnings: row.passport_scan.fieldWarnings,
          fieldSources: row.passport_scan.fieldSources,
          aiSkipped: !!row.passport_scan.ai?.skipped,
          scannedAt: row.passport_scan.scannedAt,
          // Back page vs front page passport number (passportBackCheck.service.js).
          backCheck: row.passport_scan.backCheck || null,
        }
      : null,
    // The issued visa (0128_visa_processing.sql) — uploaded by the admin,
    // downloadable by the agent. 'pending' until decided.
    visaStatus: row.visa_status || 'pending',
    visaDocumentUrl: row.visa_status === 'issued' ? row.visa_document_url : null,
    visaDocumentName: row.visa_status === 'issued' ? row.visa_document_name : null,
    visaDocumentType: row.visa_status === 'issued' ? row.visa_document_type : null,
    visaNumber: row.visa_status === 'issued' ? row.visa_number : null,
    visaValidUntil: row.visa_status === 'issued' ? ymd(row.visa_valid_until) : null,
    visaIssuedAt: row.visa_status === 'issued' ? row.visa_issued_at : null,
    visaRejectionReason: row.visa_status === 'rejected' ? row.visa_rejection_reason : null,
  };
}

// DATE column -> 'YYYY-MM-DD' (mysql2 hands DATEs back as JS Dates at local
// midnight, so format from the local parts, not toISOString()).
function ymd(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports.toPublicApplicant = toPublicApplicant;

// `pricePerPerson` is the single admin-set visa price (visaPricing.service.js),
// the same for every type/category.
// The package an application was made for, from the details copied onto it
// (0130) — null for older type/category applications.
function toApplicationPackage(row) {
  if (row.package_duration_days == null) return null;
  return {
    id: row.visa_package_id || null,
    durationDays: Number(row.package_duration_days),
    entryType: row.package_entry_type,
    validForDays: Number(row.package_valid_for_days),
    maxStayDays: Number(row.package_max_stay_days),
  };
}

module.exports.toApplicationPackage = toApplicationPackage;

function toPublicApplication(row, applicants, pricePerPerson = null, viewerId = null) {
  return {
    id: row.id,
    status: row.status,
    visaPackage: toApplicationPackage(row),
    // Display names — for package applications "30-day visa" + entry type.
    visaType: { id: row.visa_type_id, name: row.visa_type_name },
    visaCategory: {
      id: row.visa_category_id,
      name: row.visa_category_name,
      price: pricePerPerson,
      processingTime: row.visa_category_processing_time,
    },
    // The agent who applied (visa_applications.created_by_user_id → users).
    createdBy: { id: row.created_by_user_id, name: row.created_by_name || null, isMe: !!viewerId && row.created_by_user_id === viewerId },
    // Set once the visa fee is paid (visaPayment.service.js): status
    // 'submitted'; 'payment_review' while a NEFT slip awaits verification.
    paidAmount: row.paid_amount != null ? Number(row.paid_amount) : null,
    paidAt: row.paid_at || null,
    submittedAt: row.submitted_at || null,
    // Admin processing (0128): when work started / finished, and why a
    // rejected request was refused.
    processingStartedAt: row.processing_started_at || null,
    completedAt: row.completed_at || null,
    rejectionReason: row.status === 'rejected' ? row.rejection_reason || null : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(applicants
      ? { applicants: applicants.map(toPublicApplicant) }
      : {
          applicantCount: Number(row.applicant_count || 0),
          namesDone: Number(row.names_done || 0),
          photosDone: Number(row.photos_done || 0),
          passportsUploaded: Number(row.passports_uploaded || 0),
          passportsDone: Number(row.passports_done || 0),
          visasIssued: Number(row.visas_issued || 0),
          travellerNames: row.traveller_names ? String(row.traveller_names).split('|').filter(Boolean) : [],
        }),
  };
}

async function loadOwnedApplicationOr404(req, res) {
  const application = await findApplicationForAgency(req.params.id, req.user.agency_id, req.user.id);
  if (!application) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return application;
}

// Travellers, photos and passports can only change while the application is
// a draft. Once paid (or a NEFT slip is awaiting verification) the fee was
// charged per traveller, so the application is locked.
async function loadEditableApplicationOr404(req, res) {
  const application = await loadOwnedApplicationOr404(req, res);
  if (application && application.status !== 'draft') {
    res.status(409).json({
      error: 'application_locked',
      message:
        application.status === 'payment_review'
          ? 'Payment is being verified — the travellers can no longer be changed.'
          : 'This application has been submitted — the travellers can no longer be changed.',
    });
    return null;
  }
  return application;
}

module.exports.loadEditableApplicationOr404 = loadEditableApplicationOr404;

async function getTypesWithCategories(req, res, next) {
  try {
    const [packages, { pricePerPerson }, hero] = await Promise.all([
      listVisaPackages({ activeOnly: true }),
      getVisaPrice(),
      getVisaHero(),
    ]);
    res.json({
      pricePerPerson,
      // The Visa page hero image (admin Visa Setup), or null.
      heroImageUrl: hero.imageUrl,
      // Active Visa Packages (admin Visa Setup) — what agents apply for.
      packages: await Promise.all(packages.map(async (p) => ({
        id: p.id,
        durationDays: Number(p.duration_days),
        entryType: p.entry_type,
        validForDays: Number(p.valid_for_days),
        maxStayDays: Number(p.max_stay_days),
        imageUrl: p.image_url || null,
        pricePerPerson: await getVisaPackagePrice(p),
      }))),
    });
  } catch (err) {
    next(err);
  }
}

module.exports.getTypesWithCategories = getTypesWithCategories;

async function postApplication(req, res, next) {
  try {
    const { visaPackageId, members } = req.body;
    const visaPackage = await findVisaPackageById(visaPackageId);
    if (!visaPackage || !visaPackage.is_active) {
      return res.status(400).json({ error: 'invalid_package', message: 'That visa is no longer available — choose another.' });
    }
    const id = await createApplication({
      agencyId: req.user.agency_id,
      userId: req.user.id,
      visaPackage,
      members,
    });
    const application = await findApplicationForAgency(id, req.user.agency_id);
    res.status(201).json({ application: toPublicApplication(application, await listApplicants(id), await getVisaPackagePrice(visaPackage), req.user.id) });
  } catch (err) {
    next(err);
  }
}

module.exports.postApplication = postApplication;

async function getApplications(req, res, next) {
  try {
    const [rows, { pricePerPerson }] = await Promise.all([listApplicationsForAgency(req.user.agency_id, req.user.id), getVisaPrice()]);
    res.json({ applications: rows.map((row) => toPublicApplication(row, null, pricePerPerson, req.user.id)) });
  } catch (err) {
    next(err);
  }
}

module.exports.getApplications = getApplications;

async function getApplication(req, res, next) {
  try {
    const application = await loadOwnedApplicationOr404(req, res);
    if (!application) return;
    res.json({ application: toPublicApplication(application, await listApplicants(application.id), (await getVisaPrice()).pricePerPerson, req.user.id) });
  } catch (err) {
    next(err);
  }
}

module.exports.getApplication = getApplication;

async function putApplicants(req, res, next) {
  try {
    const application = await loadEditableApplicationOr404(req, res);
    if (!application) return;
    const before = await listApplicants(application.id);
    await syncApplicantNames(application.id, req.body.applicants);
    // Travellers removed from the list: delete their photo/passport files too.
    const keptIds = new Set((await listApplicants(application.id)).map((a) => a.id));
    removeReplacedImages(
      before.filter((a) => !keptIds.has(a.id)).flatMap((a) => [a.photo_url, a.passport_front_url, a.passport_back_url]),
      []
    );
    res.json({ application: toPublicApplication(application, await listApplicants(application.id), (await getVisaPrice()).pricePerPerson, req.user.id) });
  } catch (err) {
    next(err);
  }
}

module.exports.putApplicants = putApplicants;

function parseClientReport(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Checks a traveller's photo and, if it passes, stores it. Shared by the
// agent's own upload/scan (below) and "Scan with phone"
// (visaPhotoHandoff.controller.js). Sends the response itself; returns the
// saved applicant row, or null when the photo was refused.
async function checkAndSaveApplicantPhoto(req, res, { application, applicant }) {
  if (!applicant.full_name) {
    res.status(400).json({ error: 'missing_name', message: "Enter this member's name before adding a photo." });
    return null;
  }

  const photo = req.files?.photo?.[0];
  if (!photo || !photo.mimetype.startsWith('image/')) {
    res.status(400).json({ error: 'missing_file', message: 'Add a photo (JPG, PNG or WebP).' });
    return null;
  }

  const source = req.body.source === 'camera' ? 'camera' : 'upload';
  const result = await checkVisaPhoto({
    photoBuffer: photo.buffer,
    source,
    clientReport: parseClientReport(req.body.clientReport),
  });

  if (result.status === 'rejected') {
    res.status(422).json({
      error: 'photo_rejected',
      message: result.issues[0] || 'This photo did not pass the checks. Please retake it.',
      check: { status: result.status, checks: result.checks, issues: result.issues, clarity: result.clarity },
    });
    return null;
  }

  // Stored upright as a high-quality JPEG regardless of what the phone or
  // webcam produced (HEIC-ish orientation flags, PNG screenshots, ...).
  const normalized = await sharp(photo.buffer).rotate().jpeg({ quality: 92 }).toBuffer();
  const uploaded = await uploadBuffer(normalized, {
    folderParts: ['visa', 'applications', application.id, 'photos'],
    resourceType: 'image',
  });

  await saveApplicantPhoto(applicant.id, {
    photoUrl: uploaded.secure_url,
    photoStatus: result.status,
    photoCheck: result,
    photoSource: source,
  });
  // A retake replaces the photo — delete the old file too.
  removeReplacedImages([applicant.photo_url], [uploaded.secure_url]);

  const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
  res.status(201).json({ applicant: toPublicApplicant(updated) });
  return updated;
}

module.exports.checkAndSaveApplicantPhoto = checkAndSaveApplicantPhoto;

async function postApplicantPhoto(req, res, next) {
  try {
    const application = await loadEditableApplicationOr404(req, res);
    if (!application) return;

    const applicants = await listApplicants(application.id);
    const applicant = applicants.find((a) => a.id === req.params.applicantId);
    if (!applicant) return res.status(404).json({ error: 'not_found' });

    await checkAndSaveApplicantPhoto(req, res, { application, applicant });
  } catch (err) {
    next(err);
  }
}

module.exports.postApplicantPhoto = postApplicantPhoto;

// ---- Passports -----------------------------------------------------------

async function loadOwnedApplicantOr404(req, res) {
  const application = await loadEditableApplicationOr404(req, res);
  if (!application) return {};
  const applicants = await listApplicants(application.id);
  const applicant = applicants.find((a) => a.id === req.params.applicantId);
  if (!applicant) {
    res.status(404).json({ error: 'not_found' });
    return {};
  }
  return { application, applicant };
}

const PAGE_SLOTS = new Set(['front', 'back', 'document']);

function parsePageMeta(raw, count) {
  let meta = [];
  try {
    meta = JSON.parse(raw || '[]');
  } catch {
    meta = [];
  }
  return Array.from({ length: count }, (_, i) => ({
    slot: PAGE_SLOTS.has(meta[i]?.slot) ? meta[i].slot : 'document',
    label: String(meta[i]?.label || `Image ${i + 1}`).slice(0, 120),
  }));
}

async function uploadPassportPage(applicationId, buffer) {
  const jpeg = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
  const uploaded = await uploadBuffer(jpeg, {
    folderParts: ['visa', 'applications', applicationId, 'passports'],
    resourceType: 'image',
  });
  return uploaded.secure_url;
}

// pages = every page image the agent added (front slot, back slot, or a
// whole-passport PDF rendered to images in the browser), with `meta` (JSON
// array, same order) saying which slot each came from.
async function postPassportScan(req, res, next) {
  try {
    const { application, applicant } = await loadOwnedApplicantOr404(req, res);
    if (!applicant) return;
    if (!applicant.full_name) {
      return res.status(400).json({ error: 'missing_name', message: "Enter this traveller's name first." });
    }

    const files = req.files?.pages || [];
    if (!files.length) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload the front page of the passport.' });
    }
    if (files.some((f) => !f.mimetype.startsWith('image/'))) {
      return res.status(400).json({ error: 'invalid_file_type', message: 'Passport pages must be images (PDFs are split into pages first).' });
    }
    const meta = parsePageMeta(req.body.meta, files.length);
    if (!meta.some((m) => m.slot === 'front' || m.slot === 'document')) {
      return res.status(400).json({ error: 'missing_front', message: 'Upload the front page of the passport first.' });
    }

    const pages = files.map((f, i) => ({ buffer: f.buffer, ...meta[i] }));
    const result = await scanPassport(pages, { travellerName: applicant.full_name });
    console.log('[passportScan] front extraction', {
      applicantId: applicant.id,
      passportNumber: result.details?.passportNumber || null,
      frontPageIndex: result.frontPageIndex,
      backPageIndex: result.backPageIndex,
    });

    if (result.status === 'rejected') {
      return res.status(422).json({
        error: 'passport_rejected',
        message: result.issues[0] || "This doesn't look like a passport front page.",
        scan: { pages: result.pages, checks: result.checks, issues: result.issues },
      });
    }

    // A whole-passport file can include the back page: it's only kept when
    // the front's passport number is on it too (same rule as uploading the
    // back page on its own). Otherwise the agent uploads the back page next.
    let backCheck = null;
    if (result.backPageIndex >= 0 && result.backPageIndex !== result.frontPageIndex) {
      const number = result.details?.passportNumber;
      const check = number ? await verifyBackPage([pages[result.backPageIndex].buffer], { passportNumber: number }) : { matched: false };
      if (check.matched) {
        backCheck = { matched: true, passportNumber: number, method: check.method, checkedAt: new Date().toISOString() };
      } else {
        result.backPageIndex = -1;
        for (const f of BACK_FIELD_KEYS) result.details[f] = '';
        result.issues = ['The back page in this file does not show the same passport number — upload the back page separately.', ...(result.issues || [])];
      }
    } else if (result.backPageIndex >= 0) {
      // Front and back in one image (an open two-page spread): one passport.
      const number = result.details?.passportNumber;
      if (number) backCheck = { matched: true, passportNumber: number, method: 'same_image', checkedAt: new Date().toISOString() };
    }

    const frontUrl = await uploadPassportPage(application.id, pages[result.frontPageIndex].buffer);
    const backUrl =
      result.backPageIndex < 0
        ? null
        : result.backPageIndex === result.frontPageIndex
          ? frontUrl
          : await uploadPassportPage(application.id, pages[result.backPageIndex].buffer);

    const { details, ...scan } = result;
    console.log('[passportScan] saving extracted passport details', {
      applicantId: applicant.id,
      address: details?.address || null,
      placeOfBirth: details?.placeOfBirth || null,
      placeOfIssue: details?.placeOfIssue || null,
      backPageIndex: result.backPageIndex,
    });
    await saveApplicantPassportScan(applicant.id, {
      frontUrl,
      backUrl,
      status: result.status,
      scan: { ...scan, backCheck, scannedAt: new Date().toISOString() },
      details,
    });
    // A re-upload replaces the passport — delete the old page images too.
    removeReplacedImages([applicant.passport_front_url, applicant.passport_back_url], [frontUrl, backUrl]);

    const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
    res.status(201).json({ applicant: toPublicApplicant(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports.postPassportScan = postPassportScan;

const BACK_FIELD_KEYS = ['fatherName', 'motherName', 'spouseName', 'address', 'fileNumber', 'oldPassportNumber'];

// POST .../passport/back — the back (address) page, after the front. Saved
// only when the passport number read from the front page (or typed on the
// details page) is on it too; otherwise "Passport not matched" and nothing
// is stored, so the agent can't continue with a back page from another
// passport.
async function postPassportBack(req, res, next) {
  try {
    const { application, applicant } = await loadOwnedApplicantOr404(req, res);
    if (!applicant) return;
    if (!applicant.passport_front_url) {
      return res.status(400).json({ error: 'missing_front', message: 'Upload the front page of the passport first.' });
    }
    const passportNumber = applicant.passport_details?.passportNumber;
    console.log('[passportScan] back matching target', {
      applicantId: applicant.id,
      frontPassportNumber: passportNumber || null,
    });
    if (!passportNumber) {
      return res.status(400).json({
        error: 'missing_passport_number',
        message:
          "The passport number from the front page is needed to check the back page. Upload a clearer front page, or enter the passport number on the details page first.",
      });
    }

    const files = req.files?.pages || [];
    if (!files.length) {
      return res.status(400).json({ error: 'missing_file', message: 'Upload the back page of the passport.' });
    }
    if (files.some((f) => !f.mimetype.startsWith('image/'))) {
      return res.status(400).json({ error: 'invalid_file_type', message: 'Passport pages must be images (PDFs are split into pages first).' });
    }

    const check = await verifyBackPage(
      files.map((f) => f.buffer),
      { passportNumber }
    );
    console.log('[passportScan] back extraction result', {
      applicantId: applicant.id,
      frontPassportNumber: passportNumber,
      matched: check.matched,
      method: check.method,
      foundNumbers: check.foundNumbers,
      barcodes: check.barcodes,
      aiPassportNumber: check.aiPassportNumber || null,
    });
    if (!check.matched) {
      // Name the other number only when it's unambiguous (the page may also
      // show the OLD passport number).
      const other = check.foundNumbers.length === 1 ? check.foundNumbers[0] : null;
      return res.status(422).json({
        error: 'passport_mismatch',
        message: other
          ? `Passport not matched — this back page shows passport number ${other}, but the front page is ${passportNumber}. Upload the back page of the same passport.`
          : `Passport not matched — passport number ${passportNumber} from the front page wasn't found on this page. Upload the back page of the same passport, flat, in focus and without glare.`,
        backCheck: { matched: false, passportNumber, foundNumbers: check.foundNumbers, barcodes: check.barcodes, isAddressPage: check.isAddressPage },
      });
    }

    const backUrl = await uploadPassportPage(application.id, files[check.pageIndex].buffer);
    const previousScan = applicant.passport_scan || {};
    const backCheck = {
      matched: true,
      passportNumber,
      method: check.method,
      barcode: check.barcodes[0] || null,
      checkedAt: new Date().toISOString(),
    };
    const checks = (previousScan.checks || []).filter((c) => !['back_page_found', 'back_matches_front'].includes(c.key));
    checks.push(
      { key: 'back_page_found', label: 'Passport back page found', passed: true, severity: 'warning', detail: 'Uploaded separately' },
      { key: 'back_matches_front', label: 'Back page matches the front (passport number)', passed: true, severity: 'error', detail: passportNumber }
    );
    const scan = {
      ...previousScan,
      checks,
      issues: (previousScan.issues || []).filter((i) => !/back page|back \(address\)/i.test(i)),
      backCheck,
      backScannedAt: new Date().toISOString(),
    };
    // Address-page details read by the AI fill the empty back fields; what
    // the agent already typed stays.
    const details = { ...(applicant.passport_details || {}) };
    if (check.backDetails) {
      for (const f of BACK_FIELD_KEYS) if (!details[f] && check.backDetails[f]) details[f] = check.backDetails[f];
    }

    await saveApplicantPassportBack(applicant.id, { backUrl, scan, details });
    // Replacing the back page — delete the old image (never the front's).
    removeReplacedImages([applicant.passport_back_url !== applicant.passport_front_url ? applicant.passport_back_url : null], [backUrl]);

    const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
    res.status(201).json({ applicant: toPublicApplicant(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports.postPassportBack = postPassportBack;

// Errors that make the passport unusable for any visa — saving is refused.
// Short validity (< 6 months) is allowed through but stays flagged.
const BLOCKING_CHECKS = new Set(['not_expired', 'issue_before_expiry', 'birth_in_past']);

function titleCase(value) {
  return value.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());
}

async function putPassportDetails(req, res, next) {
  try {
    const { application, applicant } = await loadOwnedApplicantOr404(req, res);
    if (!applicant) return;
    if (!applicant.passport_front_url) {
      return res.status(400).json({ error: 'missing_passport', message: 'Upload the passport before saving its details.' });
    }

    const details = Object.fromEntries(PASSPORT_FIELDS.map((f) => [f, req.body.details[f] ?? '']));
    const fullName = req.body.useNameFromPassport
      ? titleCase(`${details.givenNames} ${details.surname}`.replace(/\s+/g, ' ').trim())
      : null;
    const { checks } = validateDetails(details, { travellerName: fullName || applicant.full_name });

    const blocking = checks.find((c) => !c.passed && BLOCKING_CHECKS.has(c.key));
    if (blocking) {
      return res.status(422).json({ error: 'invalid_passport', message: `${blocking.label}: ${blocking.detail}`, checks });
    }

    await saveApplicantPassportDetails(applicant.id, { details, status: 'confirmed', fullName });
    // The back page was matched to the old number — a different number means
    // it has to be matched again (upload the back page once more).
    const backCheck = applicant.passport_scan?.backCheck;
    if (backCheck?.matched && !sameNumber(details.passportNumber, backCheck.passportNumber)) {
      await saveApplicantPassportScanResult(applicant.id, {
        ...applicant.passport_scan,
        backCheck: { matched: false, passportNumber: details.passportNumber, reason: 'number_changed', checkedAt: new Date().toISOString() },
      });
    }
    const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
    res.json({ applicant: toPublicApplicant(updated), checks });
  } catch (err) {
    next(err);
  }
}

module.exports.putPassportDetails = putPassportDetails;

// ---- Removing images -----------------------------------------------------

// After a replacement is saved: best-effort delete of the previous files
// (the new ones are already in place, so a Cloudinary hiccup only leaves an
// orphaned file behind — logged, never fails the request).
function removeReplacedImages(oldUrls, newUrls) {
  const stale = oldUrls.filter((u) => u && !newUrls.includes(u));
  if (!stale.length) return;
  deleteImagesByUrl(stale).catch((err) => console.error('[visa] could not delete replaced images:', err.message));
}

// DELETE .../passport — removes the passport page images from Cloudinary
// (and the CDN cache), then the stored scan + extracted details. Cloudinary
// goes first: if it fails nothing is cleared, so the agent can simply retry.
async function deletePassport(req, res, next) {
  try {
    const { application, applicant } = await loadOwnedApplicantOr404(req, res);
    if (!applicant) return;
    if (!applicant.passport_front_url && !applicant.passport_back_url && !applicant.passport_details) {
      return res.status(404).json({ error: 'no_passport', message: 'There is no passport to remove.' });
    }
    await deleteImagesByUrl([applicant.passport_front_url, applicant.passport_back_url]);
    await clearApplicantPassport(applicant.id);
    const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
    res.json({ applicant: toPublicApplicant(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports.deletePassport = deletePassport;

// DELETE .../photo — same for the traveller's visa photo.
async function deletePhoto(req, res, next) {
  try {
    const { application, applicant } = await loadOwnedApplicantOr404(req, res);
    if (!applicant) return;
    if (!applicant.photo_url) {
      return res.status(404).json({ error: 'no_photo', message: 'There is no photo to remove.' });
    }
    await deleteImagesByUrl([applicant.photo_url]);
    await clearApplicantPhoto(applicant.id);
    const updated = (await listApplicants(application.id)).find((a) => a.id === applicant.id);
    res.json({ applicant: toPublicApplicant(updated) });
  } catch (err) {
    next(err);
  }
}

module.exports.deletePhoto = deletePhoto;
