const test = require('node:test');
const assert = require('node:assert/strict');
const Group = require('../models/Group');
const Notification = require('../models/Notification');
const Connection = require('../models/Connection');
const User = require('../models/User');
const { createGroup } = require('../controllers/groupController');

const originals = {
  groupCreate: Group.create,
  groupDelete: Group.deleteOne,
  notificationInsertMany: Notification.insertMany,
  notificationDeleteMany: Notification.deleteMany,
  userFind: User.find,
  connectionExists: Connection.exists,
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});
test.afterEach(() => {
  Group.create = originals.groupCreate;
  Group.deleteOne = originals.groupDelete;
  Notification.insertMany = originals.notificationInsertMany;
  Notification.deleteMany = originals.notificationDeleteMany;
  User.find = originals.userFind;
  Connection.exists = originals.connectionExists;
});

test('group creation allows the owner to create a group without invitees', async () => {
  const owner = '507f1f77bcf86cd799439011';
  let groupInput;
  let notificationCalls = 0;
  const group = { _id: '507f1f77bcf86cd799439014' };
  User.find = () => ({ select: async () => [] });
  Group.create = async (input) => { groupInput = input; return group; };
  Notification.insertMany = async () => { notificationCalls += 1; };
  const res = response();
  await createGroup({ body: { name: 'Solo group', about: '', memberIds: [] }, user: { _id: owner, name: 'Vishnu' } }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.deepEqual(groupInput.members, [{ user: owner, role: 'owner' }]);
  assert.deepEqual(groupInput.invitations, []);
  assert.equal(notificationCalls, 0);
});

test('group creation rejects duplicate invitees', async () => {
  let created = false;
  Group.create = async () => { created = true; };
  const res = response();
  await createGroup({
    body: { name: 'Design circle', about: '', memberIds: ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439012'] },
    user: { _id: '507f1f77bcf86cd799439011' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 400);
  assert.equal(created, false);
});

test('group creation stores invitations and sends a notification to each selected connection', async () => {
  const owner = '507f1f77bcf86cd799439011';
  const invitees = ['507f1f77bcf86cd799439012', '507f1f77bcf86cd799439013'];
  const group = { _id: '507f1f77bcf86cd799439014' };
  let groupInput;
  let notifications;
  User.find = () => ({ select: async () => invitees.map((_id) => ({ _id })) });
  Connection.exists = async () => ({ _id: 'accepted-connection' });
  Group.create = async (data) => { groupInput = data; return group; };
  Notification.insertMany = async (docs) => { notifications = docs; };
  const res = response();

  await createGroup({
    body: { name: 'Design circle', about: 'Share work', memberIds: invitees },
    user: { _id: owner, name: 'Vishnu' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.group, group);
  assert.deepEqual(groupInput.invitations.map(({ user, status }) => ({ user, status })), invitees.map((user) => ({ user, status: 'pending' })));
  assert.deepEqual(notifications.map(({ recipient, type, group: groupId }) => ({ recipient, type, groupId })), invitees.map((recipient) => ({ recipient, type: 'group_invitation', groupId: group._id })));
});

test('group creation accepts one multipart invitee supplied as a scalar field', async () => {
  const owner = '507f1f77bcf86cd799439011';
  const invitee = '507f1f77bcf86cd799439012';
  const group = { _id: '507f1f77bcf86cd799439014' };
  let groupInput;
  User.find = () => ({ select: async () => [{ _id: invitee }] });
  Connection.exists = async () => ({ _id: 'accepted-connection' });
  Group.create = async (data) => { groupInput = data; return group; };
  Notification.insertMany = async () => {};
  const res = response();

  await createGroup({
    body: { name: 'Design circle', about: 'Welcome Everyone', memberIds: invitee },
    user: { _id: owner, name: 'Vishnu' },
  }, res, (error) => { throw error; });

  assert.equal(res.statusCode, 201);
  assert.deepEqual(groupInput.invitations.map(({ user, status }) => ({ user, status })), [{ user: invitee, status: 'pending' }]);
});

