// Passport MRZ (machine readable zone) parsing + check-digit validation —
// ICAO Doc 9303, TD3 format (passports: 2 lines × 44 characters).
//
//   Line 1: P<ISSUER SURNAME<<GIVEN<NAMES<<<<<<<<<<<<<<<<<<<<<<
//   Line 2: NUMBER###C NAT YYMMDD C S YYMMDD C PERSONAL#######C C
//            0-8      9 10  13   19 20 21  27 28            42 43
//
// The check digits catch a misread passport number or date, so a value
// the AI read off the page can be trusted (or flagged) without a human.

const WEIGHTS = [7, 3, 1];

function charValue(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 55;
  return 0; // '<' filler
}

function checkDigit(value) {
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) sum += charValue(value[i]) * WEIGHTS[i % 3];
  return String(sum % 10);
}

module.exports.checkDigit = checkDigit;

// Normalises what an OCR/AI read gives back: uppercase, spaces removed,
// common look-alikes for the filler fixed, padded/truncated to 44.
function cleanLine(line) {
  const cleaned = String(line || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[«‹]/g, '<')
    .replace(/[^A-Z0-9<]/g, '<');
  return cleaned.padEnd(44, '<').slice(0, 44);
}

// YYMMDD -> YYYY-MM-DD. Birth dates can't be in the future, so a year
// above this year's two digits is 19xx; expiry dates are always 20xx.
function mrzDate(yymmdd, kind) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  const currentYY = new Date().getUTCFullYear() % 100;
  const century = kind === 'birth' ? (yy > currentYY ? 1900 : 2000) : 2000;
  const iso = `${century + yy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function names(field) {
  const [surname, given = ''] = field.split('<<');
  const tidy = (s) => s.replace(/<+/g, ' ').trim();
  return { surname: tidy(surname), givenNames: tidy(given) };
}

/**
 * @returns {null | { valid, checks: {number, dateOfBirth, dateOfExpiry, personalNumber, composite}, fields }}
 * null when the lines don't look like a passport MRZ at all.
 */
function parseMrz(line1Raw, line2Raw) {
  if (!line1Raw || !line2Raw) return null;
  const line1 = cleanLine(line1Raw);
  const line2 = cleanLine(line2Raw);
  if (line1[0] !== 'P') return null;

  const number = line2.slice(0, 9);
  const dob = line2.slice(13, 19);
  const expiry = line2.slice(21, 27);
  const personal = line2.slice(28, 42);

  const checks = {
    number: checkDigit(number) === line2[9],
    dateOfBirth: checkDigit(dob) === line2[19],
    dateOfExpiry: checkDigit(expiry) === line2[27],
    // An all-filler personal number may carry '<' or '0' as its check digit.
    personalNumber: /^<+$/.test(personal) ? ['<', '0'].includes(line2[42]) : checkDigit(personal) === line2[42],
    composite: checkDigit(line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43)) === line2[43],
  };

  const sexChar = line2[20];
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    fields: {
      documentType: line1.slice(0, 2).replace(/<+/g, ''),
      issuingCountry: line1.slice(2, 5).replace(/<+/g, ''),
      ...names(line1.slice(5)),
      passportNumber: number.replace(/<+/g, ''),
      nationality: line2.slice(10, 13).replace(/<+/g, ''),
      dateOfBirth: mrzDate(dob, 'birth'),
      sex: sexChar === 'M' || sexChar === 'F' ? sexChar : 'X',
      dateOfExpiry: mrzDate(expiry, 'expiry'),
    },
    lines: [line1, line2],
  };
}

module.exports.parseMrz = parseMrz;
