const path = require('path');
const sharp = require('sharp');
const { createWorker, OEM, PSM } = require('tesseract.js');
const engData = require('@tesseract.js-data/eng');

const { parseMrz, checkDigit } = require('./mrz.service.js');

// Reads a passport's MRZ (the two "P<IND…<<<" code lines on the photo page)
// with on-server OCR — no AI, no API key, no network:
//   1. Find it: OCR the page with only MRZ characters allowed (A–Z 0–9 <)
//      and dictionaries off, then look for two lines dense with "<" fillers.
//      Rotated photos: tries 0°, 180°, 90°, 270°.
//   2. Re-read it: crop just those lines, enlarge, OCR again in a couple of
//      image treatments (contrast-stretched grey, black/white).
//   3. Correct it by position: every MRZ position is known to be a digit,
//      a letter or either, so OCR look-alikes are fixed per position
//      (O→0 in a date, 0→O in a country code…). Where a position may be
//      either (the passport number), every look-alike combination is tried
//      and the one whose ICAO check digit passes wins.
//   4. Keep the reading that passes the most check digits (5 = fully
//      verified).
// The check digits make the result self-verifying: a fully valid MRZ has
// essentially no chance of being a misread.

const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const LINE_LENGTH = 44;

// ── Tesseract worker (one, reused, jobs run one at a time) ──────────────
let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      langPath: engData.langPath,
      gzip: engData.gzip,
      cacheMethod: 'none', // never write traineddata copies into the app folder
    }, {
      // No dictionary "corrections" — MRZ text isn't words.
      load_system_dawg: '0',
      load_freq_dawg: '0',
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function withWorker(fn) {
  const run = queue.then(async () => fn(await getWorker()));
  queue = run.catch(() => {});
  return run;
}

async function ocr(image, psm) {
  return withWorker(async (worker) => {
    await worker.setParameters({
      tessedit_char_whitelist: MRZ_CHARS,
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: '0',
    });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          lines.push({
            text: line.text || '',
            bbox: line.bbox,
            baseline: line.baseline,
            confidence: line.confidence,
            symbols: (line.words || []).flatMap((w) => w.symbols || []).map((s) => ({ text: s.text, bbox: s.bbox })),
          });
        }
      }
    }
    return { text: data.text || '', lines };
  });
}

// ── Position-aware correction ───────────────────────────────────────────
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', Z: '2', S: '5', B: '8', G: '6', T: '7', A: '4' };
const TO_ALPHA = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };
// Look-alikes tried when a position may be a letter or a digit.
const AMBIGUOUS = {
  O: ['0'], 0: ['O', 'D'], D: ['0'], Q: ['0'], I: ['1'], 1: ['I', '7'], L: ['1'], S: ['5'], 5: ['S'],
  B: ['8'], 8: ['B'], Z: ['2', '7'], 2: ['Z'], 7: ['Z', 'T', '1'], T: ['7'], G: ['6'], 6: ['G'], A: ['4'], 4: ['A'],
};
// Letters OCR commonly reports for a "<" filler.
const FILLER_LOOKALIKES = ['K', 'L', 'C', 'E', 'X', '<'];

const digit = (c) => (c >= '0' && c <= '9' ? c : TO_DIGIT[c] || c);
const alpha = (c) => (c >= 'A' && c <= 'Z' ? c : c === '<' ? '<' : TO_ALPHA[c] || c);
const digitOrFiller = (c) => (c === '<' ? '<' : digit(c));

function cleanChars(text) {
  return String(text || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9<]/g, '');
}

// Alphanumeric field with a check digit: try every look-alike swap (at
// most 2^10 combinations) and, among the variants whose check digit
// matches, prefer the most digits after the first character (passport and
// personal numbers are mostly numeric — a check digit alone can't tell
// "IZ34S67B" from "12345678" one time in ten), then the fewest changes.
function fixByCheckDigit(field, check, { trailingFillers = false } = {}) {
  // For the passport number: its last characters may be "<" padding read
  // as 1/I/L/K/C.
  const fillerAlt = (c, i) => trailingFillers && i >= 6 && '1ILKC'.includes(c);
  const positions = [...field].map((c, i) => (AMBIGUOUS[c] || fillerAlt(c, i) ? i : -1)).filter((i) => i >= 0).slice(0, 9);
  const options = positions.map((p) => [field[p], ...(AMBIGUOUS[field[p]] || []), ...(fillerAlt(field[p], p) ? ['<'] : [])]);
  const matches = [];
  // Every combination of original/look-alike per ambiguous position.
  const walk = (k, chars) => {
    if (k === positions.length) {
      const variant = chars.join('');
      if (checkDigit(variant) === check) matches.push(variant);
      return;
    }
    for (const opt of options[k]) {
      chars[positions[k]] = opt;
      walk(k + 1, chars);
    }
    chars[positions[k]] = field[positions[k]];
  };
  walk(0, [...field]);
  if (!matches.length) return field;
  const digitsAfterFirst = (v) => [...v.slice(1)].filter((c) => c >= '0' && c <= '9').length;
  const changes = (v) => [...v].filter((c, i) => c !== field[i]).length;
  return matches.sort((a, b) => digitsAfterFirst(b) - digitsAfterFirst(a) || changes(a) - changes(b))[0];
}

