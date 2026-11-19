-- Admin console "Email verification" second factor (Security screen), the
-- sibling of the authenticator-app toggle from 0076_admin_2fa.sql. Same
-- GLOBAL shape: one inbox, set by a super_admin, receives the code for every
-- admin-console sign-in. email_2fa_pending_address holds the address being
-- enrolled until a code sent to it is confirmed — only then is it copied to
-- email_2fa_address and the flag flipped on.
ALTER TABLE admin_security
  ADD COLUMN email_2fa_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN email_2fa_address VARCHAR(255) NULL,
  ADD COLUMN email_2fa_pending_address VARCHAR(255) NULL,
  ADD COLUMN email_2fa_activated_at DATETIME NULL;

-- One row per code sent. `purpose` separates the three uses — 'enroll'
-- (proving the new inbox is reachable), 'disable' (confirming turn-off from
-- the current inbox) and 'login' (the second factor itself) — so a code
-- emailed for one can never be spent on another. Same hash/expiry/attempt
-- model as login_otps.
CREATE TABLE admin_mfa_email_codes (
  id CHAR(36) PRIMARY KEY,
  purpose VARCHAR(16) NOT NULL,
  user_id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_mfa_email_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_admin_mfa_email_codes_lookup ON admin_mfa_email_codes(purpose, user_id, created_at);
