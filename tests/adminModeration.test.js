const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const SupportRequest = require('../models/SupportRequest');
const AdminAuditLog = require('../models/AdminAuditLog');
const Conversation = require('../models/Conversation');
const Connection = require('../models/Connection');
const DirectMessage = require('../models/DirectMessage');
const Notification = require('../models/Notification');
const { isAdminEmail } = require('../utils/adminAccess');
const { getAccountRestriction, getPendingWarnings } = require('../utils/accountModeration');
const { requireAdmin } = require('../middleware/authMiddleware');
const { createRequest, consumeRateLimit } = require('../controllers/supportController');
const { overview, listReports, sendSupportReply, updateInboxItem, setVerification, broadcastMessage, listBroadcastMessages } = require('../controllers/adminController');
const AdminBroadcast = require('../models/AdminBroadcast');
const { listUsers } = require('../controllers/adminController');
const { listConversations } = require('../controllers/messageController');
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
    assert.match(selectFields, /isVerifiedAccount/);
    assert.doesNotMatch(selectFields, /password/);
    assert.equal(Object.hasOwn(res.body.users[0], 'password'), false);
  } finally { User.find = originalFind; User.countDocuments = originalCount; }
});

test('admins can grant and revoke a verified badge with an audit entry', async () => {
  const originalFindById = User.findById;
  const originalUpdateOne = User.updateOne;
  const originalCreate = AdminAuditLog.create;
  const target = { _id: '507f1f77bcf86cd799439012', moderationStatus: 'active', isVerifiedAccount: false };
  let update;
  let audit;
  User.findById = () => ({ select: async () => target });
  User.updateOne = async (...args) => { update = args; return { matchedCount: 1 }; };
  AdminAuditLog.create = async (entry) => { audit = entry; return entry; };
  try {
    const res = response();
    await setVerification({ params: { id: target._id }, body: { isVerifiedAccount: true, verificationBadgeColor: 'gold' }, user: { _id: '507f1f77bcf86cd799439011' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isVerifiedAccount, true);
    assert.equal(update[1].$set.isVerifiedAccount, true);
    assert.equal(update[1].$set.verificationBadgeColor, 'gold');
    assert.equal(res.body.verificationBadgeColor, 'gold');
    assert.equal(audit.action, 'verification_updated');
    assert.equal(audit.outcome, 'verified');

    const invalid = response();
    await setVerification({ params: { id: target._id }, body: { isVerifiedAccount: 'yes' }, user: { _id: '507f1f77bcf86cd799439011' } }, invalid, (error) => { throw error; });
    assert.equal(invalid.statusCode, 400);
    const invalidColor = response();
    await setVerification({ params: { id: target._id }, body: { isVerifiedAccount: true, verificationBadgeColor: 'purple' }, user: { _id: '507f1f77bcf86cd799439011' } }, invalidColor, (error) => { throw error; });
    assert.equal(invalidColor.statusCode, 400);
  } finally {
    User.findById = originalFindById;
    User.updateOne = originalUpdateOne;
    AdminAuditLog.create = originalCreate;
  }
});

test('admin broadcast creates an individual official Vuprise thread for each selected recipient', async () => {
  const originals = {
    userFind: User.find,
    conversationBulkWrite: Conversation.bulkWrite,
    conversationFind: Conversation.find,
    conversationUpdateMany: Conversation.updateMany,
    messageInsertMany: DirectMessage.insertMany,
    notificationInsertMany: Notification.insertMany,
    auditCreate: AdminAuditLog.create,
    broadcastCreate: AdminBroadcast.create,
  };
  const adminId = '507f1f77bcf86cd799439011';
  const recipientId = '507f1f77bcf86cd799439012';
  const threadId = '507f1f77bcf86cd799439013';
  let insertedMessages; let upsertOperations; let insertedNotifications;
  let savedBroadcast;
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: recipientId }] }) });
  Conversation.bulkWrite = async (operations) => { upsertOperations = operations; return {}; };
  Conversation.find = () => ({ select: () => ({ lean: async () => [{ _id: threadId, officialRecipient: recipientId, officialSender: adminId }] }) });
  Conversation.updateMany = async () => ({ modifiedCount: 1 });
  DirectMessage.insertMany = async (messages) => { insertedMessages = messages; return messages; };
  Notification.insertMany = async (notifications) => { insertedNotifications = notifications; return notifications; };
  AdminAuditLog.create = async (entry) => entry;
  AdminBroadcast.create = async (entry) => { savedBroadcast = entry; return entry; };
  try {
    const res = response();
    await broadcastMessage({ body: { text: 'A Vuprise update', recipientIds: [recipientId] }, user: { _id: adminId } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.recipientCount, 1);
    assert.equal(upsertOperations[0].updateOne.filter.pairKey, `official:${recipientId}`);
    assert.equal(upsertOperations[0].updateOne.update.$setOnInsert.isOfficialBroadcast, true);
    assert.equal(insertedMessages[0].conversation, threadId);
    assert.equal(insertedMessages[0].sender, adminId);
    assert.equal(insertedMessages[0].text, 'A Vuprise update');
    assert.deepEqual(insertedMessages[0].readBy, [adminId]);
    assert.equal(insertedNotifications[0].recipient, recipientId);
    assert.equal(insertedNotifications[0].type, 'official_message');
    assert.equal(insertedNotifications[0].conversation, threadId);
    assert.equal(savedBroadcast.text, 'A Vuprise update');
    assert.deepEqual(savedBroadcast.recipients, [recipientId]);
    assert.equal(savedBroadcast.recipientCount, 1);
  } finally {
    User.find = originals.userFind;
    Conversation.bulkWrite = originals.conversationBulkWrite;
    Conversation.find = originals.conversationFind;
    Conversation.updateMany = originals.conversationUpdateMany;
    DirectMessage.insertMany = originals.messageInsertMany;
    Notification.insertMany = originals.notificationInsertMany;
    AdminAuditLog.create = originals.auditCreate;
    AdminBroadcast.create = originals.broadcastCreate;
  }
});

