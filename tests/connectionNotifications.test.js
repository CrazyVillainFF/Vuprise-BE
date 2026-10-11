const test = require('node:test');
const assert = require('node:assert/strict');
const Connection = require('../models/Connection');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendConnectionRequest } = require('../controllers/connectionController');

const originals = { findById: User.findById, findOne: Connection.findOne, create: Connection.create, findOneAndUpdate: Connection.findOneAndUpdate, notificationUpsert: Notification.findOneAndUpdate };
const restore = () => {
  User.findById = originals.findById; Connection.findOne = originals.findOne; Connection.create = originals.create;
  Connection.findOneAndUpdate = originals.findOneAndUpdate; Notification.findOneAndUpdate = originals.notificationUpsert;
};
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('sending a request persists a recipient notification and reopens a declined request', async () => {
  const requester = '507f1f77bcf86cd799439011'; const recipient = '507f1f77bcf86cd799439012';
  const prior = { _id: '507f1f77bcf86cd799439013', status: 'rejected', requester, recipient };
  let update; let notificationUpdate;
  User.findById = async () => ({ _id: recipient });
  Connection.findOne = async () => prior;
  Connection.findOneAndUpdate = async (filter, change) => { update = { filter, change }; return { ...prior, status: 'pending' }; };
  Notification.findOneAndUpdate = async (filter, change) => { notificationUpdate = { filter, change }; };
  const res = response();
  try {
    await sendConnectionRequest({ params: { userId: recipient }, user: { _id: requester, name: 'Vishnu' } }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(update.filter.status, 'rejected');
    assert.equal(update.change.$set.status, 'pending');
    assert.equal(notificationUpdate.filter.recipient, recipient);
    assert.equal(notificationUpdate.change.$set.read, false);
    assert.equal(notificationUpdate.change.$set.sender, requester);
  } finally { restore(); }
});

test('canonical pair index prevents opposite-direction duplicate connection records', () => {
  const indexes = Connection.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.pairKey === 1 && options.unique && options.partialFilterExpression));
});
