const User = require('../models/User');
const { getBrevoConfig, escapeHtml } = require('./brevoEmail');

const INACTIVITY_MS = 28 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 30 * 60 * 1000;
const BATCH_LIMIT = 100;

function isInactive(lastSeenAt, now = Date.now()) {
  if (lastSeenAt === null || lastSeenAt === undefined || lastSeenAt === '') return false;
  const timestamp = new Date(lastSeenAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= now - INACTIVITY_MS;
}

function createReminderEmail(user, websiteUrl) {
  const name = escapeHtml(user.name || 'there');
  const safeUrl = escapeHtml(websiteUrl);
  return {
    subject: 'We Miss You on Vuprise — Please Check In',
    text: `Hi ${user.name || 'there'},\n\nWe noticed you haven't been active on Vuprise for the past 28 hours.\n\nWe hope everything is going well! When you have a moment, please visit Vuprise and check in with your account. If you've simply been busy, there's no problem. We're happy to have you whenever you return.\n\nVisit Vuprise: ${websiteUrl}\n\nBest regards,\nThe Vuprise Team`,
    html: `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#111"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:28px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #ddd;border-radius:12px"><tr><td style="padding:32px"><h1 style="margin:0 0 24px;font-size:24px">Vuprise</h1><p>Hi ${name},</p><p>We noticed you haven't been active on Vuprise for the past 28 hours.</p><p>We hope everything is going well! When you have a moment, please visit Vuprise and check in with your account.</p><p>If you've simply been busy, there's no problem. We're happy to have you whenever you return.</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px">Visit Vuprise</a></p><p>Best regards,<br>The Vuprise Team</p></td></tr></table></td></tr></table></body></html>`
  };
}

async function sendViaBrevo(user, { fetchImpl = global.fetch, env = process.env } = {}) {
  const { apiKey, senderEmail, senderName } = getBrevoConfig(env);
  const websiteUrl = env.CLIENT_URL || 'https://nexora-lac-three.vercel.app';
  if (!apiKey) throw new Error('Brevo email delivery is not configured.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw new Error('The configured Vuprise sender address is invalid.');
  const email = createReminderEmail(user, websiteUrl);
  const response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: senderEmail, name: senderName }, to: [{ email: user.email }], subject: email.subject, textContent: email.text, htmlContent: email.html })
  });
  let body = {};
  try { body = await response.json(); } catch { /* A missing response body is treated as a provider failure. */ }
  if (!response.ok || typeof body.messageId !== 'string') throw new Error('Brevo did not accept the inactivity reminder.');
  return body.messageId;
}

async function processInactivityReminders({ now = new Date(), UserModel = User, fetchImpl = global.fetch, env = process.env, logger = console } = {}) {
  const current = new Date(now);
  const cutoff = new Date(current.getTime() - INACTIVITY_MS);
  const staleClaim = new Date(current.getTime() - CLAIM_LEASE_MS);
  const candidates = await UserModel.find({
    lastSeenAt: { $type: 'date', $lte: cutoff },
    inactivityRemindersEnabled: { $ne: false },
    moderationStatus: { $nin: ['deleted', 'deletion_pending'] }
  }).select('_id name email +lastSeenAt +inactivityReminderSentAt').sort({ lastSeenAt: 1 }).limit(BATCH_LIMIT).lean();

  const result = { scanned: candidates.length, accepted: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    if (!candidate.email || !isInactive(candidate.lastSeenAt, current.getTime())) { result.skipped += 1; continue; }
    const sentAt = candidate.inactivityReminderSentAt ? new Date(candidate.inactivityReminderSentAt) : null;
    if (sentAt && Number.isFinite(sentAt.getTime()) && sentAt >= new Date(candidate.lastSeenAt)) { result.skipped += 1; continue; }

    const claim = await UserModel.findOneAndUpdate({
      _id: candidate._id,
      lastSeenAt: candidate.lastSeenAt,
      inactivityRemindersEnabled: { $ne: false },
      moderationStatus: { $nin: ['deleted', 'deletion_pending'] },
      $and: [
        { $or: [{ inactivityReminderSentAt: null }, { inactivityReminderSentAt: { $exists: false } }, { inactivityReminderSentAt: { $lt: candidate.lastSeenAt } }] },
        { $or: [{ inactivityReminderClaimedAt: null }, { inactivityReminderClaimedAt: { $exists: false } }, { inactivityReminderClaimedAt: { $lte: staleClaim } }] }
      ]
    }, { $set: { inactivityReminderClaimedAt: current } }, { new: true });
    if (!claim) { result.skipped += 1; continue; }

    try {
      // Re-check the activity and claim immediately before sending. Heartbeats
      // clear the claim and change lastSeenAt, so a returning user is skipped.
      const stillEligible = await UserModel.exists({ _id: candidate._id, lastSeenAt: candidate.lastSeenAt, inactivityRemindersEnabled: { $ne: false }, inactivityReminderClaimedAt: current });
      if (!stillEligible) { result.skipped += 1; continue; }
      const providerMessageId = await sendViaBrevo(candidate, { fetchImpl, env });
      const deliveredAt = new Date(current);
      const saved = await UserModel.updateOne({ _id: candidate._id, lastSeenAt: candidate.lastSeenAt, inactivityReminderClaimedAt: current }, {
        $set: { inactivityReminderSentAt: deliveredAt, inactivityReminderProviderId: providerMessageId },
        $unset: { inactivityReminderClaimedAt: 1 }
      });
      if (saved.modifiedCount) result.accepted += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      logger.warn('[Inactivity reminders] Delivery attempt failed; the reminder remains retryable.');
      await UserModel.updateOne({ _id: candidate._id, inactivityReminderClaimedAt: current }, { $unset: { inactivityReminderClaimedAt: 1 } });
    }
  }
  return result;
}

module.exports = { INACTIVITY_MS, isInactive, createReminderEmail, sendViaBrevo, processInactivityReminders };
