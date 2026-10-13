const VERIFIED_EMAIL = 'vishnubangaru001@gmail.com';

const isVerifiedAccount = (value) => {
  if (value && typeof value === 'object' && typeof value.isVerifiedAccount === 'boolean') {
    return value.isVerifiedAccount;
  }
  const email = typeof value === 'string' ? value : value?.email;
  return typeof email === 'string' && email.trim().toLowerCase() === VERIFIED_EMAIL;
};

module.exports = { isVerifiedAccount };
