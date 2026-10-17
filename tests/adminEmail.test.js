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
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /not set up yet/);
  } finally {
    User.find = originalFind;
    if (oldKey !== undefined) process.env.BREVO_API_KEY = oldKey;
  }
});

test('bulk email reports an invalid configured sender address without contacting the provider', async () => {
  const originalFind = User.find; const originalFetch = global.fetch;
  const envKeys = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'email-test-key', BREVO_SENDER_EMAIL: 'not-an-address' });
  delete process.env.PASSWORD_RESET_FROM;
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ messageId: 'id' }) }; };
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: '507f1f77bcf86cd799439102', email: 'user@example.com' }] }) });
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', recipientIds: ['507f1f77bcf86cd799439102'] }, user: admin('507f1f77bcf86cd799439103') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /sender address is invalid/);
    assert.equal(fetched, false);
  } finally {
    User.find = originalFind; global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
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

test('admin audit log accepts the email_users action and keeps every existing action', async () => {
  const entry = new AdminAuditLog({ admin: '507f1f77bcf86cd799439130', action: 'email_users', outcome: '2 sent, 0 failed' });
  await entry.validate();
  const enumValues = AdminAuditLog.schema.path('action').enumValues;
  for (const action of ['temporary_ban', 'permanent_ban', 'lift_ban', 'warning', 'warning_removed', 'warning_acknowledged', 'verification_updated', 'broadcast_message', 'broadcast_edited', 'email_users', 'user_deleted', 'request_updated', 'report_updated', 'help_updated']) {
    assert.equal(enumValues.includes(action), true, `enum is missing ${action}`);
  }
});

test('bulk email logs the email_users audit action with send separately ON and OFF', async () => {
  const originalFind = User.find; const originalAudit = AdminAuditLog.create; const originalFetch = global.fetch;
  const oldKey = process.env.BREVO_API_KEY; const oldSender = process.env.PASSWORD_RESET_FROM;
  process.env.BREVO_API_KEY = 'email-test-key'; process.env.PASSWORD_RESET_FROM = 'vupriseofficial@gmail.com';
  const adminId = '507f1f77bcf86cd799439131';
  const ids = ['507f1f77bcf86cd799439141', '507f1f77bcf86cd799439142'];
  const logged = [];
  User.find = () => ({ select: () => ({ lean: async () => ids.map((id, index) => ({ _id: id, email: `member${index}@example.com` })) }) });
  AdminAuditLog.create = async (auditEntry) => { logged.push(auditEntry); return auditEntry; };
  global.fetch = async () => ({ ok: true, json: async () => ({ messageId: 'provider-id' }) });
  try {
    for (const sendSeparately of [true, false]) {
      const res = response();
      await emailUsers({ body: { subject: 'Update', message: 'Hello everyone', recipientIds: ids, sendSeparately }, user: admin(adminId) }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.summary.sent, 2);
    }
    assert.equal(logged.length, 2);
    for (const auditEntry of logged) {
      assert.equal(auditEntry.action, 'email_users');
      assert.equal(auditEntry.admin, adminId);
    }
  } finally {
    User.find = originalFind;
    AdminAuditLog.create = originalAudit;
    global.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = oldKey;
    if (oldSender === undefined) delete process.env.PASSWORD_RESET_FROM; else process.env.PASSWORD_RESET_FROM = oldSender;
  }
});

test('bulk email escapes message text for the HTML part and keeps a plain-text copy', async () => {
  const originalFind = User.find; const originalFetch = global.fetch; const originalAudit = AdminAuditLog.create;
  const envKeys = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'email-test-key', PASSWORD_RESET_FROM: 'vupriseofficial@gmail.com' });
  delete process.env.BREVO_SENDER_EMAIL; delete process.env.BREVO_SENDER_NAME;
  const ids = ['507f1f77bcf86cd799439151'];
  let request;
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: ids[0], email: 'escape@example.com' }] }) });
  AdminAuditLog.create = async (entry) => entry;
  global.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ messageId: 'provider-id' }) }; };
  try {
    const message = '<script>alert("x")</script>\nSecond & line';
    const res = response();
    await emailUsers({ body: { subject: 'Update', message, recipientIds: ids }, user: admin('507f1f77bcf86cd799439152') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(request.textContent, message);
    assert.equal(request.htmlContent, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Second &amp; line');
    assert.equal(request.sender.name, 'Vuprise');
  } finally {
    User.find = originalFind; global.fetch = originalFetch; AdminAuditLog.create = originalAudit;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('bulk email prefers BREVO_SENDER_EMAIL and BREVO_SENDER_NAME over the legacy fallback', async () => {
  const originalFind = User.find; const originalFetch = global.fetch; const originalAudit = AdminAuditLog.create;
  const envKeys = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'email-test-key', BREVO_SENDER_EMAIL: 'updates@example.com', BREVO_SENDER_NAME: 'Vuprise Team', PASSWORD_RESET_FROM: 'legacy@example.com' });
  const ids = ['507f1f77bcf86cd799439153'];
  let request;
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: ids[0], email: 'sender@example.com' }] }) });
  AdminAuditLog.create = async (entry) => entry;
  global.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ messageId: 'provider-id' }) }; };
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', recipientIds: ids }, user: admin('507f1f77bcf86cd799439154') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(request.sender.email, 'updates@example.com');
    assert.equal(request.sender.name, 'Vuprise Team');
  } finally {
    User.find = originalFind; global.fetch = originalFetch; AdminAuditLog.create = originalAudit;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('bulk email maps provider failures to friendly messages without provider details', async () => {
  const originalFind = User.find; const originalFetch = global.fetch; const originalWarn = console.warn; const originalAudit = AdminAuditLog.create;
  const envKeys = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'email-test-key', PASSWORD_RESET_FROM: 'vupriseofficial@gmail.com' });
  delete process.env.BREVO_SENDER_EMAIL; delete process.env.BREVO_SENDER_NAME;
  const scenarios = [
    { status: 401, body: { code: 'unauthorized', message: 'Key not found in workspace' }, match: /API key/ },
    { status: 429, body: { message: 'Too many requests' }, match: /rate-limiting/ },
    { status: 400, body: { message: 'sender domain is not verified' }, match: /not verified the sender/ },
    { status: 400, body: { message: 'You have reached your daily sending limit' }, match: /sending limit/ },
    { status: 400, body: { message: 'invalid email address' }, match: /rejected this recipient/ },
    { status: 503, body: { message: 'Service unavailable' }, match: /temporary problem/ },
    { network: true, match: /could not be reached/ },
  ];
  const ids = scenarios.map((_, index) => `507f1f77bcf86cd79943917${index}`);
  let call = 0; const warnings = [];
  User.find = () => ({ select: () => ({ lean: async () => ids.map((id, index) => ({ _id: id, email: `r${index}@example.com` })) }) });
  AdminAuditLog.create = async (entry) => entry;
  global.fetch = async () => {
    const scenario = scenarios[call];
    call += 1;
    if (scenario.network) throw new Error('socket hang up');
    return { ok: false, status: scenario.status, json: async () => scenario.body };
  };
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello', recipientIds: ids }, user: admin('507f1f77bcf86cd799439161') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.summary.sent, 0);
    assert.equal(res.body.summary.failed, scenarios.length);
    const reasons = Object.fromEntries(res.body.failures.map((failure) => [failure.email, failure.reason]));
    scenarios.forEach((scenario, index) => assert.match(reasons[`r${index}@example.com`], scenario.match));
    assert.doesNotMatch(JSON.stringify(res.body.failures), /Key not found|Too many requests|Service unavailable|socket hang up/);
    assert.equal(warnings.length, scenarios.length);
    assert.doesNotMatch(warnings.join(' '), /Key not found|Too many requests|Service unavailable|socket hang up/);
  } finally {
    User.find = originalFind; global.fetch = originalFetch; console.warn = originalWarn; AdminAuditLog.create = originalAudit;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('bulk email still reports delivered results when the audit log write fails', async () => {
  const originalFind = User.find; const originalAudit = AdminAuditLog.create; const originalFetch = global.fetch; const originalError = console.error;
  const envKeys = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'PASSWORD_RESET_FROM'];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { BREVO_API_KEY: 'email-test-key', PASSWORD_RESET_FROM: 'vupriseofficial@gmail.com' });
  delete process.env.BREVO_SENDER_EMAIL; delete process.env.BREVO_SENDER_NAME;
  const ids = ['507f1f77bcf86cd799439181', '507f1f77bcf86cd799439182'];
  const errors = [];
  User.find = () => ({ select: () => ({ lean: async () => ids.map((id, index) => ({ _id: id, email: `member${index}@example.com` })) }) });
  AdminAuditLog.create = async () => { throw new Error('audit unavailable'); };
  global.fetch = async () => ({ ok: true, json: async () => ({ messageId: 'provider-id' }) });
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const res = response();
    await emailUsers({ body: { subject: 'Update', message: 'Hello everyone', recipientIds: ids }, user: admin('507f1f77bcf86cd799439183') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.summary.sent, 2);
    assert.equal(res.body.summary.failed, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Audit log write failed/);
  } finally {
    User.find = originalFind; AdminAuditLog.create = originalAudit; global.fetch = originalFetch; console.error = originalError;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
