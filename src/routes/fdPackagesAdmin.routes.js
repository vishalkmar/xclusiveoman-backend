const {
  Router
} = require('express');

const fdAdmin = require('../controllers/fdPackagesAdmin.controller.js');

const {
  requireAuth,
  requireRole,
  requireFeature,
  STAFF_ROLES
} = require('../middleware/auth.js');

const {
  upload
} = require('../middleware/upload.js');

const {
  validateBody,
  fdPackageSchema,
  fdDepartureDateSchema,
  fdAddonSchema,
  fdItinerarySchema
} = require('../validation/schemas.js');

const {
  z
} = require('zod');

const router = Router();

// FD Packages are part of the Product Catalog (admin/pages/ProductCatalog.jsx
// groups them together) — same requireFeature('catalog') gate as
// catalog.routes.js's adminCatalogRouter, its own doc comment.
router.use(requireAuth, requireRole(...STAFF_ROLES), requireFeature('catalog'));

router.get('/', fdAdmin.list);
router.get('/:id', fdAdmin.get);
router.post('/', validateBody(fdPackageSchema), fdAdmin.create);
router.patch('/:id', validateBody(fdPackageSchema.partial()), fdAdmin.update);
router.get('/:id/delete-impact', fdAdmin.deleteImpact);
router.delete('/:id', fdAdmin.remove);
router.post('/:id/hero-image', upload.single('image'), fdAdmin.uploadHeroImage);
router.post('/:id/images', upload.array('images', 10), fdAdmin.uploadImages);
// The image URL goes in the body: an encoded URL in the path carries %2F, which
// Apache (AllowEncodedSlashes Off) rejects with a 404 before Node sees it —
// browsers then report the failed preflight as a CORS error. The :url route is
// kept for older cached frontends.
router.post('/:id/images/remove', validateBody(z.object({ url: z.string().min(1).max(2000) })), fdAdmin.deleteImage);
router.delete('/:id/images/:url', fdAdmin.deleteImage);

// Same day/notes/items shape as the Custom FIT itinerary (see
// itinerarySchema in schemas.js), plus FD-only leisure days (fdItinerarySchema) — the builder now
// mirrors the agent Custom FIT Builder's per-day hotel/tour/transfer/extra
// pickers instead of a single free-text line per day.
router.put('/:id/itinerary', validateBody(z.object({ days: fdItinerarySchema })), fdAdmin.putItinerary);

router.post('/:id/departure-dates', validateBody(fdDepartureDateSchema), fdAdmin.postDepartureDate);
router.delete('/:id/departure-dates/:dateId', fdAdmin.deleteDepartureDate);

router.post('/:id/addons', validateBody(fdAddonSchema), fdAdmin.postAddon);
router.delete('/:id/addons/:addonId', fdAdmin.deleteAddon);

module.exports = router;
