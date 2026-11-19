const multer = require('multer');

const {
  uploadLimiter
} = require('./rateLimiter.js');

// File uploads. Files are held in memory (never written to this server's
// disk, so there's no path to traverse or file to execute) and handed to
// Cloudinary under server-generated names (services/cloudinary.service.js).
//
// Every upload route gets, in order:
//   1. uploadLimiter — per-account (or per-IP when signed out) upload cap;
//   2. multer — size limit, file/field count limits, and a MIME allow-list;
//   3. verifyFileSignatures — the MIME type is just a label the browser
//      sends, so the file's first bytes are checked against it too: a file
//      claiming to be a PNG must actually start like a PNG.
// `upload.single(...)` etc. return that chain as an array, which Express
// accepts anywhere a middleware is expected, so routes use them unchanged.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LIMITS = { fileSize: MAX_FILE_BYTES, files: 20, fields: 50, fieldSize: 100 * 1024, parts: 80 };

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Support chat voice notes. Browsers label MediaRecorder output with codec
// parameters ("audio/webm;codecs=opus"), and Chrome/Firefox sometimes call a
// WebM/Ogg recording "video/…", so only the base type is checked.
const AUDIO_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
  'video/webm',
  'video/ogg',
]);

function baseType(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

function startsWith(buf, bytes, offset = 0) {
  if (!buf || buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// Magic-byte checks per declared type.
const SIGNATURES = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  'application/pdf': (b) => startsWith(b, ascii('%PDF-')),
  'audio/webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  'video/webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/ogg': (b) => startsWith(b, ascii('OggS')),
  'video/ogg': (b) => startsWith(b, ascii('OggS')),
  'audio/mpeg': (b) => startsWith(b, ascii('ID3')) || (b?.[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/mp4': (b) => startsWith(b, ascii('ftyp'), 4),
  'audio/x-m4a': (b) => startsWith(b, ascii('ftyp'), 4),
  'audio/aac': (b) => (b?.[0] === 0xff && (b[1] & 0xf6) === 0xf0) || startsWith(b, ascii('ID3')),
  'audio/wav': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8),
  'audio/x-wav': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8),
};

function collectFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
  return [];
}

function verifyFileSignatures(req, res, next) {
  for (const file of collectFiles(req)) {
    const check = SIGNATURES[baseType(file.mimetype)];
    if (!check || !check(file.buffer)) {
      return res.status(400).json({
        error: 'upload_rejected',
        message: `${file.originalname || 'File'} doesn't match its file type. Upload a genuine image, PDF or audio file.`,
      });
    }
  }
  next();
}

module.exports.verifyFileSignatures = verifyFileSignatures;

function withChecks(multerInstance) {
  return {
    single: (field) => [uploadLimiter, multerInstance.single(field), verifyFileSignatures],
    array: (field, maxCount) => [uploadLimiter, multerInstance.array(field, maxCount), verifyFileSignatures],
    fields: (fields) => [uploadLimiter, multerInstance.fields(fields), verifyFileSignatures],
  };
}

const imageAndPdfMulter = multer({
  storage: multer.memoryStorage(),
  limits: LIMITS,
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(baseType(file.mimetype))) {
      return cb(Object.assign(new Error('Unsupported file type'), { status: 400 }));
    }
    cb(null, true);
  },
});

module.exports.upload = withChecks(imageAndPdfMulter);

const audioMulter = multer({
  storage: multer.memoryStorage(),
  limits: LIMITS,
  fileFilter(req, file, cb) {
    if (!AUDIO_MIME.has(baseType(file.mimetype))) {
      return cb(Object.assign(new Error('Unsupported audio format'), { status: 400 }));
    }
    cb(null, true);
  },
});

module.exports.audioUpload = withChecks(audioMulter);