// A filler region with a few stray letters (fillers read as K/L/C…): when
// at least 70% of it is "<", it is all "<".
function settleFillers(segment) {
  const fillers = [...segment].filter((c) => c === '<').length;
  return fillers / segment.length >= 0.7 ? '<'.repeat(segment.length) : segment;
}

// Line 1: P<ISS NAMES… — the type/country are letters; names are letters
// and "<"; the tail after the names is all "<" (OCR often turns runs of
// "<" into K/C/E/L).
function correctLine1(raw) {
  let s = cleanChars(raw);
  if (s.length > LINE_LENGTH) s = s.slice(0, LINE_LENGTH);
  s = s.padEnd(LINE_LENGTH, '<');
  const chars = [...s].map((c, i) => (i === 1 ? (c === '<' ? '<' : alpha(c)) : alpha(c)));
  chars[0] = 'P';
  // Lone K/C/E/L/X between fillers are misread fillers.
  for (let i = 5; i < LINE_LENGTH; i += 1) {
    const prev = chars[i - 1];
    const next = chars[i + 1] ?? '<';
    if ('KCELX'.includes(chars[i]) && prev === '<' && next === '<' && (chars[i - 2] === '<' || chars[i + 2] === '<')) chars[i] = '<';
  }
  // ICAO 9303: name parts are joined by "<" and surname/given names by
  // "<<", so three fillers in a row only ever start the padding — every
  // character after the first "<<<" is a filler.
  const padStart = chars.join('').indexOf('<<<', 5);
  if (padStart >= 0) for (let j = padStart; j < LINE_LENGTH; j += 1) chars[j] = '<';
  // A line ending in one letter repeated 4+ times ("…LLLLLLL") is padding
  // read as that letter — no name ends like that.
  return chars.join('').replace(/([A-Z])\1{3,}$/, (run) => '<'.repeat(run.length));
}

// Line 2: NNNNNNNNN C NAT YYMMDD C S YYMMDD C PERSONAL…(14) C C
function correctLine2(raw) {
  let s = cleanChars(raw);
  if (s.length < 30) return null;
  // First 28 positions have a fixed layout and the last 2 are check digits;
  // re-fit the personal-number filler in between to exactly 14.
  if (s.length !== LINE_LENGTH) {
    const head = s.slice(0, 28);
    const tail = s.slice(-2);
    let middle = s.slice(28, -2);
    if (middle.length > 14) {
      const trimmed = middle.replace(/<+$/, '');
      middle = trimmed.length <= 14 ? trimmed.padEnd(14, '<') : middle.slice(0, 14);
    } else {
      middle = middle.padEnd(14, '<');
    }
    s = head + middle + tail;
  }
  const c = [...s];
  for (const i of [9, 19, 27, 43]) c[i] = digit(c[i]);
  for (let i = 13; i <= 18; i += 1) c[i] = digit(c[i]);
  for (let i = 21; i <= 26; i += 1) c[i] = digit(c[i]);
  for (let i = 10; i <= 12; i += 1) c[i] = alpha(c[i]);
  c[42] = digitOrFiller(c[42]);
  c[20] = { H: 'M', N: 'M', P: 'F', E: 'F' }[c[20]] || c[20];
  if (!['M', 'F', '<', 'X'].includes(c[20])) c[20] = '<';
  let line = c.join('');
  // Personal number: often all fillers; stray letters there are misread "<".
  const personalRaw = settleFillers(line.slice(28, 42));
  // Trailing fillers of a short passport number, likewise.
  const numberRaw = line.slice(0, 9).replace(/([A-Z0-9]+)([<KLC]*)$/, (m, head, tail) => head + (tail.includes('<') ? '<'.repeat(tail.length) : tail));
  const number = fixByCheckDigit(numberRaw, line[9], { trailingFillers: true });
  const personal = /^<+$/.test(personalRaw) ? personalRaw : fixByCheckDigit(personalRaw, line[42]);
  line = number + line.slice(9, 28) + personal + line.slice(42);
  // An empty personal number's check digit can only be "0" or "<" — any
  // other reading there (8, 6, O, D…) is OCR noise on a character that
  // carries no information, so settle it rather than fail the check.
  if (/^<+$/.test(personal) && !['0', '<'].includes(line[42])) line = line.slice(0, 42) + '0' + line.slice(43);
  return line;
}

