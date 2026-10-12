const getAdminEmails = () => String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const isAdminEmail = (email) => Boolean(email) && getAdminEmails().includes(String(email).trim().toLowerCase());

module.exports = { getAdminEmails, isAdminEmail };
