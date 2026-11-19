const sharp = require('sharp');

const { env } = require('../config/env.js');
const { generateJson, isAiConfigured, toGeminiImagePart } = require('./gemini.service.js');

// Visa applicant photo verification. Runs in two layers:
//   1. Image checks with sharp (always): resolution, clarity (sharpness),
//      brightness. Deterministic, no network.
//   2. AI checks with Google Gemini's free tier (when GEMINI_API_KEY is set):
//      exactly one face, centred and facing the camera, eyes open, close
//      enough to the camera, full face visible, no sunglasses/hat, facial
//      details clear (AI clarity score >= MIN_AI_CLARITY). (A camera scan only captures once every live check has
//      stayed green for 4 seconds — there is no blink/liveness frame.)
// The browser's own live checks (MediaPipe, client report) are stored for
// reference but never trusted on their own.
//
// Result status:
//   approved     - every check passed, including the AI layer
//   needs_review - image checks passed but the AI layer couldn't run (no key,
//                  API down) — saved, staff verify by eye
//   rejected     - a check failed; nothing is saved, the agent retakes

// Portrait (7:9, passport-photo shape). A 720p webcam's scan crop comes out
// at 560 × 720, so this still accepts ordinary laptop cameras while
// rejecting tiny/low-res images.
const MIN_WIDTH = 480;
const MIN_HEIGHT = 600;
// Sharpness has no high fixed target: laptop webcams are soft even when in
// focus and rarely score near 100. Only photos too blurred to make out the
// face are refused — MIN_SHARPNESS is the same floor the browser scan uses
// (agent/lib/faceScan.js CLARITY_FLOOR); there the scan also waits until
// the picture is as sharp as that camera gets before capturing.
const MIN_SHARPNESS = 15;
// The AI's 0-100 "facial details clear" score: below this the eyes, nose
// and mouth can't be made out properly.
const MIN_AI_CLARITY = 50;
// Laplacian variance of the centre (face) region, downscaled to 384px wide,
// that counts as 100% clear. Calibrated on a real portrait: crisp = ~370,
// barely-visible blur (sigma 0.6) = ~90 (82%), noticeable blur (sigma 1) =
// ~50 (45%), heavy blur = ~10 (9%, refused).
const CLARITY_REFERENCE_VARIANCE = 110;
const MIN_BRIGHTNESS = 60;
const MAX_BRIGHTNESS = 210;

function check(key, label, passed, detail) {
  return { key, label, passed: !!passed, detail: detail || null };
}

