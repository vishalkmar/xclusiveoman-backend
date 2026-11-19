const {
  Router
} = require('express');

const authController = require('../controllers/auth.controller.js');
const passwordAuthController = require('../controllers/passwordAuth.controller.js');

const {
  requireAuth,
  requireRole
} = require('../middleware/auth.js');

const {
  otpRequestLimiter,
  otpVerifyLimiter,
  mfaVerifyLimiter,
  adminLoginLimiter,
  registrationLimiter,
  publicUploadLimiter,
  refreshLimiter,
  passwordLoginLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  changePasswordLimiter
} = require('../middleware/rateLimiter.js');

const {
  upload
} = require('../middleware/upload.js');

const {
  validateBody,
  registerSchema,
  requestOtpSchema,
  verifyOtpSchema,
  verifyMfaSchema,
  mfaTokenSchema,
  adminLoginSchema,
  agentLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
} = require('../validation/schemas.js');

const router = Router();

// Public, unauthenticated — mirrors register itself, which also runs before
// any account exists. Must be registered ahead of the Sign Up form's final
// submit so the resulting URL can be included in the /register JSON body
// (registerSchema now requires licenseDocumentUrl).
router.post('/register/license-document', publicUploadLimiter, upload.single('licenseDocument'), authController.uploadLicenseDocument);
// Optional company logo — same flow, images only.
router.post('/register/logo', publicUploadLimiter, upload.single('logo'), authController.uploadRegistrationLogo);
router.post('/register', registrationLimiter, validateBody(registerSchema), authController.register);
// Email OTP is Agent/Team's sign-in mechanism (otpRequestLimiter runs before
// validateBody so a flood of malformed bodies is throttled too, not just
// well-formed ones). Agents can also sign in with a password
// (users.password_hash, 0084/0117): agent-login below, with forgot/reset
// password and change/create password from the Profile.
router.post('/request-otp', otpRequestLimiter, validateBody(requestOtpSchema), authController.requestLoginOtp);
router.post('/verify-otp', otpVerifyLimiter, validateBody(verifyOtpSchema), authController.verifyLoginOtp);
// Admin console 2FA step 3 (only reached when the global authenticator
// toggle is on) — reachable from either verify-otp above or admin-login
// below. mfaVerifyLimiter throttles brute-forcing the 6-digit code by IP,
// same posture otpRequestLimiter takes on the send step above.
router.post('/verify-mfa', mfaVerifyLimiter, validateBody(verifyMfaSchema), authController.verifyLoginMfa);
// Sends (or resends) the admin email-verification code for the pending
// sign-in carried by mfaToken. Same per-IP throttle as request-otp.
router.post('/mfa/email', otpRequestLimiter, validateBody(mfaTokenSchema), authController.sendLoginMfaEmail);
// Admin Console login — email + a per-account bcrypt password
// (users.password_hash, 0084_admin_password.sql), not OTP. adminLoginLimiter
// throttles brute-forcing by IP, same posture as the two limiters above.
router.post('/admin-login', adminLoginLimiter, validateBody(adminLoginSchema), authController.adminLogin);
router.post('/refresh', refreshLimiter, authController.refresh);

// Agent password sign-in + recovery (controllers/passwordAuth.controller.js).
// Public: agent-login, forgot-password, reset-password. change-password needs
// a signed-in agency user.
router.post('/agent-login', passwordLoginLimiter, validateBody(agentLoginSchema), passwordAuthController.agentLogin);
router.post('/forgot-password', forgotPasswordLimiter, validateBody(forgotPasswordSchema), passwordAuthController.forgotPassword);
router.post('/reset-password', resetPasswordLimiter, validateBody(resetPasswordSchema), passwordAuthController.resetPassword);
router.post(
  '/change-password',
  requireAuth,
  requireRole('agency_owner', 'agency_staff'),
  changePasswordLimiter,
  validateBody(changePasswordSchema),
  passwordAuthController.changePassword
);
router.post('/logout', requireAuth, authController.logout);
router.get('/me', requireAuth, authController.me);

module.exports = router;
