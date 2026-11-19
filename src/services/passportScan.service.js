const { generateJson, isAiConfigured, toGeminiImagePart } = require('./gemini.service.js');
const { parseMrz } = require('./mrz.service.js');
const { readMrz } = require('./mrzOcr.service.js');

// Passport reading for the visa flow. The agent uploads the front (data)
// page, the back (address) page, or the whole passport (multi-page PDF —
// rendered to page images in the browser — or one photo of a two-page
// spread). Two readers run side by side:
//   1. MRZ OCR (mrzOcr.service.js, on-server, no key needed): finds the two
//      code lines on the photo page and reads them, verified by the ICAO
//      check digits. A verified MRZ is the source of truth for surname,
//      given names, passport number, nationality, date of birth, sex,
//      expiry and issuing country — and marks which page is the data page.
//   2. Gemini (when GEMINI_API_KEY is set): classifies every page, and
//      reads what the MRZ doesn't carry — place of birth/issue, date of
//      issue, and the back (address) page.
// Then deterministic checks run on the combined reading:
//   - MRZ check digits (mrz.service.js) — catches a misread number/date
//   - printed fields vs the MRZ
//   - expiry >= 6 months from today (standard visa requirement)
//   - passport name vs the traveller name the agent typed
//
// Status: scanned (all hard checks passed) | needs_review (a hard check
// failed, or no AI available — the agent fills/fixes details by hand)
// | rejected (no passport data page found at all — nothing is saved).

const MIN_VALIDITY_MONTHS = 6;

const FRONT_FIELDS = [
  'documentType',
  'issuingCountry',
  'passportNumber',
  'surname',
  'givenNames',
  'nationality',
  'sex',
  'dateOfBirth',
  'placeOfBirth',
  'placeOfIssue',
  'dateOfIssue',
  'dateOfExpiry',
];
const BACK_FIELDS = ['fatherName', 'motherName', 'spouseName', 'address', 'fileNumber', 'oldPassportNumber'];
const DATE_FIELDS = new Set(['dateOfBirth', 'dateOfIssue', 'dateOfExpiry']);

module.exports.PASSPORT_FIELDS = [...FRONT_FIELDS, ...BACK_FIELDS];

const str = { type: 'STRING' };
const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isPassport: { type: 'BOOLEAN' },
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          type: { type: 'STRING', enum: ['data_page', 'address_page', 'data_and_address', 'cover', 'visa_or_blank', 'other'] },
          legible: { type: 'BOOLEAN' },
        },
        required: ['index', 'type', 'legible'],
      },
    },
    frontPageIndex: { type: 'INTEGER' },
    backPageIndex: { type: 'INTEGER' },
    sameDocument: { type: 'BOOLEAN' },
    front: {
      type: 'OBJECT',
      properties: { ...Object.fromEntries(FRONT_FIELDS.map((f) => [f, str])), mrzLine1: str, mrzLine2: str },
      required: FRONT_FIELDS,
    },
    back: { type: 'OBJECT', properties: Object.fromEntries(BACK_FIELDS.map((f) => [f, str])), required: BACK_FIELDS },
    issues: { type: 'ARRAY', items: str },
  },
  required: ['isPassport', 'pages', 'frontPageIndex', 'backPageIndex', 'sameDocument', 'front', 'back', 'issues'],
};

// MRZ nationality codes → the wording printed on passports, for the most
// common travellers; anything else keeps the 3-letter code.
const NATIONALITY = {
  IND: 'INDIAN', OMN: 'OMANI', PAK: 'PAKISTANI', BGD: 'BANGLADESHI', LKA: 'SRI LANKAN', NPL: 'NEPALESE',
  PHL: 'FILIPINO', ARE: 'EMIRATI', SAU: 'SAUDI', QAT: 'QATARI', KWT: 'KUWAITI', BHR: 'BAHRAINI',
  EGY: 'EGYPTIAN', JOR: 'JORDANIAN', GBR: 'BRITISH', USA: 'AMERICAN', CAN: 'CANADIAN', AUS: 'AUSTRALIAN',
  DEU: 'GERMAN', FRA: 'FRENCH', ITA: 'ITALIAN', CHN: 'CHINESE', IDN: 'INDONESIAN', MYS: 'MALAYSIAN',
};

function scoreOf(parsed) {
  return parsed ? Object.values(parsed.checks).filter(Boolean).length : -1;
}