// Variance of the Laplacian (edge strength) over raw greyscale pixels —
// computed by hand because sharp's convolve() clips/normalises the
// zero-sum kernel and barely reacts to blur.
function laplacianVariance(data, w, h) {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

async function analyseImage(buffer) {
  const oriented = await sharp(buffer, { failOn: 'error' }).rotate().toBuffer();
  const { width, height } = await sharp(oriented).metadata();

  // Centre region = where the face sits in a guided scan / passport photo,
  // so a soft background doesn't drag the clarity score down.
  const { data, info } = await sharp(oriented)
    .extract({
      left: Math.round(width * 0.2),
      top: Math.round(height * 0.15),
      width: Math.round(width * 0.6),
      height: Math.round(height * 0.6),
    })
    .resize({ width: 384 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let total = 0;
  for (let i = 0; i < data.length; i += 1) total += data[i];

  const variance = laplacianVariance(data, info.width, info.height);
  return {
    width,
    height,
    brightness: Math.round(total / data.length),
    clarity: Math.min(100, Math.round((variance / CLARITY_REFERENCE_VARIANCE) * 100)),
  };
}

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    faceCount: { type: 'INTEGER' },
    faceCentered: { type: 'BOOLEAN' },
    facingCamera: { type: 'BOOLEAN' },
    eyesOpen: { type: 'BOOLEAN' },
    faceDistance: { type: 'STRING', enum: ['too_far', 'ok', 'too_close'] },
    fullFaceVisible: { type: 'BOOLEAN' },
    obstructions: { type: 'BOOLEAN' },
    evenLighting: { type: 'BOOLEAN' },
    clarityScore: { type: 'INTEGER' },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: [
    'faceCount',
    'faceCentered',
    'facingCamera',
    'eyesOpen',
    'faceDistance',
    'fullFaceVisible',
    'obstructions',
    'evenLighting',
    'clarityScore',
    'issues',
  ],
};

function buildPrompt() {
  return [
    'You are verifying a passport/visa application photo. Image 1 is the photo to verify.',
    'Return JSON only, judged strictly as a visa office would:',
    '- faceCount: number of human faces in image 1.',
    '- faceCentered: the face is horizontally and vertically centred in the frame.',
    '- facingCamera: head is straight and looking directly at the camera (not turned or tilted).',
    '- eyesOpen: both eyes clearly open and visible in image 1.',
    '- faceDistance: "too_far" if the face is small in the frame (head under ~45% of image height), "too_close" if the head is cut off or fills nearly the whole frame, else "ok".',
    '- fullFaceVisible: whole face from top of head to chin and both sides of the face are visible and not cropped.',
    '- obstructions: true if sunglasses, a hat/cap, mask, hand, hair or anything else covers the eyes or face.',
    '- evenLighting: face evenly lit, no strong shadows, glare or over/under-exposure.',
    `- clarityScore: 0-100, how clearly the facial details (eyes, nose, mouth) can be made out (100 = perfectly sharp; an ordinary laptop or phone camera photo that is in focus scores 60-90; below ${MIN_AI_CLARITY} = too blurry, smeared or pixelated to make out the features).`,
    '- issues: short, plain-English problems an agent should fix (empty if none).',
  ].join('\n');
}

async function runAiCheck(photoBuffer) {
  if (!isAiConfigured()) return { ran: false, reason: 'AI verification is not configured (GEMINI_API_KEY or GROQ_API_KEY).' };
  const parts = [{ text: buildPrompt() }, await toGeminiImagePart(photoBuffer, 768)];
  const timeoutMs = Number.parseInt(process.env.GEMINI_PHOTO_TIMEOUT_MS || '20000', 10);
  return generateJson({
    parts,
    schema: AI_SCHEMA,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
    logTag: 'visaPhotoCheck',
  });
}

/**
 * @param {object} args
 * @param {Buffer} args.photoBuffer   the photo to verify (eyes open)
 * @param {'camera'|'upload'} args.source
 * @param {object} [args.clientReport] the browser's own live-check results
 */
async function checkVisaPhoto({ photoBuffer, source, clientReport }) {
  const checks = [];

  let image;
  try {
    image = await analyseImage(photoBuffer);
  } catch {
    return {
      status: 'rejected',
      checks: [check('readable', 'Image readable', false, 'This file could not be read as an image.')],
      issues: ['This file could not be read as an image. Take or upload the photo again.'],
    };
  }

  checks.push(
    check(
      'resolution',
      'Resolution',
      image.width >= MIN_WIDTH && image.height >= MIN_HEIGHT,
      `${image.width} × ${image.height} px (minimum ${MIN_WIDTH} × ${MIN_HEIGHT})`
    ),
    check('sharpness', 'Image sharpness', image.clarity >= MIN_SHARPNESS, image.clarity >= MIN_SHARPNESS ? 'OK' : 'Too blurry — hold still and retake'),
    check(
      'brightness',
      'Brightness',
      image.brightness >= MIN_BRIGHTNESS && image.brightness <= MAX_BRIGHTNESS,
      image.brightness < MIN_BRIGHTNESS ? 'Too dark' : image.brightness > MAX_BRIGHTNESS ? 'Too bright' : 'OK'
    )
  );

  const ai = await runAiCheck(photoBuffer);
  if (ai.ran) {
    const r = ai.result;
    checks.push(
      check('single_face', 'Exactly one face', r.faceCount === 1, `${r.faceCount} face(s) found`),
      check('centered', 'Face centred', r.faceCentered),
      check('facing', 'Looking straight at camera', r.facingCamera),
      check('eyes_open', 'Eyes open', r.eyesOpen),
      check(
        'distance',
        'Distance from camera',
        r.faceDistance === 'ok',
        r.faceDistance === 'too_far' ? 'Move closer' : r.faceDistance === 'too_close' ? 'Move back' : 'OK'
      ),
      check('full_face', 'Full face visible', r.fullFaceVisible),
      check('no_obstructions', 'Nothing covering the face', !r.obstructions),
      check('lighting', 'Even lighting', r.evenLighting),
      check('clarity', 'Facial details clear', r.clarityScore >= MIN_AI_CLARITY, r.clarityScore >= MIN_AI_CLARITY ? 'OK' : 'Too blurry — hold still and retake')
    );
  }

  const failed = checks.filter((c) => !c.passed);
  const issues = [
    ...failed.map((c) => (c.detail && c.detail !== 'OK' ? `${c.label}: ${c.detail}` : `${c.label} check failed`)),
    ...(ai.ran ? ai.result.issues || [] : []),
  ];

  return {
    status: failed.length ? 'rejected' : ai.ran ? 'approved' : 'needs_review',
    checks,
    issues: [...new Set(issues)],
    clarity: ai.ran ? Math.min(image.clarity, ai.result.clarityScore) : image.clarity,
    image: { width: image.width, height: image.height, brightness: image.brightness, clarity: image.clarity },
    ai: ai.ran ? { provider: ai.provider || 'gemini', model: ai.model || env.gemini.model, result: ai.result } : { skipped: true, reason: ai.reason },
    source,
    clientReport: clientReport || null,
    checkedAt: new Date().toISOString(),
  };
}

module.exports.checkVisaPhoto = checkVisaPhoto;
