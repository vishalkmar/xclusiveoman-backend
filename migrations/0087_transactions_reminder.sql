-- Balance Due Reminder cron (jobs/balanceDueReminder.job.js) — flips true on
-- a transaction row the moment a payment leaves money still owed
-- (amount_paid_to_date != total_price, see payments.model.js#insertTransaction),
-- and back to false once the nightly job has sent that reminder (or found
-- the booking already settled by a later payment). NULL is never used —
-- always a real true/false, defaulting false so existing/backfilled rows
-- don't suddenly all queue up for a reminder the moment this ships.
ALTER TABLE transactions ADD COLUMN reminder BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_transactions_reminder ON transactions(reminder);
