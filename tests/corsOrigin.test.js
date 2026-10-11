const test = require('node:test');
const assert = require('node:assert/strict');
const { getAllowedOrigins, isAllowedOrigin } = require('../config/corsOrigin');

test('CORS allows configured production origins but not arbitrary Vercel previews', () => {
  const allowedOrigins = getAllowedOrigins({
    CLIENT_URL: 'https://vuprise.example/',
    ALLOWED_CLIENT_ORIGINS: 'https://preview.vuprise.example, https://another-preview.example/',
  });
  assert.equal(isAllowedOrigin('https://vuprise.example', { allowedOrigins, environment: 'production' }), true);
  assert.equal(isAllowedOrigin('https://preview.vuprise.example', { allowedOrigins, environment: 'production' }), true);
  assert.equal(isAllowedOrigin('https://attacker.vercel.app', { allowedOrigins, environment: 'production' }), false);
});

test("CORS allows only this Vercel project's personal preview deployments", () => {
  assert.equal(isAllowedOrigin('https://nexora-2pwxqu19-vishnu-4571.vercel.app', { allowedOrigins: [], environment: 'production' }), true);
  assert.equal(isAllowedOrigin('https://nexora-git-fix-cors-vishnu-4571.vercel.app', { allowedOrigins: [], environment: 'production' }), true);
  assert.equal(isAllowedOrigin('https://another-project-2pwxqu19-vishnu-4571.vercel.app', { allowedOrigins: [], environment: 'production' }), false);
  assert.equal(isAllowedOrigin('https://nexora-2pwxqu19-attacker.vercel.app', { allowedOrigins: [], environment: 'production' }), false);
  assert.equal(isAllowedOrigin('http://nexora-2pwxqu19-vishnu-4571.vercel.app', { allowedOrigins: [], environment: 'production' }), false);
});

test('CORS allows local tools during development and non-browser requests', () => {
  assert.equal(isAllowedOrigin('http://localhost:4173', { allowedOrigins: [], environment: 'development' }), true);
  assert.equal(isAllowedOrigin('https://attacker.example', { allowedOrigins: [], environment: 'development' }), false);
  assert.equal(isAllowedOrigin(undefined, { allowedOrigins: [], environment: 'production' }), true);
});
