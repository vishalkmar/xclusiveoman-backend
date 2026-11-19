const {
  Router
} = require('express');

const paymentsController = require('../controllers/payments.controller.js');
const packageController = require('../controllers/packageController.controller.js');
const visaAdminController = require('../controllers/visaAdmin.controller.js');
const visaPaymentsController = require('../controllers/visaPayments.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const {
  upload
} = require('../middleware/upload.js');

const {
  validateBody,
  visaPriceSchema
} = require('../validation/schemas.js');

const {
  z
} = require('zod');

const createOrderSchema = z.object({
  bookingId: z.string().uuid(),
  amount: z.number().positive(),
  // Per-"Pay"-click idempotency key minted by the frontend and replayed on
  // network retry (spec C). Optional so the endpoint stays backward
  // compatible; the agent portal always sends it.
  clientAttemptToken: z.string().uuid().optional(),
});

// Agent-facing (doc §12.9), mounted at /api/payments.
const {
  paymentLimiter
} = require('../middleware/rateLimiter.js');

const router = Router();
router.use(requireAuth, requireRole('agency_owner', 'agency_staff'));

router.post('/cashfree/create-order', paymentLimiter, validateBody(createOrderSchema), paymentsController.createCashfreeOrder);
// Reconciliation / polling (spec G, I). `by-order` is declared before the
// `/:id` param route so it isn't captured as an id.
router.get('/by-order/:orderId', paymentsController.getPaymentByOrder);
router.get('/:id', paymentsController.getPaymentStatus);
router.post('/:id/abort', paymentsController.abortPayment);
router.post('/:bookingId/neft-slip', paymentLimiter, upload.single('slip'), paymentsController.uploadNeftSlip);

module.exports = router;
const adminPaymentsRouter = Router();
module.exports.adminPaymentsRouter = adminPaymentsRouter;
adminPaymentsRouter.use(requireAuth, requireRole('finance', 'ops_admin', 'super_admin'));

adminPaymentsRouter.get('/neft-verifications', paymentsController.getNeftPending);

// Visa fee payments: Transaction Ledger rows, NEFT slips to verify.
adminPaymentsRouter.get('/visa-payments', visaPaymentsController.adminListVisaPayments);
adminPaymentsRouter.get('/visa-payments/neft-pending', visaPaymentsController.adminNeftPending);
adminPaymentsRouter.post(
  '/visa-payments/:id/verify',
  validateBody(z.object({ approve: z.boolean(), reason: z.string().trim().max(500).optional() })),
  visaPaymentsController.adminVerifyNeft
);
adminPaymentsRouter.post('/payments/:id/verify', paymentsController.verifyNeftPayment);
adminPaymentsRouter.get('/transactions', paymentsController.getAllTransactions);

// Payments → Package Controller: FD pre-booking (deposit) rules.
const prebookingPercentage = z.number().gt(0).max(100);
adminPaymentsRouter.get('/package-controller', packageController.get);
adminPaymentsRouter.put(
  '/package-controller/settings',
  validateBody(z.object({
    enabled: z.boolean(),
    percentage: prebookingPercentage,
  })),
  packageController.updateSettings
);
adminPaymentsRouter.put(
  '/package-controller/platform-fee/settings',
  validateBody(z.object({ enabled: z.boolean(), percentage: z.number().min(0).max(100) })),
  packageController.updatePlatformFeeSettings
);
const packagePrebookingSchema = z.object({
  mode: z.enum(['global', 'none', 'custom']),
  percentage: prebookingPercentage.nullable().optional(),
});
const needsCustomPercentage = [
  (b) => b.mode !== 'custom' || b.percentage != null,
  { message: 'A custom pre-booking needs a percentage', path: ['percentage'] },
];
adminPaymentsRouter.patch(
  '/package-controller/packages',
  validateBody(
    packagePrebookingSchema
      .extend({ ids: z.array(z.string().min(1)).min(1).max(500) })
      .refine(...needsCustomPercentage)
  ),
  packageController.updatePackages
);
adminPaymentsRouter.patch(
  '/package-controller/packages/:id',
  validateBody(packagePrebookingSchema.refine(...needsCustomPercentage)),
  packageController.updatePackage
);

const packagePlatformFeeBaseSchema = z.object({
  mode: z.enum(['global', 'none', 'custom']),
  percentage: z.number().min(0).max(100).nullable().optional(),
});
const needsCustomPlatformFeePercentage = [
  (b) => b.mode !== 'custom' || b.percentage != null,
  { message: 'A custom platform fee needs a percentage', path: ['percentage'] },
];
const packagePlatformFeeSchema = packagePlatformFeeBaseSchema.refine(...needsCustomPlatformFeePercentage);
adminPaymentsRouter.patch(
  '/package-controller/platform-fee/packages',
  validateBody(packagePlatformFeeBaseSchema.extend({ ids: z.array(z.string().min(1)).min(1).max(500) }).refine(...needsCustomPlatformFeePercentage)),
  packageController.updatePackagesPlatformFee
);
adminPaymentsRouter.patch('/package-controller/platform-fee/packages/:id', validateBody(packagePlatformFeeSchema), packageController.updatePackagePlatformFee);

// Package Controller → Visa tab: the single per-person visa price for every
// visa type/category (the only place it's set — visaPricing.service.js).
adminPaymentsRouter.get('/package-controller/visa', visaAdminController.getVisaPricing);
adminPaymentsRouter.put('/package-controller/visa', validateBody(visaPriceSchema), visaAdminController.putVisaPrice);
adminPaymentsRouter.put('/package-controller/visa/:id', validateBody(z.object({ priceMode: z.enum(['global', 'custom']).optional(), priceMethod: z.enum(['global', 'custom']).optional(), customPrice: z.number().positive().max(100000).nullable().optional() }).refine((v) => v.priceMode || v.priceMethod, 'Choose a price method')), visaAdminController.putVisaPackagePrice);