function scoreOf(parsed) {
  return parsed ? Object.values(parsed.checks).filter(Boolean).length : -1;
}

// OCR sometimes adds or drops a character, which shifts every later MRZ
// position. For a line 1–2 characters off 44, also try every single/double
// deletion (too long) or "<" insertion (too short); the check digits pick
// the right one. Only the 28-character head matters for alignment.
function lengthVariants(raw) {
  return lengthVariantTexts(raw).map((text) => ({ text, edits: Math.abs(cleanChars(raw).length - text.length) + (text === cleanChars(raw) ? 0 : 1) }));
}

function lengthVariantTexts(raw) {
  const s = cleanChars(raw);
  const out = [s];
  // Anchor on the padding: "<head><<<<…<check><composite>". With an empty
  // personal number the head is exactly 28 characters, and the number of
  // fillers OCR reports doesn't matter — rebuild it. Trim a too-long head
  // by trying up to 2 deletions (more invites chance check-digit matches).
  const anchored = s.match(/^([A-Z0-9<]*?[A-Z0-9])(<{4,})([0-9<]?)([0-9])$/);
  if (anchored) {
    const [, head, , personalCheck, composite] = anchored;
    const rebuild = (h) => h + '<'.repeat(42 - h.length) + (personalCheck || '<') + composite;
    if (head.length === 28) out.push(rebuild(head));
    const extra = head.length - 28;
    if (extra >= 1 && extra <= 2) {
      let heads = [head];
      for (let k = 0; k < extra; k += 1) {
        const next = new Set();
        for (const h of heads) for (let i = 0; i < h.length; i += 1) next.add(h.slice(0, i) + h.slice(i + 1));
        heads = [...next];
      }
      for (const h of heads) out.push(rebuild(h));
    }
  }
  const diff = s.length - LINE_LENGTH;
  if (diff >= 1 && diff <= 2) {
    const singles = [];
    for (let i = 0; i < Math.min(s.length, 30); i += 1) singles.push(s.slice(0, i) + s.slice(i + 1));
    out.push(...singles);
    if (diff === 2) {
      for (const v of singles) for (let i = 0; i < Math.min(v.length, 30); i += 1) out.push(v.slice(0, i) + v.slice(i + 1));
    }
  } else if (diff <= -1 && diff >= -2) {
    for (let i = 0; i <= Math.min(s.length, 28); i += 1) out.push(s.slice(0, i) + '<'.repeat(-diff) + s.slice(i));
  }
  return [...new Set(out)];
}