// The passport number, date of birth and expiry each passed their own check
// digit. Those are the details that matter; the two remaining digits
// (personal number, whole-line composite) are often misread on a phone
// photo, and failing only those must not throw a good reading away.
function coreVerified(parsed) {
  return !!parsed && parsed.checks.number && parsed.checks.dateOfBirth && parsed.checks.dateOfExpiry;
}

// An OCR reading good enough to fill the form from.
function usableOcr(ocrMrz) {
  return !!ocrMrz && (ocrMrz.score >= 4 || coreVerified(ocrMrz.parsed));
}

function swapDayMonth(iso) {
  const [y, m, d] = iso.split('-');
  return normaliseDate(`${y}-${d}-${m}`);
}

function yearsBetween(a, b) {
  return (new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / (365.25 * 86400000);
}

// Issue dates are printed DD/MM/YYYY on most passports and are sometimes
// read month-first. Passports run 5 or 10 years (expiry = issue + N years
// − 1 day), so when only the day/month-swapped reading fits that, use it.
function fixIssueDate(details, fieldWarnings) {
  const { dateOfIssue: issue, dateOfExpiry: expiry } = details;
  if (!issue || !expiry) return;
  const swapped = swapDayMonth(issue);
  if (!swapped || swapped === issue) return;
  const fits = (d) => {
    const y = yearsBetween(d, expiry);
    return [5, 10].some((n) => Math.abs(y - n) < 0.02);
  };
  if ((issue >= expiry && swapped < expiry) || (!fits(issue) && fits(swapped))) {
    details.dateOfIssue = swapped;
    fieldWarnings.dateOfIssue = `Read as ${issue}; corrected to ${swapped} (day and month were swapped) — please confirm`;
  }
}

function buildPrompt(pages) {
  return [
    'You are reading passport scans for a visa application. The images that follow are numbered pages:',
    'Return one valid JSON object only. Do not include markdown, commentary, or code fences.',
    ...pages.map((p, i) => `  Page ${i}: ${p.label}`),
    '',
    'Tasks:',
    '1. Classify every page: "data_page" = the biographical page with the photo and the 2-line MRZ; "address_page" = the page with address / father / mother / spouse names / file number (in Indian passports this is the last page); "data_and_address" = one image showing both of those pages; "cover", "visa_or_blank", or "other".',
    '2. frontPageIndex = the page index of the data page (-1 if none). backPageIndex = the page index of the address page (-1 if none). If one image shows both, use its index for both.',
    '3. isPassport = the images are a genuine passport (not an ID card, visa, or unrelated document). sameDocument = the address page belongs to the same passport as the data page (false if they clearly belong to different people/passports; true if there is no address page).',
    '4. Extract the data page into "front" and the address page into "back", exactly as printed. On the address page, carefully read the complete address line-by-line and copy it into back.address, preserving house numbers, street/locality, city, state and PIN/postal code. Also extract fatherName, motherName, spouseName, fileNumber and oldPassportNumber when visibly printed. Do not substitute the barcode number for fileNumber and do not invent missing text. Dates as YYYY-MM-DD — most passports print dates day first (DD/MM/YYYY, e.g. 21/07/2023 = 2023-07-21); never read them month first. Carefully read placeOfBirth and placeOfIssue from the printed labels "Place of Birth" and "Place of Issue"; these are not nationality or issuing country. Use "" only when a field is genuinely not visible or unreadable — never guess. sex as M, F or X. Names in UPPERCASE as printed; givenNames is everything printed under "Given Name(s)". mrzLine1/mrzLine2 = the two MRZ lines character for character, using < for fillers (44 characters each).',
    '5. issues = short plain-English problems for the agent: blurry/cut-off/glare pages, missing pages, a page upside down, a non-passport document, etc. Empty if none.',
  ].join('\n');
}

function normaliseDate(value) {
  const v = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '' : v;
}

function clean(field, value) {
  if (DATE_FIELDS.has(field)) return normaliseDate(value);
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (field === 'sex') return ['M', 'F', 'X'].includes(v.toUpperCase()[0]) ? v.toUpperCase()[0] : '';
  if (field === 'passportNumber') return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return v;
}

function nameTokens(name) {
  return String(name || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// The traveller name typed by the agent matches when every passport name
// part appears in it or vice versa (order-insensitive — agents often type
// "given surname" while the passport shows surname first).
function namesMatch(travellerName, surname, givenNames) {
  const typed = new Set(nameTokens(travellerName));
  const passport = nameTokens(`${givenNames} ${surname}`);
  if (!typed.size || !passport.length) return null;
  return passport.every((t) => typed.has(t)) || [...typed].every((t) => passport.includes(t));
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function check(key, label, passed, severity, detail) {
  return { key, label, passed: !!passed, severity, detail: detail || null };
}

/**
 * Runs the rule checks on extracted details. Also used when the agent
 * saves edited details (re-validated server-side, never trusted).
 */
function validateDetails(details, { travellerName, today = new Date() } = {}) {
  const checks = [];
  const fieldWarnings = {};

  const expiry = details.dateOfExpiry ? new Date(`${details.dateOfExpiry}T00:00:00Z`) : null;
  if (expiry) {
    const expired = expiry <= today;
    const minValid = addMonths(today, MIN_VALIDITY_MONTHS);
    checks.push(check('not_expired', 'Passport not expired', !expired, 'error', expired ? `Expired on ${details.dateOfExpiry}` : null));
    if (!expired) {
      checks.push(
        check(
          'six_months_validity',
          `Valid for ${MIN_VALIDITY_MONTHS}+ months`,
          expiry >= minValid,
          'error',
          expiry >= minValid ? null : `Expires ${details.dateOfExpiry} — most countries refuse a visa when less than ${MIN_VALIDITY_MONTHS} months remain`
        )
      );
    }
    if (expiry < minValid) fieldWarnings.dateOfExpiry = expiry <= today ? 'Passport has expired' : `Less than ${MIN_VALIDITY_MONTHS} months validity left`;
  }

  if (details.dateOfIssue && details.dateOfExpiry && details.dateOfIssue >= details.dateOfExpiry) {
    checks.push(check('issue_before_expiry', 'Issue date before expiry', false, 'error', 'Date of issue is on/after the expiry date'));
    fieldWarnings.dateOfIssue = 'Must be before the expiry date';
  }
  if (details.dateOfBirth && new Date(`${details.dateOfBirth}T00:00:00Z`) > today) {
    checks.push(check('birth_in_past', 'Date of birth valid', false, 'error', 'Date of birth is in the future'));
    fieldWarnings.dateOfBirth = 'Date of birth is in the future';
  }

  const match = namesMatch(travellerName, details.surname, details.givenNames);
  if (match !== null) {
    checks.push(
      check(
        'name_match',
        'Name matches traveller',
        match,
        'warning',
        match ? null : `Passport: ${[details.givenNames, details.surname].filter(Boolean).join(' ')} · Entered: ${travellerName}`
      )
    );
    if (!match) {
      fieldWarnings.surname = 'Differs from the traveller name entered';
      fieldWarnings.givenNames = 'Differs from the traveller name entered';
    }
  }

  return { checks, fieldWarnings };
}

module.exports.validateDetails = validateDetails;

// Pure post-processing of the readers' answers — kept separate so it can be
// tested without calling Gemini or the OCR. `ocrMrz` = the MRZ OCR result
// ({ pageIndex, line1, line2, parsed, score }) or null.
function buildScanResult(ai, pages, { travellerName, today = new Date(), ocrMrz = null } = {}) {
  const pageCount = pages.length;
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < pageCount;
  // A check-digit-verified MRZ found by OCR pins the data page.
  const ocrPinned = usableOcr(ocrMrz) && inRange(ocrMrz.pageIndex);
  let frontPageIndex = ocrPinned ? ocrMrz.pageIndex : inRange(ai.frontPageIndex) ? ai.frontPageIndex : -1;
  let backPageIndex = inRange(ai.backPageIndex) ? ai.backPageIndex : -1;
  // If the AI took the MRZ page for the address page (and there's no
  // separate one), that page is the data page, not the back.
  if (ocrPinned && backPageIndex === frontPageIndex && !['data_and_address'].includes((ai.pages || []).find((x) => x.index === backPageIndex)?.type)) {
    backPageIndex = -1;
  }
  // When the agent uploaded a separate back slot, prefer that page if the AI
  // mistakenly classified the front page as the address page. This keeps the
  // address fields extracted by the AI instead of discarding them because of
  // an incorrect page index.
  const uploadedBackIndex = pages.findIndex((page) => page.slot === 'back');
  if (uploadedBackIndex >= 0 && uploadedBackIndex !== frontPageIndex && (backPageIndex < 0 || backPageIndex === frontPageIndex)) {
    backPageIndex = uploadedBackIndex;
  }
  const pageInfo = pages.map((p, i) => {
    const found = (ai.pages || []).find((x) => x.index === i) || {};
    const type = ocrPinned && i === frontPageIndex && !['data_page', 'data_and_address'].includes(found.type) ? 'data_page' : found.type || 'other';
    return { index: i, label: p.label, slot: p.slot, type, legible: found.legible !== false };
  });
  const isPassport = ai.isPassport || ocrPinned;

  if (!isPassport || frontPageIndex < 0) {
    return {
      status: 'rejected',
      frontPageIndex,
      backPageIndex,
      pages: pageInfo,
      issues: ai.issues?.length
        ? ai.issues
        : [isPassport ? "The passport's front (photo) page wasn't found. Upload the page with the photo and the two code lines at the bottom." : "This doesn't look like a passport."],
      checks: [check('data_page_found', 'Passport front page found', false, 'error')],
    };
  }

  const details = {};
  for (const f of FRONT_FIELDS) details[f] = clean(f, ai.front?.[f]);
  // Keep readable address-page fields returned by the AI even if page
  // classification was uncertain. The model can correctly read the address
  // while still choosing the wrong page index, and dropping those values
  // leaves the details form empty.
  for (const f of BACK_FIELDS) details[f] = clean(f, ai.back?.[f]);
  const fieldSources = {};
  const fieldWarnings = {};
  const checks = [check('data_page_found', 'Passport front page found', true, 'error', `Page ${frontPageIndex + 1}`)];

  checks.push(
    check(
      'back_page_found',
      'Passport back page found',
      backPageIndex >= 0,
      'warning',
      backPageIndex >= 0 ? `Page ${backPageIndex + 1}` : 'Upload the last (address) page of the passport'
    )
  );
  if (backPageIndex >= 0) {
    checks.push(
      check('same_document', 'Front and back from the same passport', ai.sameDocument !== false, 'error', ai.sameDocument === false ? 'The back page appears to belong to a different passport' : null)
    );
  }
  const unreadable = [frontPageIndex, backPageIndex].filter((i) => i >= 0 && pageInfo[i].legible === false);
  checks.push(
    check('legible', 'Pages clearly readable', unreadable.length === 0, 'warning', unreadable.length ? `Hard to read: page ${[...new Set(unreadable)].map((i) => i + 1).join(', ')}` : null)
  );

  // MRZ: the OCR reading when it passes at least as many check digits as
  // the AI's transcription (it usually passes all five); checksum-verified
  // values then win over the printed reading.
  const aiMrz = parseMrz(ai.front?.mrzLine1, ai.front?.mrzLine2);
  const useOcr = ocrMrz?.parsed && ocrMrz.pageIndex === frontPageIndex && scoreOf(ocrMrz.parsed) >= scoreOf(aiMrz);
  const mrz = useOcr ? ocrMrz.parsed : aiMrz;
  if (!mrz) {
    checks.push(check('mrz_valid', 'Machine-readable code (MRZ) verified', false, 'error', 'The two code lines at the bottom of the photo page could not be read'));
  } else {
    const failed = Object.entries(mrz.checks).filter(([, ok]) => !ok).map(([k]) => k);
    // Number, birth and expiry verified: a failed personal/composite digit
    // is a warning (details are still filled, flagged to double-check).
    checks.push(
      check(
        'mrz_valid',
        'Machine-readable code (MRZ) verified',
        mrz.valid,
        coreVerified(mrz) ? 'warning' : 'error',
        mrz.valid ? null : `Check digit failed: ${failed.join(', ')}`
      )
    );
    // Names/nationality/sex carry no check digit of their own, but the
    // whole line pair is trusted once every check digit passes — and, for
    // the OCR, when its independent readings agreed (confidence "high").
    const lowConfidence = useOcr && ocrMrz.confidence !== 'high';
    const trusted = mrz.valid && !lowConfidence;
    if (lowConfidence) {
      checks.push(
        check('mrz_confidence', 'Code lines read clearly', false, 'warning', 'The code lines were hard to read — double-check the details against the passport')
      );
    }
    const mrzComparable = {
      passportNumber: mrz.checks.number && mrz.fields.passportNumber,
      dateOfBirth: mrz.checks.dateOfBirth && mrz.fields.dateOfBirth,
      dateOfExpiry: mrz.checks.dateOfExpiry && mrz.fields.dateOfExpiry,
      sex: mrz.fields.sex !== 'X' && mrz.fields.sex,
      nationality: mrz.fields.nationality && (NATIONALITY[mrz.fields.nationality] || mrz.fields.nationality),
      surname: mrz.fields.surname,
      givenNames: mrz.fields.givenNames,
      issuingCountry: mrz.fields.issuingCountry,
    };
    const mismatches = [];
    for (const [field, mrzValue] of Object.entries(mrzComparable)) {
      if (!mrzValue) continue;
      const printed = details[field];
      const isName = field === 'surname' || field === 'givenNames';
      const same = isName || field === 'nationality'
        ? nameTokens(printed).join(' ') === nameTokens(mrzValue).join(' ') ||
          (field === 'nationality' && nameTokens(printed).join(' ') === nameTokens(mrz.fields.nationality).join(' '))
        : printed === mrzValue;
      if (!printed) {
        details[field] = mrzValue;
        if (lowConfidence) fieldWarnings[field] = 'Read from the code lines — please double-check';
        else fieldSources[field] = 'mrz';
      } else if (same) {
        if (!lowConfidence && (trusted || ['passportNumber', 'dateOfBirth', 'dateOfExpiry'].includes(field))) fieldSources[field] = 'mrz';
      } else if (isName && nameTokens(printed).join(' ').startsWith(nameTokens(mrzValue).join(' '))) {
        // Long names are cut short in the MRZ — the printed one is complete.
      } else if (field === 'issuingCountry' || field === 'nationality') {
        // Printed wording vs code (e.g. "REPUBLIC OF INDIA" vs IND) — fine.
      } else {
        // Check-digit-verified MRZ values are more reliable than a print read.
        if (!lowConfidence && (['passportNumber', 'dateOfBirth', 'dateOfExpiry'].includes(field) || (trusted && useOcr))) {
          fieldWarnings[field] = `Printed reads "${printed}", code reads "${mrzValue}" — using the code (checksum verified)`;
          details[field] = mrzValue;
          fieldSources[field] = 'mrz';
        } else {
          fieldWarnings[field] = `Code reads "${mrzValue}" — please confirm`;
        }
        mismatches.push(field);
      }
    }
    checks.push(
      check('mrz_matches_print', 'Printed details match the code', mismatches.length === 0, 'warning', mismatches.length ? `Differs: ${mismatches.join(', ')}` : null)
    );
  }
  fixIssueDate(details, fieldWarnings);

  const rules = validateDetails(details, { travellerName, today });
  checks.push(...rules.checks);
  Object.assign(fieldWarnings, rules.fieldWarnings);

  const hardFail = checks.some((c) => !c.passed && c.severity === 'error');
  return {
    status: hardFail ? 'needs_review' : 'scanned',
    frontPageIndex,
    backPageIndex,
    pages: pageInfo,
    details,
    fieldSources,
    fieldWarnings,
    checks,
    issues: [...new Set([...(ai.issues || []), ...checks.filter((c) => !c.passed && c.detail).map((c) => `${c.label}: ${c.detail}`)])],
    mrz: mrz ? { valid: mrz.valid, checks: mrz.checks, lines: mrz.lines, source: useOcr ? 'ocr' : 'ai' } : null,
  };
}

module.exports.buildScanResult = buildScanResult;

/**
 * @param {{ buffer: Buffer, slot: 'front'|'back'|'document', label: string }[]} pages
 */
const OCR_BUDGET_MS = 30000;

/**
 * Finds and reads the MRZ across the uploaded pages: front-slot pages
 * first, then the rest (whole-passport PDFs), upright only; if nothing is
 * found, the front images are retried at 180°/90°/270° (sideways phone
 * photos). Stops at the first fully verified MRZ.
 * @returns {Promise<null | { pageIndex, line1, line2, parsed, score }>}
 */
async function locateMrz(pages) {
  const started = Date.now();
  const order = pages
    .map((p, i) => ({ i, rank: p.slot === 'front' ? 0 : p.slot === 'document' ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  let best = null;
  const consider = (r, i) => {
    const weight = (x) => x.rank + (x.confidence === "high" ? 10 : 0);
    if (r && (!best || weight(r) > weight(best))) best = { ...r, pageIndex: i };
  };
  try {
    for (const { i } of order) {
      if (Date.now() - started > OCR_BUDGET_MS) break;
      consider(await readMrz(pages[i].buffer, { rotations: [0] }), i);
      if (best?.confidence === "high") return best;
    }
    if (!best || best.score < 3) {
      for (const { i } of order.filter((o) => pages[o.i].slot !== 'back').slice(0, 2)) {
        if (Date.now() - started > OCR_BUDGET_MS) break;
        consider(await readMrz(pages[i].buffer, { rotations: [180, 90, 270] }), i);
        if (best?.confidence === "high") return best;
      }
    }
  } catch (err) {
    console.error('[passportScan] MRZ OCR failed', err.message);
  }
  return best;
}

module.exports.locateMrz = locateMrz;

async function askGemini(pages) {
  const parts = [{ text: buildPrompt(pages) }];
  for (const [i, p] of pages.entries()) {
    // 2048px keeps the small printed text and MRZ legible.
    parts.push({ text: `Page ${i}:` }, await toGeminiImagePart(p.buffer, 2048));
  }
  return generateJson({ parts, schema: AI_SCHEMA, timeoutMs: 20000, logTag: 'passportScan' });
}

/**
 * @param {{ buffer: Buffer, slot: 'front'|'back'|'document', label: string }[]} pages
 */
async function scanPassport(pages, { travellerName } = {}) {
  // Both readers run in parallel.
  const [ocrMrz, ai] = await Promise.all([
    locateMrz(pages),
    isAiConfigured() ? askGemini(pages) : Promise.resolve({ ran: false, reason: 'not_configured' }),
  ]);
  const ocrFound = usableOcr(ocrMrz);

  if (ai.ran) {
    console.log('[passportScan] AI extracted location fields', {
      provider: ai.provider || 'gemini',
      placeOfBirth: ai.result?.front?.placeOfBirth || null,
      placeOfIssue: ai.result?.front?.placeOfIssue || null,
      addressPageIndex: ai.result?.backPageIndex ?? null,
      addressExtracted: Boolean(ai.result?.back?.address),
      addressLength: String(ai.result?.back?.address || '').length,
      backFields: BACK_FIELDS.filter((field) => Boolean(ai.result?.back?.[field])),
      address: ai.result?.back?.address || null,
    });
    return {
      ...buildScanResult(ai.result, pages, { travellerName, ocrMrz }),
      ai: { provider: ai.provider || 'gemini', model: ai.model },
      ocr: ocrMrz ? { pageIndex: ocrMrz.pageIndex, score: ocrMrz.score } : null,
    };
  }

  // No AI: a verified MRZ still gives every core field; the agent types the
  // few printed-only ones (place of birth/issue, issue date, back page).
  if (ocrFound) {
    const backIndex = pages.findIndex((p, i) => p.slot === 'back' && i !== ocrMrz.pageIndex);
    const mrzOnly = {
      isPassport: true,
      pages: pages.map((p, i) => ({ index: i, type: i === ocrMrz.pageIndex ? 'data_page' : i === backIndex ? 'address_page' : 'other', legible: true })),
      frontPageIndex: ocrMrz.pageIndex,
      backPageIndex: backIndex,
      sameDocument: true,
      front: {},
      back: {},
      issues: [],
    };
    const result = buildScanResult(mrzOnly, pages, { travellerName, ocrMrz });
    const todo = ['place of birth', 'place of issue', 'date of issue', ...(backIndex >= 0 ? ['the back-page details'] : [])];
    result.issues = [`Read from the passport's code lines. Please fill in ${todo.join(', ').replace(/, ([^,]*)$/, ' and $1')} by hand.`, ...result.issues];
    return { ...result, ai: { skipped: true, reason: ai.reason }, ocr: { pageIndex: ocrMrz.pageIndex, score: ocrMrz.score } };
  }

  const why =
    ai.reason === 'not_configured'
      ? "The passport's code lines (the two lines of <<< at the bottom of the photo page) couldn't be read. Retake the photo page flat, in focus and without glare — or enter the details by hand."
      : `${ai.reason} The code lines couldn't be read either — enter the details by hand.`;
  return manualFallback(pages, why);
}

module.exports.scanPassport = scanPassport;

// No AI: keep what the agent put in each slot and let them type the details.
function manualFallback(pages, reason) {
  const frontPageIndex = Math.max(0, pages.findIndex((p) => p.slot === 'front'));
  const backPageIndex = pages.findIndex((p) => p.slot === 'back');
  return {
    status: 'needs_review',
    frontPageIndex,
    backPageIndex,
    pages: pages.map((p, i) => ({ index: i, label: p.label, slot: p.slot, type: 'unknown', legible: true })),
    details: Object.fromEntries([...FRONT_FIELDS, ...BACK_FIELDS].map((f) => [f, ''])),
    fieldSources: {},
    fieldWarnings: {},
    checks: [],
    issues: [reason],
    mrz: null,
    ai: { skipped: true, reason },
  };
}
