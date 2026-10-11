const normalizeOrigin = (origin) => origin.trim().replace(/\/$/, '');

const getAllowedOrigins = (env = process.env) => [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'https://nexora-lac-three.vercel.app',
  env.CLIENT_URL,
  ...(env.ALLOWED_CLIENT_ORIGINS || '').split(','),
].filter(Boolean).map(normalizeOrigin);

// Vercel's immutable preview deployments receive a unique URL per deploy. Keep
// preview access limited to this project's deployments under its own account;
// never allow arbitrary *.vercel.app origins.
const isNexoraVercelPreview = (origin) => {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:'
      && url.origin === origin
      && /^nexora-[a-z0-9-]+-vishnu-4571\.vercel\.app$/i.test(url.hostname);
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin, { allowedOrigins = getAllowedOrigins(), environment = process.env.NODE_ENV } = {}) => {
  if (!origin) return true;
  const normalizedOrigin = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalizedOrigin)) return true;
  if (isNexoraVercelPreview(normalizedOrigin)) return true;
  if (environment === 'development') {
    try {
      const { hostname } = new URL(normalizedOrigin);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return false;
};

module.exports = { getAllowedOrigins, isAllowedOrigin };