// Best (line1, line2) from OCR'd lines: line 2 = the line with the TD3
// number/date layout, line 1 = the "<"-dense line just above it. Each line
// may come as { raw, shaped } — `shaped` is the cell-by-cell shape-checked
// reading (see shapeCorrectLine), preferred for line 1, tried for line 2.
function pickLines(lineReads) {
  const lines = lineReads
    .map((l) => (typeof l === 'string' ? { raw: l } : l))
    .map((l) => ({ raw: cleanChars(l.raw), shaped: l.shaped ? cleanChars(l.shaped) : null }))
    .filter((l) => l.raw.length >= 25 || (l.shaped && l.shaped.length >= 25));
  let best = null;
  for (let i = 0; i < lines.length; i += 1) {
    const texts = [
      ...(lines[i].shaped ? [{ text: lines[i].shaped, edits: 0 }] : []),
      ...lengthVariants(lines[i].raw),
    ];
    for (const { text, edits } of texts) {
      let l2 = correctLine2(text);
      if (!l2) continue;
      // line 1 is normally right above; fall back to any P-line.
      const candidates = [lines[i - 1], ...lines.filter((l, j) => j !== i && /^P/.test(l.raw))].filter(Boolean);
      for (const cand of candidates) {
        for (const [l1text, shapedBonus] of [[cand.shaped, 0.5], [cand.raw, 0]]) {
          if (!l1text) continue;
          const l1 = correctLine1(l1text);
          // Nationality is (nearly always) the issuing state on line 1: a
          // one-letter difference is an OCR slip (TND → IND). It isn't
          // covered by any check digit, so this is its only cross-check.
          const issuer = l1.slice(2, 5);
          const nat = l2.slice(10, 13);
          if (nat !== issuer && /^[A-Z]{3}$/.test(issuer) && [...nat].filter((c, k) => c !== issuer[k]).length === 1) {
            l2 = l2.slice(0, 10) + issuer + l2.slice(13);
          }
          const parsed = parseMrz(l1, l2);
          const score = scoreOf(parsed);
          // Many variants are tried, so a wrong one can pass the check
          // digits by chance — sanity rules break such ties: real dates,
          // nationality agreeing with the issuer, fewest edits.
          const datesOk = parsed && parsed.fields.dateOfBirth && parsed.fields.dateOfExpiry;
          const natOk = parsed && parsed.fields.nationality === parsed.fields.issuingCountry;
          // Look-alike substitutions made to reach this reading.
          const fitted = cleanChars(text).padEnd(LINE_LENGTH, '<').slice(0, LINE_LENGTH);
          const subs = [...l2].filter((c, k) => c !== fitted[k]).length;
          const numberDigits = [...l2.slice(1, 9)].filter((c) => c >= '0' && c <= '9').length;
          const rank =
            score + shapedBonus + (natOk ? 0.3 : -1) - (datesOk ? 0 : 3) - edits * 0.05 - subs * 0.02 + numberDigits * 0.01;
          if (!best || rank > best.rank) best = { line1: l1, line2: l2, parsed, score, rank, sane: !!(datesOk && natOk), edits, subs, l1Shaped: shapedBonus > 0 };
        }
      }
    }
  }
  return best;
}

// ── Filler detection by glyph shape ─────────────────────────────────────
// MRZ text is fixed-pitch, 44 cells per line, and every cell has ink
// (fillers are printed "<"). OCR models often read "<" as K/L/C, which
// line 1 (names, no check digits) can't catch. So each cell is classified
// from its pixels: a "<" chevron's leftmost ink is a short run around the
// glyph's vertical middle (its apex); letters have a full-height left
// stroke (B D E F H K L M N P R…), a round side (C G O Q), or left ink at
// the top/bottom (A J S T V W X Y Z).

// Otsu threshold of a greyscale buffer.
function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

async function inkMap(image) {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const thr = otsu(data);
  return { ink: (x, y) => data[y * info.width + x] < thr, width: info.width, height: info.height };
}

function cellIsChevron(map, x0, x1, y0, y1) {
  // Ink bounding box inside the cell.
  let gx0 = Infinity;
  let gx1 = -1;
  let gy0 = Infinity;
  let gy1 = -1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (map.ink(x, y)) {
        if (x < gx0) gx0 = x;
        if (x > gx1) gx1 = x;
        if (y < gy0) gy0 = y;
        if (y > gy1) gy1 = y;
      }
    }
  }
  if (gx1 < 0) return null; // empty cell
  const gh = gy1 - gy0 + 1;
  const gw = gx1 - gx0 + 1;
  if (gw < 3 || gh < 5) return null;
  // Ink rows in the leftmost 15% of the glyph.
  const stripEnd = gx0 + Math.max(1, Math.round(gw * 0.15));
  let ry0 = Infinity;
  let ry1 = -1;
  for (let y = gy0; y <= gy1; y += 1) {
    for (let x = gx0; x <= stripEnd; x += 1) {
      if (map.ink(x, y)) {
        if (y < ry0) ry0 = y;
        if (y > ry1) ry1 = y;
        break;
      }
    }
  }
  if (ry1 < 0) return null;
  const extent = (ry1 - ry0 + 1) / gh;
  const centre = ((ry0 + ry1) / 2 - gy0) / gh;
  return extent <= 0.45 && Math.abs(centre - 0.5) <= 0.17;
}

