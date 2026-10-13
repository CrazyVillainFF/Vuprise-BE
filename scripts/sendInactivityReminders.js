require('dotenv').config();
const { connectDB, disconnectDB } = require('../config/db');
const { processInactivityReminders } = require('../services/inactivityReminderService');

(async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI must be configured for the inactivity reminder cron job.');
    await connectDB();
    const result = await processInactivityReminders();
    console.log(`[Inactivity reminders] Scan complete: ${result.scanned} scanned, ${result.accepted} accepted by Brevo, ${result.skipped} skipped, ${result.failed} retryable failures.`);
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[Inactivity reminders] Cron run failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDB().catch(() => {});
  }
})();
