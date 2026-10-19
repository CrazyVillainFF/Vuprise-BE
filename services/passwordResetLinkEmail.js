const BREVO_EMAIL_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const sendResetEmail = async (toEmail, resetLink) => {
  const apiKey = typeof process.env.BREVO_API_KEY === 'string' ? process.env.BREVO_API_KEY.trim() : '';
  const senderEmail = typeof process.env.SENDER_EMAIL === 'string' ? process.env.SENDER_EMAIL.trim() : '';

  if (!apiKey) {
    const error = new Error('Brevo email is not configured.');
    error.category = 'configuration_error';
    throw error;
  }
  if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    const error = new Error('The configured sender email is invalid.');
    error.category = 'sender_configuration_error';
    throw error;
  }
  if (typeof toEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    const error = new Error('The recipient email is invalid.');
    error.category = 'recipient_validation_error';
    throw error;
  }
  if (typeof resetLink !== 'string' || !/^https?:\/\//i.test(resetLink)) {
    const error = new Error('The password reset URL is invalid.');
    error.category = 'reset_link_configuration_error';
    throw error;
  }

  const safeLink = escapeHtml(resetLink);
  let response;
  try {
    response = await fetch(BREVO_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Vups', email: senderEmail },
        to: [{ email: toEmail }],
        subject: 'Reset your password',
        textContent: `Use this link to reset your password: ${resetLink}\n\nThis link expires in 30 minutes. If you did not request a password reset, ignore this email.`,
        htmlContent: `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937"><p>We received a request to reset your password.</p><p><a href="${safeLink}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Reset Password</a></p><p>This link expires in 30 minutes.</p><p>If you did not request a password reset, you can ignore this email.</p></body></html>`
      })
    });
  } catch {
    const error = new Error('Brevo could not be reached.');
    error.category = 'network_error';
    throw error;
  }

  let body = {};
  try { body = await response.json(); } catch { /* Handle malformed provider responses below. */ }
  if (!response.ok || typeof body.messageId !== 'string' || !body.messageId) {
    const error = new Error('Brevo did not accept the password-reset email.');
    error.status = response.status;
    error.category = response.status === 401 || response.status === 403
      ? 'brevo_auth_error'
      : response.status === 429
        ? 'brevo_rate_limited'
        : response.status >= 500
          ? 'brevo_unavailable'
          : 'brevo_rejected';
    throw error;
  }
  return { messageId: body.messageId };
};

module.exports = { sendResetEmail };
