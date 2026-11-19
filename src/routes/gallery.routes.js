const { Router } = require('express');
const controller = require('../controllers/gallery.controller.js');
const { upload } = require('../middleware/upload.js');
const { requireAuth, requireRole, requireFeature, STAFF_ROLES } = require('../middleware/auth.js');

const {
  publicReadLimiter
} = require('../middleware/rateLimiter.js');

const publicRouter = Router();
publicRouter.get('/', publicReadLimiter, controller.list);

const adminRouter = Router();
// Team roles (sales / relationship managers) need the Catalog feature, the
// same switch that gates the rest of catalog editing.
adminRouter.use(requireAuth, requireRole(...STAFF_ROLES), requireFeature('catalog'));
adminRouter.get('/', controller.list);
adminRouter.post('/', controller.create);
adminRouter.post('/image', upload.single('image'), controller.uploadImage);
adminRouter.patch('/:id', controller.update);
adminRouter.delete('/:id', controller.remove);

module.exports = { publicRouter, adminRouter };
