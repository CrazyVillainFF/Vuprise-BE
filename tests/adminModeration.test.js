const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const SupportRequest = require('../models/SupportRequest');
const { isAdminEmail } = require('../utils/adminAccess');
const { getAccountRestriction, getPendingWarnings } = require('../utils/accountModeration');
const { requireAdmin } = require('../middleware/authMiddleware');
const { createRequest, consumeRateLimit } = require('../controllers/supportController');
const { sendSupportReply } = require('../controllers/adminController');
const { listUsers } = require('../controllers/adminController');
const jwt = require('jsonwebtoken');
const { protect } = require('../middleware/authMiddleware');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('admin allowlist is exact, normalized, and server environment driven', () => {
  const old = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ' Admin@example.com, second@example.com ';
  try {
    assert.equal(isAdminEmail('admin@example.com'), true);
    assert.equal(isAdminEmail('ADMIN@example.com'), true);
    assert.equal(isAdminEmail('admin@example.com.attacker.test'), false);
    assert.equal(isAdminEmail('other@example.com'), false);
  } finally { if (old === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = old; }
});

test('admin middleware distinguishes unauthenticated and non-admin identities', () => {
  const next = () => {};
  const noAuth = response(); requireAdmin({ user: null }, noAuth, next);
  assert.equal(noAuth.statusCode, 401);
  const old = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = 'admin@example.com';
  try {
    const denied = response(); requireAdmin({ user: { email: 'user@example.com' } }, denied, next);
    assert.equal(denied.statusCode, 403);
    const allowed = response(); let called = false; requireAdmin({ user: { email: 'ADMIN@example.com' } }, allowed, () => { called = true; });
    assert.equal(called, true);
  } finally { if (old === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = old; }
});

test('moderation restriction is authoritative and expired temporary bans are cleared', async () => {
  assert.deepEqual(await getAccountRestriction({ moderationStatus: 'permanent_ban', moderationReason: 'policy' }), { status: 'permanent_ban', reason: 'policy' });
  assert.equal((await getAccountRestriction({ moderationStatus: 'temporary_ban', moderationExpiresAt: new Date('2030-01-01') }, new Date('2029-01-01'))).status, 'temporary_ban');
  const original = User.updateOne; let query;
  User.updateOne = async (...args) => { query = args; return { modifiedCount: 1 }; };
  try {
    const user = { _id: '507f1f77bcf86cd799439011', moderationStatus: 'temporary_ban', moderationExpiresAt: new Date('2020-01-01'), moderationReason: 'expired' };
    assert.equal(await getAccountRestriction(user, new Date('2021-01-01')), null);
    assert.equal(user.moderationStatus, 'active');
    assert.equal(query[0].moderationStatus, 'temporary_ban');
    assert.ok(query[0].moderationExpiresAt.$lte);
  } finally { User.updateOne = original; }
});

test('existing sessions are rejected while banned and allowed after a temporary ban expires', async () => {
  const originalFindById = User.findById; const originalUpdateOne = User.updateOne;
  const oldSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'moderation-test-secret-with-enough-randomness';
  let account = { _id: '507f1f77bcf86cd799439011', email: 'user@example.com', tokenVersion: 2, moderationStatus: 'permanent_ban', moderationReason: 'safety' };
  User.findById = () => ({ select: async () => ({ ...account }) });
  User.updateOne = async () => ({ modifiedCount: 1 });
  const token = jwt.sign({ id: account._id, tokenVersion: 2 }, process.env.JWT_SECRET);
  try {
    const restricted = response();
    await protect({ headers: { authorization: `Bearer ${token}` } }, restricted, () => {});
    assert.equal(restricted.statusCode, 403);
    assert.equal(restricted.body.code, 'ACCOUNT_RESTRICTED');

    account = { ...account, moderationStatus: 'temporary_ban', moderationExpiresAt: new Date(Date.now() - 1000) };
    let nextCalled = false;
    await protect({ headers: { authorization: `Bearer ${token}` } }, response(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    User.findById = originalFindById; User.updateOne = originalUpdateOne;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  }
});

test('warnings return only pending entries and preserve multiple warnings', () => {
  const pending = getPendingWarnings({ moderationWarnings: [
    { _id: 'one', reason: 'first', createdAt: new Date(), acknowledgedAt: null },
    { _id: 'two', reason: 'second', createdAt: new Date(), acknowledgedAt: new Date() }
  ] });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, 'first');
});

test('public support intake validates, accepts anonymous appeals, and rate limits', async () => {
  const originalCreate = SupportRequest.create;
  let created;
  SupportRequest.create = async (data) => { created = data; return { _id: '507f1f77bcf86cd799439099' }; };
  try {
    const invalid = response();
    await createRequest({ body: { type: 'general_help', email: 'bad', subject: 'x', message: 'short' }, ip: 'test-ip-a' }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);
    const accepted = response();
    await createRequest({ body: { type: 'temporary_ban_appeal', email: 'user@example.com', subject: 'Please review my account', message: 'I would like an administrator to review this restriction.' }, ip: 'test-ip-b' }, accepted, (error) => { throw error; });
    assert.equal(accepted.statusCode, 201);
    assert.equal(created.user, null);
    assert.equal(created.type, 'temporary_ban_appeal');
    const key = `unit-${Date.now()}`;
    for (let i = 0; i < 5; i += 1) assert.equal(consumeRateLimit(key, 1000), true);
    assert.equal(consumeRateLimit(key, 1000), false);
    assert.equal(consumeRateLimit(key, 1000 + 60 * 60 * 1000), true);
  } finally { SupportRequest.create = originalCreate; }
});

test('admin user list selects only safe profile/moderation fields and paginates', async () => {
  const originalFind = User.find; const originalCount = User.countDocuments;
  let selectFields; let limitValue;
  User.find = () => ({
    select(fields) { selectFields = fields; return this; },
    sort() { return this; }, skip() { return this; },
    limit(value) { limitValue = value; return this; },
    lean: async () => [{ _id: '507f1f77bcf86cd799439011', name: 'A', email: 'a@example.com', moderationStatus: 'active' }]
  });
  User.countDocuments = async () => 41;
  try {
    const res = response();
    await listUsers({ query: { page: '2', limit: '20', search: 'A' } }, res, (error) => { throw error; });
    assert.equal(limitValue, 20);
    assert.equal(res.body.pagination.pages, 3);
    assert.match(selectFields, /email/);
    assert.doesNotMatch(selectFields, /password/);
    assert.equal(Object.hasOwn(res.body.users[0], 'password'), false);
  } finally { User.find = originalFind; User.countDocuments = originalCount; }
});

test('support replies accurately report Brevo acceptance and rejection without logging secrets', async () => {
  const originalFetch = global.fetch; const oldKey = process.env.BREVO_API_KEY; const oldSender = process.env.PASSWORD_RESET_FROM;
  process.env.BREVO_API_KEY = 'server-test-key'; process.env.PASSWORD_RESET_FROM = 'vupriseofficial@gmail.com';
  try {
    let request;
    global.fetch = async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ messageId: 'provider-id' }) }; };
    assert.deepEqual(await sendSupportReply('user@example.com', 'The request is under review.'), { sent: true, reason: '' });
    assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(request.options.headers['api-key'], 'server-test-key');
    global.fetch = async () => ({ ok: false, json: async () => ({ message: 'recipient private details' }) });
    const rejected = await sendSupportReply('user@example.com', 'Please review the app.');
    assert.equal(rejected.sent, false);
    assert.doesNotMatch(rejected.reason, /recipient private details/);
  } finally {
    global.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = oldKey;
    if (oldSender === undefined) delete process.env.PASSWORD_RESET_FROM; else process.env.PASSWORD_RESET_FROM = oldSender;
  }
});
