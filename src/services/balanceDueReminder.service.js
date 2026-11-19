const {
  listTransactionsNeedingReminder,
  clearTransactionReminder
} = require('../models/payments.model.js');

const {
  findUserById
} = require('../models/users.model.js');

const {
  createNotification
} = require('./notification.service.js');

const {
  sendEmail
} = require('./email.service.js');

const {
  buildBalanceDueReminderEmailHtml
} = require('./emailTemplate.service.js');

const {
  env
} = require('../config/env.js');

const {
  formatMoney
} = require('../utils/currency.js');

// Balance Due Reminder cron (jobs/balanceDueReminder.job.js) — one reminder
// (email + in-app notification) per transactions row flagged `reminder =
// true` (payments.model.js#insertTransaction sets that the moment a payment
// still leaves a balance owed). Sent to the same user
// paymentConfirmation.service.js#confirmPayment already emails on a
// successful payment: booking.created_by_user_id, not a broader
// "agency owner" fan-out (fdOperationsNotify.service.js's own convention) —
// this is about one specific booking a specific staff member created, not
// an agency-wide announcement.
//
// A booking with zero successful payments ever (still 'pending_payment', no
// transactions row exists to flag) is out of scope for this mechanism by
// construction — there's nothing to flip `reminder` on. That's a known,
// accepted gap of triggering off `transactions` rather than `bookings`
// itself, not an oversight.
//
// Best-effort per row, matching fdOperationsNotify.service.js's own
// posture: one row failing (a bad email address, Brevo being down, …) must
// never block the rest of the batch. `reminder` is only cleared
// (clearTransactionReminder) after the notify attempt has run, so a
// mid-send crash just leaves it true and the row is retried tomorrow rather
// than silently dropped.
async function sendBalanceDueReminders() {
  const rows = await listTransactionsNeedingReminder();
  if (rows.length === 0) return { sent: 0, skipped: 0, failed: 0 };

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      // Re-check the *live* booking state before sending — this
      // transaction's own reminder flag was set at payment time, but a
      // later payment (or a cancellation) can have already resolved the
      // booking since then, and that later transaction's own row (if any)
      // is what actually reflects the current balance. Sending here would
      // just be a stale, wrong reminder for a booking that no longer needs one.
      const settledOrTerminal =
        Number(row.balance_due) <= 0 ||
        ['cancelled', 'waitlisted', 'fully_paid', 'completed'].includes(row.booking_status);

      if (settledOrTerminal) {
        await clearTransactionReminder(row.transaction_id);
        skipped += 1;
        continue;
      }

      const creator = await findUserById(row.created_by_user_id);
      if (!creator) {
        // Booking's creator account no longer exists (offboarded staff, …)
        // — nothing to notify; clear the flag so this row doesn't stay
        // stuck re-querying every tick forever.
        await clearTransactionReminder(row.transaction_id);
        skipped += 1;
        continue;
      }

      const overdue = row.balance_due_date
        ? new Date(row.balance_due_date) < new Date(new Date().toDateString())
        : false;
      const loginUrl = `${env.agentPortalUrl}/transactions`;

      try {
        await createNotification({
          recipientUserId: creator.id,
          recipientRole: creator.role,
          type: 'balance_due_reminder',
          title: overdue ? 'Payment overdue' : 'Balance payment due',
          message: `${row.package_title} — ${formatMoney(row.balance_due)} still due${
            row.balance_due_date ? ` (${new Date(row.balance_due_date).toLocaleDateString('en-GB')})` : ''
          }.`,
          referenceType: 'booking',
          referenceId: row.booking_id,
        });
      } catch (err) {
        console.error(`[balanceDueReminder] Failed to create notification for booking ${row.booking_id}`, err);
      }

      try {
        const { html, attachments } = buildBalanceDueReminderEmailHtml({
          fullName: creator.full_name,
          packageTitle: row.package_title,
          balanceDue: row.balance_due,
          balanceDueDate: row.balance_due_date,
          overdue,
          loginUrl,
        });
        await sendEmail({
          to: creator.email,
          subject: overdue ? `Payment overdue — ${row.package_title}` : `Balance payment due — ${row.package_title}`,
          text: `${overdue ? 'Overdue' : 'Due'}: ${formatMoney(row.balance_due)} for ${row.package_title}. Pay at ${loginUrl}`,
          html,
          attachments,
        });
      } catch (err) {
        console.error(`[balanceDueReminder] Failed to email booking ${row.booking_id}`, err);
      }

      await clearTransactionReminder(row.transaction_id);
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`[balanceDueReminder] Failed to process transaction ${row.transaction_id}`, err);
    }
  }

  return { sent, skipped, failed };
}

module.exports.sendBalanceDueReminders = sendBalanceDueReminders;
