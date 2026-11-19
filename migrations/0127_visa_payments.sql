-- Visa fee payments. Agents pay the visa fee (price per person × travellers)
-- when they submit a visa application — by Cashfree (instant) or by NEFT
-- slip (verified by finance in NEFT Verification). Kept apart from the
-- booking `payments` table: those are tied to bookings (booking_id NOT NULL,
-- seat holds, deposits), visa payments to visa applications.
--
-- Status: pending -> awaiting_payment -> confirmed | failed | cancelled
--         (Cashfree), pending_verification -> confirmed | rejected (NEFT).
-- Amounts are OMR (3 decimals); a Cashfree charge is made in INR at the rate
-- locked when the order opened (gateway_* / fx_rate), like booking payments.
CREATE TABLE visa_payments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  agency_id CHAR(36) NOT NULL,
  created_by_user_id CHAR(36) NOT NULL,
  amount DECIMAL(12,3) NOT NULL,
  price_per_person DECIMAL(12,3) NOT NULL,
  travellers INT NOT NULL,
  method VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  cashfree_order_id VARCHAR(120),
  cashfree_payment_id VARCHAR(120),
  gateway_currency VARCHAR(3),
  gateway_amount DECIMAL(14,2),
  gateway_amount_paid DECIMAL(14,2),
  fx_rate DECIMAL(18,8),
  neft_slip_url TEXT,
  neft_reference VARCHAR(120),
  verified_by_user_id CHAR(36),
  verified_at DATETIME,
  rejection_reason TEXT,
  paid_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_visa_payments_cashfree_order (cashfree_order_id),
  KEY idx_visa_payments_status (status),
  KEY idx_visa_payments_paid_at (paid_at),
  CONSTRAINT fk_visa_payments_application FOREIGN KEY (application_id) REFERENCES visa_applications(id),
  CONSTRAINT fk_visa_payments_agency FOREIGN KEY (agency_id) REFERENCES agencies(id),
  CONSTRAINT fk_visa_payments_user FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  CONSTRAINT fk_visa_payments_verified_by FOREIGN KEY (verified_by_user_id) REFERENCES users(id),
  CONSTRAINT chk_visa_payments_method CHECK (method IN ('cashfree', 'neft')),
  CONSTRAINT chk_visa_payments_status CHECK (
    status IN ('pending', 'awaiting_payment', 'confirmed', 'failed', 'cancelled', 'pending_verification', 'rejected')
  )
);

-- What was paid, and when the application was submitted (paid). Status then
-- moves draft -> payment_review (NEFT slip waiting) -> submitted (paid).
ALTER TABLE visa_applications
  ADD COLUMN paid_amount DECIMAL(12,3) NULL,
  ADD COLUMN paid_at DATETIME NULL,
  ADD COLUMN submitted_at DATETIME NULL;
