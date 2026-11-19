const crypto = require('node:crypto');

const bcrypt = require('bcryptjs');

// Agent passwords: the generated sign-up password, the password policy, and a
// couple of helpers used by the password login / reset / change flows
// (controllers/passwordAuth.controller.js). Hashing itself stays in
// auth.service.js (hashPassword / comparePassword) — bcrypt, as the admin
// console's passwords already are.

// Sign-up password emailed to a new agent: "Xclusive@" + a random 5-digit
// number (10000–99999, so always five digits), e.g. Xclusive@48213. Drawn
// from crypto.randomInt, not Math.random.
function generateAgentPassword() {
  return `Xclusive@${crypto.randomInt(10000, 100000)}`;
}

module.exports.generateAgentPassword = generateAgentPassword;

// What a password an agent chooses themselves has to satisfy. Kept to rules
// that are easy to state in one line ("8–64 characters, with a letter and a
// number"); 64 is well under bcrypt's 72-byte input limit, so nothing is
// silently truncated. The generated sign-up password passes this too.
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 64;
const PASSWORD_RULE_TEXT = `Use ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters, including at least one letter and one number.`;

function passwordPolicyError(password) {
  if (typeof password !== 'string') return PASSWORD_RULE_TEXT;
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return PASSWORD_RULE_TEXT;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return PASSWORD_RULE_TEXT;
  return null;
}

module.exports.PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
module.exports.PASSWORD_MAX_LENGTH = PASSWORD_MAX_LENGTH;
module.exports.PASSWORD_RULE_TEXT = PASSWORD_RULE_TEXT;
module.exports.passwordPolicyError = passwordPolicyError;

// A real bcrypt hash of a throwaway value. Login compares against it when the
// email doesn't exist (or the account has no password), so "unknown email"
// and "wrong password" cost the same time — otherwise response time would
// reveal which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

module.exports.DUMMY_PASSWORD_HASH = DUMMY_PASSWORD_HASH;

// Password sign-in lockout: this many wrong passwords in a row lock password
// sign-in for this long (email-code sign-in keeps working).
module.exports.MAX_FAILED_PASSWORD_ATTEMPTS = 5;
module.exports.PASSWORD_LOCK_MINUTES = 15;

// "Forgot password" link lifetime and abuse limits.
module.exports.RESET_LINK_MINUTES = 30;
module.exports.RESET_MIN_SECONDS_BETWEEN = 60;
module.exports.RESET_MAX_PER_HOUR = 5;