// Rebuilds one OCR'd MRZ line cell by cell: "<" where the shape says
// chevron, otherwise the OCR letter whose box sits over that cell.
function shapeCorrectLine(map, line) {
  if (!line?.bbox || !line.symbols?.length) return null;
  const { y0, y1 } = line.bbox;
  // Horizontal ink extent of the line band.
  let xa = Infinity;
  let xb = -1;
  for (let x = 0; x < map.width; x += 1) {
    let n = 0;
    for (let y = y0; y <= y1 && n < 2; y += 1) if (map.ink(x, y)) n += 1;
    if (n >= 2) {
      if (x < xa) xa = x;
      xb = x;
    }
  }
  if (xb <= xa) return null;
  // The band may include stray marks far from the text: clamp to the
  // OCR'd symbols' extent.
  xa = Math.max(xa, Math.min(...line.symbols.map((s) => s.bbox.x0)) - 4);
  xb = Math.min(xb, Math.max(...line.symbols.map((s) => s.bbox.x1)) + 4);
  const p0 = (xb - xa) / (LINE_LENGTH - 0.4);
  if (p0 < 6) return null;
  // Fit the 44-cell grid to the text: the pitch/offset whose cell
  // boundaries fall in the white gaps between characters (fonts differ in
  // how much of the advance a glyph's ink fills, so the ink extent alone
  // drifts by the end of the line).
  const colInk = new Array(map.width).fill(0);
  for (let x = 0; x < map.width; x += 1) for (let y = y0; y <= y1; y += 1) if (map.ink(x, y)) colInk[x] += 1;
  const inkAt = (x) => (x >= 0 && x < map.width ? colInk[Math.round(x)] : 0);
  let grid = { pitch: p0, start: xa, cost: Infinity };
  for (let p = p0 * 0.95; p <= p0 * 1.05; p += p0 * 0.002) {
    for (let o = -Math.round(p0 * 0.45); o <= Math.round(p0 * 0.2); o += 1) {
      let cost = 0;
      for (let k = 0; k <= LINE_LENGTH; k += 1) cost += inkAt(xa + o + k * p);
      cost += Math.abs(p - p0) * 0.01; // tie-break towards the estimate
      if (cost < grid.cost) grid = { pitch: p, start: xa + o, cost };
    }
  }
  const pitch = grid.pitch;
  const rawText = cleanChars(line.text);
  const letters = line.symbols.filter((s) => /^[A-Z0-9]$/.test(s.text));
  let out = '';
  for (let i = 0; i < LINE_LENGTH; i += 1) {
    const cx0 = Math.max(0, Math.round(grid.start + i * pitch));
    const cx1 = Math.min(map.width - 1, Math.round(grid.start + (i + 1) * pitch) - 1);
    // Inner part of the cell only: the next glyph's edge (e.g. a chevron's
    // tip) can reach into the cell's right side.
    const chevron = cellIsChevron(
      map,
      cx0 + Math.round(pitch * 0.02),
      cx1 - Math.round(pitch * 0.12),
      Math.max(0, y0 - 2),
      Math.min(map.height - 1, y1 + 2)
    );
    const centre = (cx0 + cx1) / 2;
    let best = null;
    for (const s of letters) {
      const d = Math.abs((s.bbox.x0 + s.bbox.x1) / 2 - centre);
      if (d <= pitch * 0.75 && (!best || d < best.d)) best = { d, text: s.text };
    }
    // The shape only overrules the OCR for the known "<" confusions; a
    // clearly-read other letter (A, H, U…) wins over a shape false alarm.
    if (chevron === true && (!best || FILLER_LOOKALIKES.includes(best.text))) {
      out += '<';
      continue;
    }
    // Uncertain shape and no OCR letter over the cell: fall back to the
    // plain OCR reading at this position.
    out += best ? best.text : chevron === null ? '<' : rawText[i] || '<';
  }
  return out;
}

// ── Locating the MRZ on the page ────────────────────────────────────────
const isMrzish = (t) => {
  const s = cleanChars(t);
  return s.length >= 25 && (s.match(/</g) || []).length >= 3;
};

// Upright (EXIF), turned by `rotation`, greyscale, contrast-stretched, and
// scaled to 1600–2400px wide — the range OCR reads a full page best at.
// (sharp applies one rotation per pipeline, hence two steps.)
async function prepared(buffer, rotation) {
  const oriented = await sharp(buffer, { failOn: 'none' }).rotate().toBuffer();
  const turned = await sharp(oriented).rotate(rotation).toBuffer({ resolveWithObject: true });
  const target = Math.max(1600, Math.min(2400, turned.info.width));
  return sharp(turned.data).resize({ width: target }).greyscale().normalise().png().toBuffer({ resolveWithObject: true });
}

