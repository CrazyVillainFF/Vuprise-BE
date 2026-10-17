const BREVO_EMAIL_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SENDER_EMAIL = 'vupriseofficial@gmail.com';
const DEFAULT_SENDER_NAME = 'Vuprise';
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One resolution point for every Brevo-backed feature: admin email, support
// replies, password reset, and inactivity reminders. BREVO_SENDER_EMAIL is the
// canonical sender; PASSWORD_RESET_FROM keeps working as a fallback so existing
// deployments do not lose email delivery when only the legacy name is set.
const getBrevoConfig = (env = process.env) => {
  const apiKey = typeof env.BREVO_API_KEY === 'string' ? env.BREVO_API_KEY.trim() : '';
  const senderEmail = (env.BREVO_SENDER_EMAIL || env.PASSWORD_RESET_FROM || DEFAULT_SENDER_EMAIL).trim();
  const senderName = (env.BREVO_SENDER_NAME || DEFAULT_SENDER_NAME).trim() || DEFAULT_SENDER_NAME;
  return { apiKey, senderEmail, senderName };
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Line breaks become <br> only after escaping, so message text can never inject
// markup into the HTML part of an email.
const textToHtml = (text) => escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');

// Map provider responses to short, admin-facing messages. Raw provider detail
// is never returned to callers or clients.
const classifyBrevoFailure = (status, providerDetail = '') => {
  if (status === 401 || status === 403) {
    return { category: 'auth_failed', message: 'Brevo rejected the server API key. Check BREVO_API_KEY and the account\u2019s authorised IP list in the Brevo settings.' };
  }
  if (status === 429) {
    return { category: 'rate_limited', message: 'Brevo is rate-limiting email right now. Wait a few minutes and try again.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { category: 'provider_unavailable', message: 'Brevo had a temporary problem. Try again in a few minutes.' };
  }
  const detail = String(providerDetail || '').toLowerCase();
  if (/limit|quota|credit/.test(detail)) {
    return { category: 'sending_limit', message: 'The Brevo account has reached its sending limit. Try again after the limit resets.' };
  }
  if (/sender|\bfrom\b|domain/.test(detail)) {
    return { category: 'sender_unverified', message: 'Brevo has not verified the sender address. Verify BREVO_SENDER_EMAIL in Brevo and try again.' };
  }
  if (/recipient|blocked|blacklist|email.*(?:not valid|invalid)|(?:not valid|invalid).*email/.test(detail)) {
    return { category: 'recipient_rejected', message: 'Brevo rejected this recipient address. Check that it is valid and allowed by Brevo.' };
  }
  return { category: 'provider_rejected', message: 'Brevo did not accept this email.' };
};

const sendBrevoEmail = async ({ apiKey, senderEmail, senderName, to, subject, text, html }) => {
  let response;
  try {
    response = await fetch(BREVO_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {})
      })
    });
  } catch {
    console.warn('[Brevo] Email delivery failed: network_error');
    return { sent: false, reason: 'Brevo could not be reached. Check the server connection and try again.' };
  }

  let body = {};
  try { body = await response.json(); } catch { /* A missing response body is classified as a provider failure. */ }
  if (!response.ok || typeof body.messageId !== 'string' || !body.messageId) {
    const failure = classifyBrevoFailure(response.status, [body.code, body.message].filter(Boolean).join(' '));
    console.warn(`[Brevo] Email delivery failed (status ${response.status || 'unknown'}): ${failure.category}`);
    return { sent: false, reason: failure.message };
  }
  return { sent: true, reason: '', messageId: body.messageId };
};

module.exports = { BREVO_EMAIL_ENDPOINT, EMAIL_ADDRESS_PATTERN, getBrevoConfig, escapeHtml, textToHtml, classifyBrevoFailure, sendBrevoEmail };
