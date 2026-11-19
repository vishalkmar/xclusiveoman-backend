const { Router } = require('express');

const { upload } = require('../middleware/upload.js');
const { publicReadLimiter, publicUploadLimiter } = require('../middleware/rateLimiter.js');
const handoff = require('../controllers/visaPhotoHandoff.controller.js');

// "Scan with phone" — the traveller's phone, no login. Deliberately public
// (no requireAuth), like itineraryPdfData.routes.js: the single-use,
// short-lived token in the URL is the only key, and it reaches exactly one
// traveller's photo (visaPhotoHandoff.controller.js). Mounted at
// /api/visa-photo-handoff.
const router = Router();

router.get('/:token', publicReadLimiter, handoff.getHandoffByToken);
router.post('/:token/photo', publicUploadLimiter, upload.fields([{ name: 'photo', maxCount: 1 }]), handoff.postHandoffPhoto);

module.exports = router;
