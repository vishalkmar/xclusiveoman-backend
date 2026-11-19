-- The portal now prices and stores every amount in Omani Rial (OMR) instead of
-- Indian Rupee (INR). Existing values are relabelled, not converted — the
-- numbers already stored are treated as OMR from here on.
--
-- OMR is subdivided into 1,000 baisa, so every money column moves from 2 to 3
-- decimal places. Widening scale only appends a zero, so no stored value is
-- rounded or lost. Each MODIFY restates the column's original NULL/DEFAULT
-- (MySQL replaces the whole definition). liquor_price_per_ml is already
-- DECIMAL(12,4) and is left as-is.
ALTER TABLE agencies
  MODIFY COLUMN credit_limit DECIMAL(12,3);

-- Agencies that chose INR (or never chose) now default to OMR.
UPDATE agencies SET currency_preference = 'OMR'
  WHERE currency_preference IS NULL OR UPPER(currency_preference) = 'INR';

ALTER TABLE hotels
  MODIFY COLUMN price_per_night DECIMAL(12,3),
  MODIFY COLUMN single_price DECIMAL(12,3),
  MODIFY COLUMN double_price DECIMAL(12,3),
  MODIFY COLUMN triple_price DECIMAL(12,3);

ALTER TABLE tours
  MODIFY COLUMN price DECIMAL(12,3),
  MODIFY COLUMN price_sedan DECIMAL(12,3) NULL,
  MODIFY COLUMN price_land_cruiser DECIMAL(12,3) NULL,
  MODIFY COLUMN price_bus_20 DECIMAL(12,3) NULL,
  MODIFY COLUMN price_bus_35 DECIMAL(12,3) NULL,
  MODIFY COLUMN price_bus_50 DECIMAL(12,3) NULL;

ALTER TABLE activities
  MODIFY COLUMN price_per_pax DECIMAL(12,3);

ALTER TABLE transfers
  MODIFY COLUMN price DECIMAL(12,3);

ALTER TABLE meals
  MODIFY COLUMN price_per_person DECIMAL(12,3),
  MODIFY COLUMN price_per_day DECIMAL(12,3),
  MODIFY COLUMN liquor_price_quarter DECIMAL(12,3) NULL,
  MODIFY COLUMN liquor_price_half DECIMAL(12,3) NULL,
  MODIFY COLUMN liquor_price_full DECIMAL(12,3) NULL;

ALTER TABLE visa
  MODIFY COLUMN price_per_person DECIMAL(12,3);

ALTER TABLE flights
  MODIFY COLUMN price DECIMAL(12,3);

ALTER TABLE fd_packages
  MODIFY COLUMN rate_per_pax DECIMAL(12,3);

ALTER TABLE fd_addons
  MODIFY COLUMN price_per_pax DECIMAL(12,3) NOT NULL;

ALTER TABLE bookings
  MODIFY COLUMN total_price DECIMAL(12,3) NOT NULL DEFAULT 0,
  MODIFY COLUMN deposit_paid DECIMAL(12,3) NOT NULL DEFAULT 0,
  MODIFY COLUMN balance_due DECIMAL(12,3) NOT NULL DEFAULT 0,
  MODIFY COLUMN deposit_due DECIMAL(12,3) NOT NULL DEFAULT 0,
  MODIFY COLUMN refund_requested_amount DECIMAL(12,3) NULL;

ALTER TABLE booking_addons
  MODIFY COLUMN price_per_pax DECIMAL(12,3) NOT NULL;

ALTER TABLE payments
  MODIFY COLUMN amount DECIMAL(12,3) NOT NULL;

ALTER TABLE transactions
  MODIFY COLUMN amount DECIMAL(12,3) NOT NULL,
  MODIFY COLUMN total_price DECIMAL(12,3) NOT NULL DEFAULT 0,
  MODIFY COLUMN amount_paid_to_date DECIMAL(12,3) NOT NULL DEFAULT 0;

ALTER TABLE package_requests
  MODIFY COLUMN sell_price DECIMAL(12,3);

ALTER TABLE mice_rfqs
  MODIFY COLUMN net_cost_total DECIMAL(12,3),
  MODIFY COLUMN sell_price DECIMAL(12,3);
