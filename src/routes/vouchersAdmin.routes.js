const { Router } = require('express');
const { requireAuth, requireRole, STAFF_ROLES } = require('../middleware/auth.js');
const { upload } = require('../middleware/upload.js');
const controller = require('../controllers/vouchersAdmin.controller.js');
const router = Router();
router.use(requireAuth, requireRole(...STAFF_ROLES));
router.get('/', controller.list);
router.post('/', controller.create);
// Logo / stamp image upload for the voucher template (returns a Cloudinary URL).
router.post('/assets', upload.single('image'), controller.uploadAsset);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);
module.exports = router;
