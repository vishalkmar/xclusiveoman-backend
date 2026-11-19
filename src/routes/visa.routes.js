const { Router } = require('express');

const { requireAuth, requireRole } = require('../middleware/auth.js');
const { upload } = require('../middleware/upload.js');
const visa = require('../controllers/visa.controller.js');
const visaAdmin = require('../controllers/visaAdmin.controller.js');
const visaPayments = require('../controllers/visaPayments.controller.js');
const visaProcessing = require('../controllers/visaProcessing.controller.js');
const visaPackages = require('../controllers/visaPackages.controller.js');
const photoHandoff = require('../controllers/visaPhotoHandoff.controller.js');
const { paymentLimiter, handoffLimiter } = require('../middleware/rateLimiter.js');

const {
  validateBody,
  visaTypeSchema,
  visaTypeUpdateSchema,
  visaCategorySchema,
  visaCategoryUpdateSchema,
  visaApplicationCreateSchema,
  visaApplicantNamesSchema,
  visaPassportDetailsSchema,
  visaPackageSchema,
} = require('../validation/schemas.js');

// Agent side — mounted at /api/visa.
const router = Router();
router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

router.get('/types', visa.getTypesWithCategories);

// Visa fee payment (visaPayments.controller.js). `payments/by-order` is
// declared before `payments/:paymentId` so it isn't captured as an id.
router.get('/applications/:id/payment', visaPayments.getPaymentInfo);
router.post('/applications/:id/payment/cashfree', paymentLimiter, visaPayments.startCashfree);
router.post('/applications/:id/payment/neft', paymentLimiter, upload.single('slip'), visaPayments.submitNeftSlip);
router.get('/payments/by-order/:orderId', visaPayments.getVisaPaymentByOrder);
router.get('/payments/:paymentId', visaPayments.getVisaPayment);
router.post('/payments/:paymentId/abort', visaPayments.abortVisaPayment);
router.get('/applications', visa.getApplications);
router.post('/applications', validateBody(visaApplicationCreateSchema), visa.postApplication);
router.get('/applications/:id', visa.getApplication);
router.put('/applications/:id/applicants', validateBody(visaApplicantNamesSchema), visa.putApplicants);
// photo = the verified photo (camera scan or upload).
router.post(
  '/applications/:id/applicants/:applicantId/photo',
  upload.fields([{ name: 'photo', maxCount: 1 }]),
  visa.postApplicantPhoto
);

// Passport: every page image the agent added (front / back / whole-passport
// PDF split into pages in the browser) + meta (JSON: slot/label per page).
router.post(
  '/applications/:id/applicants/:applicantId/passport/scan',
  upload.fields([{ name: 'pages', maxCount: 20 }]),
  visa.postPassportScan
);
// The back page on its own, after the front: kept only when the front
// page's passport number is on it (passportBackCheck.service.js).
router.post(
  '/applications/:id/applicants/:applicantId/passport/back',
  upload.fields([{ name: 'pages', maxCount: 3 }]),
  visa.postPassportBack
);
router.put(
  '/applications/:id/applicants/:applicantId/passport',
  validateBody(visaPassportDetailsSchema),
  visa.putPassportDetails
);
// Remove = delete the images from Cloudinary, then clear the stored data.
router.delete('/applications/:id/applicants/:applicantId/passport', visa.deletePassport);
router.delete('/applications/:id/applicants/:applicantId/photo', visa.deletePhoto);

// "Scan with phone": a QR link the traveller's phone opens without logging in
// (visaPhotoHandoff.controller.js; the phone side is visaPhotoHandoff.routes.js).
router.post('/applications/:id/applicants/:applicantId/photo-handoff', handoffLimiter, photoHandoff.postHandoff);
router.get('/photo-handoffs/:handoffId', photoHandoff.getHandoff);
router.delete('/photo-handoffs/:handoffId', photoHandoff.deleteHandoff);

module.exports = router;

// Admin side — mounted at /api/admin/visa.
const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ops_admin', 'super_admin'));

adminRouter.get('/types', visaAdmin.getTypes);
adminRouter.post('/types', validateBody(visaTypeSchema), visaAdmin.postType);
adminRouter.patch('/types/:id', validateBody(visaTypeUpdateSchema), visaAdmin.patchType);
adminRouter.delete('/types/:id', visaAdmin.removeType);
adminRouter.get('/categories', visaAdmin.getCategories);
adminRouter.post('/categories', validateBody(visaCategorySchema), visaAdmin.postCategory);
adminRouter.patch('/categories/:id', validateBody(visaCategoryUpdateSchema), visaAdmin.patchCategory);
adminRouter.delete('/categories/:id', visaAdmin.removeCategory);

// Visa packages (0129) and the agent Visa page hero image.
adminRouter.get('/packages', visaPackages.getPackages);
// Multipart: the fields + `image` (required on create — visaPackages.controller.js).
adminRouter.post('/packages', upload.single('image'), visaPackages.coercePackageForm, validateBody(visaPackageSchema), visaPackages.postPackage);
adminRouter.put('/packages/:id', upload.single('image'), visaPackages.coercePackageForm, validateBody(visaPackageSchema), visaPackages.putPackage);
adminRouter.delete('/packages/:id', visaPackages.removePackage);
adminRouter.get('/hero', visaPackages.getHero);
adminRouter.post('/hero', upload.single('image'), visaPackages.postHero);
adminRouter.delete('/hero', visaPackages.deleteHero);

// Processing (0128): Visa Status list, Visa Requests (per agency), one
// request, and the per-traveller visa decisions.
adminRouter.get('/applications', visaProcessing.getApplications);
adminRouter.get('/agencies', visaProcessing.getAgencies);
adminRouter.get('/agencies/:agencyId/applications', visaProcessing.getAgencyApplications);
adminRouter.get('/applications/:id', visaProcessing.getApplication);
adminRouter.post('/applications/:id/start', visaProcessing.postStart);
adminRouter.post('/applications/:id/reject', visaProcessing.postRejectApplication);
adminRouter.post('/applications/:id/applicants/:applicantId/visa', upload.single('visa'), visaProcessing.postApplicantVisa);
adminRouter.delete('/applications/:id/applicants/:applicantId/visa', visaProcessing.deleteApplicantVisa);
adminRouter.post('/applications/:id/applicants/:applicantId/reject', visaProcessing.postRejectApplicant);

module.exports.adminRouter = adminRouter;
