const cron = require('node-cron');

const {
  sendBalanceDueReminders
} = require('../services/balanceDueReminder.service.js');

// Balance Due Reminder — nightly cron, same node-cron already used by
// jobs/marketingScheduler.job.js (no new scheduling dependency). Runs once a
// night rather than that file's once-a-minute cadence: the trigger is a
// transactions row (payments.model.js#insertTransaction sets `reminder =
// true` the moment a payment leaves a balance owed), not a fast-changing
// condition, so a nightly sweep is plenty. A server restart loses nothing —
// the next scheduled tick just re-queries whatever's still flagged
// (payments.model.js#listTransactionsNeedingReminder) — nothing is tracked
// only in process memory.
//
// `running` is the same in-process-only guard marketingScheduler.job.js
// uses (not a DB-level FOR UPDATE SKIP LOCKED claim like that file's own
// claimDueCampaigns) — appropriate here because sendBalanceDueReminders
// itself already clears each row's `reminder` flag immediately after
// processing it (payments.model.js#clearTransactionReminder), so the same
// row is never sent twice even across separate ticks; this guard only
// prevents two overlapping ticks in the same process (a run taking longer
// than a night, effectively) from processing the same batch twice.
let running = false;

async function runBalanceDueReminders() {
  if (running) return;
  running = true;
  try {
    const { sent, skipped, failed } = await sendBalanceDueReminders();
    if (sent > 0 || skipped > 0 || failed > 0) {
      console.log(`[balanceDueReminder] Sent ${sent}, skipped ${skipped} (already settled), ${failed} failed`);
    }
  } catch (err) {
    console.error('[balanceDueReminder] Failed to run', err);
  } finally {
    running = false;
  }
}

module.exports.runBalanceDueReminders = runBalanceDueReminders;

// 23:00 server time, nightly.
function startBalanceDueReminderScheduler() {
  cron.schedule('0 23 * * *', () => {
    runBalanceDueReminders().catch((err) => console.error('[balanceDueReminder] Unexpected error', err));
  });
}

module.exports.startBalanceDueReminderScheduler = startBalanceDueReminderScheduler;
