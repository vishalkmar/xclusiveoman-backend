const sharp = require('sharp');
const {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} = require('@zxing/library');

// Reads barcodes on a passport page image (ZXing — on-server, no key, no
// network). The passport's back (address) page carries a 1-D barcode along
// its bottom edge; passportBackCheck.service.js compares what it encodes
// with the passport number read from the front page.
//
// A scan is often the passport lying in a corner of a big white sheet (a
// scanned PDF page), sideways, with a busy security pattern behind the bars.
// So: the white margin is cropped off first (trimPage — the passport page
// itself then fills the image), and the page is tried at 0°/90°/180°/270°,
// as a whole and as enlarged strips along each edge (the barcode runs along
// one edge), each plain and sharpened, with two binarizers (local + global
// contrast). Stops at the first rotation that yields anything.

const FORMATS = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.ITF,
  BarcodeFormat.EAN_13,
  BarcodeFormat.PDF_417,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];

function makeReader() {
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  return reader;
}

const reader = makeReader();

// Crops away a scan's plain margin (white sheet, flatbed lid) so the
// passport page fills the image. Leaves photos that are all content alone.
async function trimPage(buffer) {
  const upright = await sharp(buffer, { failOn: 'none' }).rotate().toBuffer();
  try {
    const { data, info } = await sharp(upright).trim({ threshold: 40 }).toBuffer({ resolveWithObject: true });
    const { width, height } = await sharp(upright).metadata();
    // Only keep a meaningful crop (not a sliver, not nothing).
    if (info.width >= width * 0.15 && info.height >= height * 0.15 && info.width * info.height < width * height * 0.92) return data;
  } catch {
    // trim fails on a uniform image — keep it as it is.
  }
  return upright;
}

module.exports.trimPage = trimPage;

async function decodeImage(pipeline) {
  const { data, info } = await pipeline.greyscale().raw().toBuffer({ resolveWithObject: true });
  const luminance = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  const source = new RGBLuminanceSource(luminance, info.width, info.height);
  for (const Binarizer of [HybridBinarizer, GlobalHistogramBinarizer]) {
    try {
      return reader.decode(new BinaryBitmap(new Binarizer(source))).getText();
    } catch {
      // NotFoundException / checksum — try the next treatment.
    }
  }
  return null;
}

// Whole page, then strips along the bottom / top (the barcode runs along an
// edge; with the page turned 90°/270° the side edges become top/bottom),
// each scaled so the bars are wide enough to read.
const REGIONS = [
  { top: 0, bottom: 1, width: 1800 },
  { top: 0.55, bottom: 1, width: 2400 },
  { top: 0.7, bottom: 1, width: 2800 },
  { top: 0, bottom: 0.45, width: 2400 },
  { top: 0, bottom: 0.3, width: 2800 },
];

/**
 * @param {Buffer} buffer  one page image
 * @returns {Promise<string[]>} the decoded texts (usually one), [] if none
 */
async function readBarcodes(buffer) {
  const upright = await trimPage(buffer);
  const found = new Set();
  for (const rotation of [0, 180, 90, 270]) {
    const turned = await sharp(upright).rotate(rotation).toBuffer({ resolveWithObject: true });
    const { width, height } = turned.info;
    for (const r of REGIONS) {
      const top = Math.round(height * r.top);
      const h = Math.max(1, Math.round(height * (r.bottom - r.top)));
      const region = await sharp(turned.data)
        .extract({ left: 0, top, width, height: Math.min(h, height - top) })
        .resize({ width: r.width, withoutEnlargement: false })
        .toBuffer();
      // Plain, then sharpened + contrast-stretched (cuts through the pattern).
      for (const treat of [(img) => img.normalise(), (img) => img.normalise().sharpen({ sigma: 1.2 }).linear(1.4, -40)]) {
        const text = await decodeImage(treat(sharp(region))).catch(() => null);
        if (text) {
          found.add(text.trim());
          break;
        }
      }
    }
    if (found.size) break;
  }
  return [...found];
}

module.exports.readBarcodes = readBarcodes;