test('admin-sent official threads stay out of private inboxes while recipients see Vuprise as the sender', async () => {
  const originals = { conversationFind: Conversation.find, connectionFind: Connection.find, messageAggregate: DirectMessage.aggregate };
  const adminId = '507f1f77bcf86cd799439011';
  const recipientId = '507f1f77bcf86cd799439012';
  const threadId = '507f1f77bcf86cd799439013';
  const admin = { _id: { toString: () => adminId }, name: 'Vishnu', email: 'admin@example.com' };
  const recipient = { _id: { toString: () => recipientId }, name: 'A user', headline: 'Designer', profilePicture: '', isVerifiedAccount: false };
  const conversation = {
    _id: threadId, isOfficialBroadcast: true, officialSender: adminId, officialRecipient: recipientId,
    participants: [admin, recipient], hiddenFor: [], displayNames: [], lastMessageAt: new Date()
  };
  const oldAdmins = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  Conversation.find = () => ({ sort() { return this; }, populate: async () => [conversation] });
  Connection.find = () => ({ select: () => ({ lean: async () => [] }) });
  DirectMessage.aggregate = async () => [];
  try {
    const adminResponse = response();
    adminResponse.set = () => adminResponse;
    await listConversations({ user: { _id: admin._id, email: admin.email } }, adminResponse, (error) => { throw error; });
    assert.deepEqual(adminResponse.body.conversations, []);

    const recipientResponse = response();
    recipientResponse.set = () => recipientResponse;
    await listConversations({ user: { _id: { toString: () => recipientId }, email: 'user@example.com' } }, recipientResponse, (error) => { throw error; });
    const recipientThread = recipientResponse.body.conversations[0];
    assert.equal(recipientThread.peer.name, 'Vuprise');
    assert.equal(recipientThread.peer.verificationBadgeColor, 'gold');
  } finally {
    Conversation.find = originals.conversationFind;
    Connection.find = originals.connectionFind;
    DirectMessage.aggregate = originals.messageAggregate;
    if (oldAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = oldAdmins;
  }
});

test('admin sent-message page reads durable broadcast history with recipients', async () => {
  const originals = { conversationFind: Conversation.find, messageCount: DirectMessage.countDocuments, messageFind: DirectMessage.find, broadcastFind: AdminBroadcast.find, broadcastCount: AdminBroadcast.countDocuments };
  const recipientId = '507f1f77bcf86cd799439012';
  const conversationId = '507f1f77bcf86cd799439013';
  const recipient = { _id: recipientId, name: 'A user', email: 'user@example.com' };
  AdminBroadcast.find = () => ({ populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [{ _id: '507f1f77bcf86cd799439014', text: 'A Vuprise update', recipients: [recipient], recipientCount: 1, createdAt: new Date() }] });
  AdminBroadcast.countDocuments = async () => 1;
  try {
    const res = response();
    await listBroadcastMessages({ query: { page: '1', limit: '20' }, user: { _id: '507f1f77bcf86cd799439011' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.messages[0].recipients[0].name, 'A user');
    assert.equal(res.body.messages[0].text, 'A Vuprise update');
    assert.equal(res.body.pagination.total, 1);
  } finally {
    Conversation.find = originals.conversationFind;
    DirectMessage.countDocuments = originals.messageCount;
    DirectMessage.find = originals.messageFind;
    AdminBroadcast.find = originals.broadcastFind;
    AdminBroadcast.countDocuments = originals.broadcastCount;
  }
});

test('admin sent-message page can recover broadcasts created before history records existed', async () => {
  const originals = { conversationFind: Conversation.find, messageCount: DirectMessage.countDocuments, messageFind: DirectMessage.find, broadcastFind: AdminBroadcast.find, broadcastCount: AdminBroadcast.countDocuments };
  const conversationId = '507f1f77bcf86cd799439013';
  const adminId = '507f1f77bcf86cd799439011';
  const recipient = { _id: '507f1f77bcf86cd799439012', name: 'A user', email: 'user@example.com' };
  AdminBroadcast.find = () => ({ populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] });
  AdminBroadcast.countDocuments = async () => 0;
  Conversation.find = () => ({ select() { return this; }, populate() { return this; }, lean: async () => [{ _id: conversationId, officialRecipient: recipient, participants: [{ _id: adminId }, recipient] }] });
  DirectMessage.countDocuments = async () => 1;
  DirectMessage.find = () => ({ sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [{ _id: '507f1f77bcf86cd799439014', conversation: conversationId, sender: adminId, text: 'Legacy Vuprise message', createdAt: new Date() }] });
  try {
    const res = response();
    await listBroadcastMessages({ query: { page: '1', limit: '20' }, user: { _id: adminId } }, res, (error) => { throw error; });
    assert.equal(res.body.messages[0].text, 'Legacy Vuprise message');
    assert.equal(res.body.messages[0].recipients[0].name, 'A user');
    assert.equal(res.body.messages[0].recipientCount, 1);
  } finally {
    Conversation.find = originals.conversationFind;
    DirectMessage.countDocuments = originals.messageCount;
    DirectMessage.find = originals.messageFind;
    AdminBroadcast.find = originals.broadcastFind;
    AdminBroadcast.countDocuments = originals.broadcastCount;
  }
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

test('saving a pending report with an already accepted reply marks it resolved', async () => {
  const originalFindById = SupportRequest.findById;
  const originalCreate = AdminAuditLog.create;
  const report = {
    _id: '507f1f77bcf86cd799439099',
    type: 'report',
    email: 'reporter@example.com',
    status: 'pending',
    priority: 'normal',
    resolution: 'We reviewed your report.',
    replySentAt: new Date('2026-10-12T14:44:00.000Z'),
    save: async function save() { this.saved = true; }
  };
  SupportRequest.findById = async () => report;
  AdminAuditLog.create = async () => ({ });
  try {
    const res = response();
    await updateInboxItem({ params: { id: report._id }, body: { status: 'pending' }, user: { _id: '507f1f77bcf86cd799439011' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(report.status, 'resolved');
    assert.ok(report.resolvedAt instanceof Date);
    assert.equal(report.saved, true);
  } finally {
    SupportRequest.findById = originalFindById;
    AdminAuditLog.create = originalCreate;
  }
});

test('saving a report review as Pending resolves it by default so the unresolved count drops', async () => {
  const originalFindById = SupportRequest.findById;
  const originalCreate = AdminAuditLog.create;
  const report = {
    _id: '507f1f77bcf86cd799439097', type: 'report', email: 'reporter@example.com', status: 'pending', priority: 'normal',
    message: 'Please review this post.', save: async function save() { this.saved = true; }
  };
  SupportRequest.findById = async () => report;
  AdminAuditLog.create = async () => ({});
  try {
    const res = response();
    await updateInboxItem({ params: { id: report._id }, body: { status: 'pending' }, user: { _id: '507f1f77bcf86cd799439011' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(report.status, 'resolved');
    assert.ok(report.resolvedAt instanceof Date);
    assert.equal(report.saved, true);
  } finally {
    SupportRequest.findById = originalFindById;
    AdminAuditLog.create = originalCreate;
  }
});

test('saving an Approved report preserves the selected status and removes it from unresolved reports', async () => {
  const originalFindById = SupportRequest.findById;
  const originalCreate = AdminAuditLog.create;
  const report = {
    _id: '507f1f77bcf86cd799439096', type: 'report', email: 'reporter@example.com', status: 'pending', priority: 'normal',
    message: 'Please review this post.', save: async function save() { this.saved = true; }
  };
  SupportRequest.findById = async () => report;
  AdminAuditLog.create = async () => ({});
  try {
    const res = response();
    await updateInboxItem({ params: { id: report._id }, body: { status: 'approved' }, user: { _id: '507f1f77bcf86cd799439011' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(report.status, 'approved');
    assert.ok(report.resolvedAt instanceof Date);
    assert.equal(report.saved, true);
  } finally {
    SupportRequest.findById = originalFindById;
    AdminAuditLog.create = originalCreate;
  }
});

test('overview excludes reports with a successfully delivered reply from unresolved count', async () => {
  const originalUserCount = User.countDocuments;
  const originalSupportCount = SupportRequest.countDocuments;
  const supportFilters = [];
  User.countDocuments = async () => 0;
  SupportRequest.countDocuments = async (filter) => { supportFilters.push(filter); return 0; };
  try {
    const res = response();
    await overview({}, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    const reportFilter = supportFilters.find((filter) => filter.type === 'report');
    assert.ok(reportFilter);
    assert.deepEqual(reportFilter.$or[1].$or, [{ replySentAt: { $exists: false } }, { replySentAt: null }]);
    assert.equal(res.body.overview.unresolvedReports, 0);
  } finally {
    User.countDocuments = originalUserCount;
    SupportRequest.countDocuments = originalSupportCount;
  }
});

test('reports with an accepted reply appear as resolved in the resolved filter', async () => {
  const originalFind = SupportRequest.find;
  const originalCount = SupportRequest.countDocuments;
  const record = { _id: '507f1f77bcf86cd799439098', type: 'report', status: 'pending', replySentAt: new Date() };
  let filter;
  SupportRequest.find = (query) => {
    filter = query;
    const chain = {
      select() { return this; }, populate() { return this; }, sort() { return this; },
      skip() { return this; }, limit() { return this; }, lean() { return Promise.resolve([record]); }
    };
    return chain;
  };
  SupportRequest.countDocuments = async () => 1;
  try {
    const res = response();
    await listReports({ query: { status: 'resolved' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requests[0].status, 'resolved');
    assert.equal(filter.$or[1].status, 'pending');
  } finally {
    SupportRequest.find = originalFind;
    SupportRequest.countDocuments = originalCount;
  }
});
