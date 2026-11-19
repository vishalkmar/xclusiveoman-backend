const { generateJson, isAiConfigured, toGeminiImagePart } = require('./gemini.service.js');
const { readPageText } = require('./mrzOcr.service.js');
const { readBarcodes, trimPage } = require('./barcode.service.js');

// Passport back (address) page check. The agent uploads the front page
// first — its passport number is read there (passportScan.service.js) — and
// then the back page. The back page is only accepted when the SAME passport
// number is printed on it, so a back page from another passport (another
// traveller, an old passport) can't be paired with the front by mistake.
//
// Readers, any one is enough to confirm a match:
//   1. The barcode along the bottom of the page (barcode.service.js, ZXing —
//      on-server, exact: a decoded barcode carries its own checksum). It
//      matches when what it encodes contains the front page's number.
//      NB: on some passports this barcode encodes the FILE number instead,
//      so a barcode WITHOUT the passport number is not a mismatch on its
//      own — the readers below still decide.
//   2. On-server OCR (mrzOcr.service.js readPageText): the page's text, read
//      upright, then turned 180°/90°/270° for photos taken the wrong way up,
//      searched for the front page's number.
//   3. Gemini (when GEMINI_API_KEY is set): reads the number printed on the
//      page, the text printed with the barcode, and the address-page details
//      (father/mother/spouse, address…).
// OCR look-alikes (O/0, I/1, Z/2, S/5, B/8…) count as the same character.

const LOOKALIKE = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', B: '8', G: '6', T: '7' };
const BACK_FIELDS = ['fatherName', 'motherName', 'spouseName', 'address', 'fileNumber', 'oldPassportNumber'];
const OCR_ROTATIONS = [0, 180, 90, 270];
const OCR_BUDGET_MS = 30000;

// Letters and digits only, look-alikes folded together.
function canonical(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[OQDUILJZSBGT]/g, (c) => LOOKALIKE[c]);
}

module.exports.canonical = canonical;

function sameNumber(a, b) {
  const x = canonical(a);
  return x.length >= 6 && x === canonical(b);
}

module.exports.sameNumber = sameNumber;

// Passport-number-shaped tokens in OCR text. Passport numbers commonly have
// one or two letters followed by seven digits (for example PA2559576). OCR
// may insert spaces or punctuation between characters, so search both the
// original text and a compact alphanumeric version.
function numberCandidates(text) {
  const raw = String(text || '').toUpperCase();
  const compact = raw.replace(/[^A-Z0-9]/g, '');
  const candidates = new Set();
  for (const value of [raw, compact]) {
    const matches = value.match(/(?:^|[^A-Z0-9])([A-Z]{1,2}[0-9]{7})(?=$|[^A-Z0-9])/g) || [];
    for (const match of matches) candidates.add(match.replace(/[^A-Z0-9]/g, ''));
  }
  // Compact OCR text can merge a nearby label into the number. Find the
  // number-shaped substring as a final pass.
  for (const match of compact.match(/[A-Z]{1,2}[0-9]{7}/g) || []) candidates.add(match);
  return [...candidates];
}

const str = { type: 'STRING' };
const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isAddressPage: { type: 'BOOLEAN' },
    passportNumber: str,
    barcodeText: str,
    back: { type: 'OBJECT', properties: { passportNumber: str, ...Object.fromEntries(BACK_FIELDS.map((f) => [f, str])) } },
  },
  required: ['isAddressPage', 'passportNumber', 'barcodeText', 'back'],
};

function buildPrompt(frontPassportNumber) {
  return [
    'The image(s) are meant to be the back (last / address) page of a passport — the page with the address, father / mother / spouse names, file number and old passport details.',
    'Return JSON only:',
    '- isAddressPage: true if this is that page of a passport.',
    `- passportNumber: check specifically whether the current passport number ${frontPassportNumber} is printed or perforated on this page. Return that exact number if visible, otherwise return "". Do NOT return the file number, barcode reference number, or old passport number.`,
    '- barcodeText: the characters printed directly under or beside the barcode at the bottom of the page, exactly as shown. "" if there is no barcode or its text is unreadable.',
    '- back: the fields exactly as printed (names in UPPERCASE, address on one line), plus passportNumber if the current passport number is printed on the address page; "" for anything not present — never guess.',
  ].join('\n');
}

