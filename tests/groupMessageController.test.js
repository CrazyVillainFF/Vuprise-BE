const test = require('node:test');
const assert = require('node:assert/strict');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const { getMessages, sendMessage } = require('../controllers/groupMessageController');

const original = {};
for (const [object, key] of [[Group, 'findOne'], [Group, 'updateOne'], [GroupMessage, 'create'], [GroupMessage, 'findOne'], [GroupMessage, 'find']]) original[`${object.modelName}.${key}`] = object[key];
const restore = () => {
  for (const [object, key] of [[Group, 'findOne'], [Group, 'updateOne'], [GroupMessage, 'create'], [GroupMessage, 'findOne'], [GroupMessage, 'find']]) object[key] = original[`${object.modelName}.${key}`];
};
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() {} });

test('non-members cannot list messages or create persistent messages', async () => {
  Group.findOne = () => ({ select: async () => null });
  let created = false;
  GroupMessage.create = async () => { created = true; };
  const req = { params: { id: '507f1f77bcf86cd799439011' }, user: { _id: '507f1f77bcf86cd799439012' }, body: { text: 'private' }, query: {} };
  const deniedRead = response(); const deniedSend = response();
  try {
    await getMessages(req, deniedRead, (error) => { throw error; });
    await sendMessage(req, deniedSend, (error) => { throw error; });
    assert.equal(deniedRead.statusCode, 404);
    assert.equal(deniedSend.statusCode, 404);
    assert.equal(created, false);
  } finally { restore(); }
});

test('members can send a bounded message and update the group’s last-message pointer', async () => {
  const group = { _id: '507f1f77bcf86cd799439011' };
  const sender = '507f1f77bcf86cd799439012';
  const saved = { _id: '507f1f77bcf86cd799439013', group: group._id, sender, text: 'Hello group', createdAt: new Date(), populate: async () => saved };
  let updateFilter; let update;
  Group.findOne = () => ({ select: async () => group });
  GroupMessage.create = async (data) => { assert.equal(data.text, 'Hello group'); return saved; };
  Group.updateOne = async (filter, changes) => { updateFilter = filter; update = changes; };
  const res = response();
  try {
    await sendMessage({ params: { id: group._id }, user: { _id: sender }, body: { text: ' Hello group ', clientMessageId: '12345678-abcd' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.message, saved);
    assert.equal(updateFilter['members.user'], sender);
    assert.equal(update.$set.lastMessage, saved._id);
  } finally { restore(); }
});

test('group message length is validated before writing', async () => {
  const group = { _id: '507f1f77bcf86cd799439011' };
  Group.findOne = () => ({ select: async () => group });
  let created = false;
  GroupMessage.create = async () => { created = true; };
  const res = response();
  try {
    await sendMessage({ params: { id: group._id }, user: { _id: '507f1f77bcf86cd799439012' }, body: { text: 'x'.repeat(5001) } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(created, false);
  } finally { restore(); }
});