async function readRegion(page, info, bbox) {
  const lineH = Math.max(10, (bbox.y1 - bbox.y0) / 2);
  const left = Math.max(0, Math.round(bbox.x0 - lineH));
  const top = Math.max(0, Math.round(bbox.y0 - lineH * 0.8));
  const width = Math.min(info.width - left, Math.round(bbox.x1 - bbox.x0 + lineH * 2));
  const height = Math.min(info.height - top, Math.round(bbox.y1 - bbox.y0 + lineH * 1.6));
  if (width < 50 || height < 20) return null;
  const crop = sharp(page).extract({ left, top, width, height });
  // ~44 characters per line: aim for ~45px per character width.
  const scaled = await crop.clone().resize({ width: Math.max(width, 2000) }).toBuffer();
  const variants = [
    await sharp(scaled).normalise().sharpen().png().toBuffer(),
    await sharp(scaled).normalise().threshold(140).png().toBuffer(),
  ];
  // Each image treatment is an independent reading (they vote in decide()).
  const found = [];
  for (const v of variants) {
    const { lines, text } = await ocr(v, PSM.SINGLE_BLOCK);
    const map = await inkMap(v);
    const reads = lines.length
      ? lines.map((l) => ({ raw: l.text, shaped: cleanChars(l.text).length >= 25 ? shapeCorrectLine(map, l) : null }))
      : text.split('\n');
    const r = pickLines(reads);
    if (r) found.push(r);
  }
  return found;
}

// Chooses among independent readings. Readings that pass all five check
// digits and the sanity rules vote on line 2 (the verified data). The
// winner is "high" confidence when it needed at most one length edit or at
// least two readings agree, and no other verified reading contradicts it;
// otherwise it's only a suggestion ("low").
function decide(readings) {
  if (!readings.length) return null;
  const verified = readings.filter((r) => r.score === 5 && r.sane);
  if (!verified.length) {
    const best = readings.reduce((a, b) => (b.rank > a.rank ? b : a));
    return { ...best, agreement: 1, confidence: 'low' };
  }
  const groups = new Map();
  for (const r of verified) groups.set(r.line2, [...(groups.get(r.line2) || []), r]);
  const topRank = (g) => Math.max(...g.map((r) => r.rank));
  const [, group] = [...groups.entries()].sort(([, a], [, b]) => b.length - a.length || topRank(b) - topRank(a))[0];
  let best = group.reduce((a, b) => (b.rank > a.rank ? b : a));
  const agreement = group.length;
  const contested = groups.size > 1 && agreement === 1;
  const confidence = !contested && (best.edits <= 1 || agreement >= 2) ? 'high' : 'low';
  // Line 1 (names) is independent of the line-2 vote: use the most common
  // shape-checked line 1 from any reading of the same issuer.
  const shapedLine1s = readings.filter((r) => r.l1Shaped && r.line1.slice(2, 5) === best.line1.slice(2, 5)).map((r) => r.line1);
  if (!best.l1Shaped && shapedLine1s.length) {
    const counts = new Map();
    for (const l of shapedLine1s) counts.set(l, (counts.get(l) || 0) + 1);
    const line1 = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const parsed = parseMrz(line1, best.line2);
    if (parsed) best = { ...best, line1, parsed, l1Shaped: true };
  }
  return { ...best, agreement, confidence };
}

// Page OCR + MRZ-line detection; straightens the page first when the MRZ
// lines are tilted (phone photos), since the cell grid assumes level lines.
async function findMrzLines(page) {
  let { lines } = await ocr(page, PSM.AUTO);
  let mrzLines = lines.filter((l) => isMrzish(l.text) && l.bbox);
  const angles = mrzLines
    .map((l) => l.baseline)
    .filter((b) => b && b.x1 - b.x0 > 100)
    .map((b) => (Math.atan2(b.y1 - b.y0, b.x1 - b.x0) * 180) / Math.PI)
    .sort((a, b) => a - b);
  const angle = angles.length ? angles[Math.floor(angles.length / 2)] : 0;
  if (Math.abs(angle) > 0.3 && Math.abs(angle) < 15) {
    page = await sharp(page).rotate(-angle, { background: { r: 255, g: 255, b: 255 } }).png().toBuffer();
    ({ lines } = await ocr(page, PSM.AUTO));
    mrzLines = lines.filter((l) => isMrzish(l.text) && l.bbox);
  }
  const { width, height } = await sharp(page).metadata();
  return { page, info: { width, height }, lines, mrzLines, deskewed: Math.abs(angle) > 0.3 ? angle : 0 };
}