async function askGemini(buffers, frontPassportNumber) {
  const parts = [{ text: buildPrompt(frontPassportNumber) }];
  for (const b of buffers) parts.push(await toGeminiImagePart(b, 2048));
  return generateJson({ parts, schema: AI_SCHEMA, timeoutMs: 20000, logTag: 'passportBack' });
}

/**
 * @param {Buffer[]} buffers  the back page image(s) (a PDF arrives as pages)
 * @param {{ passportNumber: string }} front  number read from the front page
 * @returns {Promise<{ matched: boolean, method: 'ocr'|'ai'|null, pageIndex: number,
 *   foundNumbers: string[], backDetails: object|null, isAddressPage: boolean|null }>}
 */
async function verifyBackPage(buffers, { passportNumber }) {
  const started = Date.now();
  const target = canonical(passportNumber);
  const found = new Set();

  // Gemini runs alongside the on-server readers (it also reads the address details).
  const aiPromise = isAiConfigured() ? askGemini(buffers, passportNumber) : Promise.resolve({ ran: false });

  // 1. Barcode.
  const barcodes = [];
  let barcodeMatch = -1;
  try {
    for (const [i, buffer] of buffers.entries()) {
      const codes = await readBarcodes(buffer);
      barcodes.push(...codes);
      if (target.length >= 6 && codes.some((c) => canonical(c).includes(target))) {
        barcodeMatch = i;
        break;
      }
      for (const c of codes) numberCandidates(c).forEach((n) => found.add(n));
    }
  } catch (err) {
    console.error('[passportBack] barcode read failed', err.message);
  }

  // 2. Page text (skipped once the barcode already matched). The scan's white
  // margin is cropped first so the passport page's print is large enough.
  const pages = barcodeMatch >= 0 ? [] : await Promise.all(buffers.map((b) => trimPage(b).catch(() => b)));
  let ocrMatch = -1;
  try {
    outer: for (const [i, buffer] of barcodeMatch >= 0 ? [] : buffers.entries()) {
      for (const rotation of OCR_ROTATIONS) {
        if (Date.now() - started > OCR_BUDGET_MS) break outer;
        const text = await readPageText(pages[i], rotation);
        if (target.length >= 6 && canonical(text).includes(target)) {
          ocrMatch = i;
          break outer;
        }
        numberCandidates(text).forEach((n) => found.add(n));
      }
    }
  } catch (err) {
    console.error('[passportBack] OCR failed', err.message);
  }

  const ai = await aiPromise;
  if (ai.ran) {
    console.log('[passportBack] AI parsed fields', {
      provider: ai.provider || 'gemini',
      model: ai.model || null,
      passportNumber: ai.result?.passportNumber || ai.result?.back?.passportNumber || null,
      barcodeText: ai.result?.barcodeText || null,
      isAddressPage: ai.result?.isAddressPage ?? null,
      address: ai.result?.back?.address || null,
      backFields: BACK_FIELDS.filter((field) => Boolean(ai.result?.back?.[field])),
    });
  }
  const aiNumber = ai.ran
    ? String(ai.result.passportNumber || ai.result.back?.passportNumber || '').toUpperCase().replace(/\s+/g, '')
    : '';
  const aiBarcode = ai.ran ? String(ai.result.barcodeText || '') : '';
  const aiMatch =
    (!!aiNumber && sameNumber(aiNumber, passportNumber)) || (target.length >= 6 && !!aiBarcode && canonical(aiBarcode).includes(target));
  if (aiNumber && !aiMatch) found.add(aiNumber);

  const backDetails = ai.ran ? Object.fromEntries(BACK_FIELDS.map((f) => [f, String(ai.result.back?.[f] || '').replace(/\s+/g, ' ').trim()])) : null;
  const matched = barcodeMatch >= 0 || ocrMatch >= 0 || aiMatch;
  return {
    matched,
    method: barcodeMatch >= 0 ? 'barcode' : ocrMatch >= 0 ? 'ocr' : aiMatch ? 'ai' : null,
    pageIndex: barcodeMatch >= 0 ? barcodeMatch : ocrMatch >= 0 ? ocrMatch : 0,
    // What the barcode(s) on the page encode (kept for staff to see).
    barcodes: [...new Set(barcodes)],
    // Other passport numbers seen on the page (never the front's own).
    foundNumbers: [...found].filter((n) => !sameNumber(n, passportNumber)),
    backDetails,
    aiPassportNumber: aiNumber || null,
    isAddressPage: ai.ran ? !!ai.result.isAddressPage : null,
  };
}

module.exports.verifyBackPage = verifyBackPage;
