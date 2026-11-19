-- Cashfree charges in INR while the portal prices everything in OMR
-- (0107_currency_omr.sql). payments.amount stays the OMR amount credited to
-- the booking; these columns record what was actually sent to the gateway.
--   gateway_currency     — currency the Cashfree order was opened in (INR).
--   gateway_amount       — order_amount sent to Cashfree, in gateway_currency.
--   fx_rate              — gateway_currency units per 1 OMR, locked when the
--                          order was created (from the external FX API).
--   gateway_amount_paid  — amount Cashfree reported as paid, in
--                          gateway_currency; converted back to OMR with
--                          fx_rate on confirmation.
-- All NULL for NEFT/credit-terms rows and Cashfree rows created before this.
ALTER TABLE payments
  ADD COLUMN gateway_currency CHAR(3) NULL,
  ADD COLUMN gateway_amount DECIMAL(14,2) NULL,
  ADD COLUMN fx_rate DECIMAL(18,8) NULL,
  ADD COLUMN gateway_amount_paid DECIMAL(14,2) NULL;
