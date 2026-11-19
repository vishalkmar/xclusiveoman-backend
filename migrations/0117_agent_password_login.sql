-- Agent password login (email + password alongside the email-code login),
-- forgot/reset password, and change/create password from the Profile.
--
-- users.password_hash already exists (0084_admin_password.sql, bcrypt) — this
-- adds what a public password login needs on top of it:
--   password_failed_attempts / password_locked_until — per-account brute-force
--     lockout (the password space of the generated sign-up passwords is small,
--     so per-IP limits alone aren't enough); 5 wrong passwords lock password
--     sign-in for 15 minutes, email-code sign-in is unaffected.
--   password_changed_at — when the password was last set/changed.
-- password_resets holds single-use "forgot password" links: only a SHA-256 of
-- the emailed token is stored, so a database leak can't be used to reset
-- anyone's password.
ALTER TABLE users
  ADD COLUMN password_failed_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN password_locked_until DATETIME NULL,
  ADD COLUMN password_changed_at DATETIME NULL;

CREATE TABLE password_resets (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_password_resets_token_hash (token_hash),
  KEY idx_password_resets_user (user_id, created_at),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
