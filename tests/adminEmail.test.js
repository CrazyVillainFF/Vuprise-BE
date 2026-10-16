const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const AdminAuditLog = require('../models/AdminAuditLog');
const { emailUsers, broadcastMessage, listUsers } = require('../controllers/adminController');

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const admin = (id) => ({ _id: id });

test('bulk email validates subject, message, and audience shape before any provider call', async () => {
  const adminId = '507f1f77bcf86cd799439101';
  const recipientId = '507f1f77bcf86cd799439102';
  const originalFetch = global.fetch;
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ messageId: 'id' }) }; };
  try {
    const missingSubject = response();
    await emailUsers({ body: { message: 'Hello', recipientIds: [recipientId] }, user: admin(adminId) }, missingSubject, (error) => { throw error; });
    assert.equal(missingSubject.statusCode, 400);

    const longSubject = response();
    await emailUsers({ body: { subject: 'x'.repeat(201), message: 'Hello', recipientIds: [recipientId] }, user: admin(adminId) }, longSubject, (error) => { throw error; });
    assert.equal(longSubject.statusCode, 400);

    const missingMessage = response();
    await emailUsers({ body: { subject: 'Update', recipientIds: [recipientId] }, user: admin(adminId) }, missingMessage, (error) => { throw error; });
    assert.equal(missingMessage.statusCode, 400);

    const mixedAudience = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', selectAll: true, recipientIds: [recipientId] }, user: admin(adminId) }, mixedAudience, (error) => { throw error; });
    assert.equal(mixedAudience.statusCode, 400);

    const invalidIds = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', recipientIds: ['not-an-id'] }, user: admin(adminId) }, invalidIds, (error) => { throw error; });
    assert.equal(invalidIds.statusCode, 400);

    assert.equal(fetched, false);
  } finally { global.fetch = originalFetch; }
});

test('bulk email requires configured provider credentials', async () => {
  const originalFind = User.find; const oldKey = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: '507f1f77bcf86cd799439102', email: 'user@example.com' }] }) });
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', recipientIds: ['507f1f77bcf86cd799439102'] }, user: admin('507f1f77bcf86cd799439103') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 503);
  } finally {
    User.find = originalFind;
    if (oldKey !== undefined) process.env.BREVO_API_KEY = oldKey;
  }
});

test('bulk email sends one private provider request per deduped verified recipient and reports failures without provider detail', async () => {
  const originalFind = User.find; const originalAudit = AdminAuditLog.create;
  const originalFetch = global.fetch;
  const oldKey = process.env.BREVO_API_KEY; const oldSender = process.env.PASSWORD_RESET_FROM;
  process.env.BREVO_API_KEY = 'email-test-key'; process.env.PASSWORD_RESET_FROM = 'vupriseofficial@gmail.com';
  const adminId = '507f1f77bcf86cd799439104';
  const ids = ['507f1f77bcf86cd799439111', '507f1f77bcf86cd799439112', '507f1f77bcf86cd799439113', '507f1f77bcf86cd799439114'];
  let filter; const requests = [];
  User.find = (query) => { filter = query; return { select: () => ({ lean: async () => [
    { _id: ids[0], email: 'One@Example.com' },
    { _id: ids[1], email: 'one@example.com' },
    { _id: ids[2], email: 'not-an-email' },
    { _id: ids[3], email: 'two@example.com' },
  ] }) }; };
  AdminAuditLog.create = async (entry) => entry;
  global.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (requests.length === 1) return { ok: true, json: async () => ({ messageId: 'provider-id' }) };
    return { ok: false, json: async () => ({ message: 'recipient private details' }) };
  };
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Maintenance window', message: 'Vuprise will be briefly offline.', recipientIds: ids, verifiedOnly: true }, user: admin(adminId) }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(filter.$or, [
      { isVerifiedAccount: true },
      { email: { $regex: '^vishnubangaru001@gmail\\.com$', $options: 'i' } },
    ]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(request.options.headers['api-key'], 'email-test-key');
      assert.equal(request.body.to.length, 1);
      assert.equal(request.body.bcc, undefined);
      assert.equal(request.body.sender.name, 'Vuprise');
    }
    assert.deepEqual(requests.map((request) => request.body.to[0].email).sort(), ['one@example.com', 'two@example.com']);
    assert.equal(res.body.summary.requested, 2);
    assert.equal(res.body.summary.sent, 1);
    assert.equal(res.body.summary.failed, 1);
    assert.equal(res.body.summary.skipped, 2);
    assert.equal(res.body.failures[0].email, 'two@example.com');
    assert.doesNotMatch(res.body.failures[0].reason, /recipient private details/);
  } finally {
    User.find = originalFind;
    AdminAuditLog.create = originalAudit;
    global.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = oldKey;
    if (oldSender === undefined) delete process.env.PASSWORD_RESET_FROM; else process.env.PASSWORD_RESET_FROM = oldSender;
  }
});

test('official messages restrict recipients to verified accounts when verified only is selected', async () => {
  const originalFind = User.find;
  const adminId = '507f1f77bcf86cd799439105';
  let filter;
  User.find = (query) => { filter = query; return { select: () => ({ lean: async () => [{ _id: '507f1f77bcf86cd799439121' }] }) }; };
  try {
    const mismatch = response();
    await broadcastMessage({ body: { text: 'Hello verified users', recipientIds: ['507f1f77bcf86cd799439121', '507f1f77bcf86cd799439122'], verifiedOnly: true }, user: admin(adminId) }, mismatch, (error) => { throw error; });
    assert.equal(mismatch.statusCode, 404);
    assert.match(mismatch.body.message, /verified/);
    assert.deepEqual(filter.$or, [
      { isVerifiedAccount: true },
      { email: { $regex: '^vishnubangaru001@gmail\\.com$', $options: 'i' } },
    ]);
  } finally { User.find = originalFind; }
});

test('admin user list can filter to verified accounts using the same authoritative rule', async () => {
  const originalFind = User.find; const originalCount = User.countDocuments;
  let filter;
  User.find = (query) => { filter = query; return { select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }) }; };
  User.countDocuments = async () => 0;
  try {
    const res = response();
    await listUsers({ query: { verifiedOnly: 'true', search: 'ana' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(filter.$and[0], {
      $or: [
        { isVerifiedAccount: true },
        { email: { $regex: '^vishnubangaru001@gmail\\.com$', $options: 'i' } },
      ],
    });
    assert.deepEqual(filter.$and[1].$or[0], { name: { $regex: 'ana', $options: 'i' } });
  } finally { User.find = originalFind; User.countDocuments = originalCount; }
});