// Fallback when the page-level layout analysis misses the code lines (soft,
// small or slightly tilted phone photos): the MRZ always sits along the
// bottom of the photo page, so read just the bottom strip, straightened by
// a few small angles, and stop at the first angle that shows both lines.
const STRIP_ANGLES = [0, -1, 1, -2, 2, -3, 3];

async function findMrzInBottomStrip(page, info) {
  const top = Math.round(info.height * 0.55);
  const base = await sharp(page).extract({ left: 0, top, width: info.width, height: info.height - top }).png().toBuffer();
  let partial = null;
  for (const angle of STRIP_ANGLES) {
    const strip = angle ? await sharp(base).rotate(angle, { background: { r: 255, g: 255, b: 255 } }).png().toBuffer() : base;
    const { lines } = await ocr(strip, PSM.SINGLE_BLOCK);
    const mrzLines = lines.filter((l) => isMrzish(l.text) && l.bbox);
    if (!mrzLines.length) continue;
    const { width, height } = await sharp(strip).metadata();
    const found = { page: strip, info: { width, height }, lines, mrzLines };
    if (mrzLines.length >= 2) return found;
    partial = partial || found;
  }
  return partial;
}

/**
 * Reads the MRZ from one page image.
 * @returns {Promise<null | { line1, line2, parsed, score, rank, confidence, agreement, rotation }>}
 *   score = check digits passed (0–5); parsed = parseMrz() result;
 *   confidence 'high' = safe to treat as verified, 'low' = a suggestion.
 */
async function readMrz(buffer, { rotations = [0, 180, 90, 270] } = {}) {
  let best = null;
  for (const rotation of rotations) {
    const { data: raw } = await prepared(buffer, rotation);
    // Two adjacent "<"-dense lines = the MRZ (accept one, the other may
    // have been split/merged by the layout analysis).
    let found = await findMrzLines(raw);
    if (!found.mrzLines.length) found = (await findMrzInBottomStrip(found.page, found.info)) || found;
    const { page, info, lines, mrzLines } = found;
    if (mrzLines.length) {
      const sorted = mrzLines.sort((a, b) => a.bbox.y0 - b.bbox.y0).slice(-3);
      const bbox = {
        x0: Math.min(...sorted.map((l) => l.bbox.x0)),
        y0: Math.min(...sorted.map((l) => l.bbox.y0)),
        x1: Math.max(...sorted.map((l) => l.bbox.x1)),
        y1: Math.max(...sorted.map((l) => l.bbox.y1)),
      };
      // A single detected line: widen the window to catch its partner.
      if (sorted.length === 1) {
        const h = bbox.y1 - bbox.y0;
        bbox.y0 -= h * 1.8;
        bbox.y1 += h * 1.8;
      }
      const region = await readRegion(page, info, bbox);
      // The page-level reading is a further independent vote.
      const direct = pickLines(lines.map((l) => l.text));
      const decided = decide([...region, ...(direct ? [direct] : [])]);
      const weight = (r) => r.rank + (r.confidence === 'high' ? 10 : 0);
      if (decided && (!best || weight(decided) > weight(best))) best = { ...decided, rotation };
      if (best?.confidence === 'high') return best;
    }
    // Upright page with a mostly-verified MRZ: other rotations won't help.
    // (A low score at 0° is usually junk read off a sideways page.)
    if (best && best.score >= 3 && rotation === 0) break;
  }
  return best;
}

module.exports.readMrz = readMrz;

/**
 * All the text on one page (letters, digits and "<" only), turned by
 * `rotation` first — used to look for the passport number on the back page
 * (passportBackCheck.service.js).
 */
async function readPageText(buffer, rotation = 0) {
  const { data } = await prepared(buffer, rotation);
  const { text } = await ocr(data, PSM.AUTO);
  return text;
}

module.exports.readPageText = readPageText;
// exported for tests
module.exports.correctLine1 = correctLine1;
module.exports.correctLine2 = correctLine2;
// internals, for tests
module.exports._internals = { ocr, inkMap, shapeCorrectLine, cellIsChevron, PSM };
