const test = require('node:test');
const assert = require('node:assert/strict');
const { INACTIVITY_MS, isInactive, createReminderEmail, processInactivityReminders } = require('../services/inactivityReminderService');

const NOW = new Date('2026-10-13T12:00:00.000Z');
const userAt = (offset, extra = {}) => ({ _id: 'user-1', name: 'A & B', email: 'person@example.test', lastSeenAt: new Date(NOW.getTime() - offset), inactivityRemindersEnabled: true, ...extra });

function fakeModel(records) {
  const claimed = new Set();
  let activeBeforeCheckId = null;
  const model = {
    find(filter) {
      model.lastFilter = filter;
      return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => records };
    },
    async findOneAndUpdate(filter) {
      const record = records.find((item) => String(item._id) === String(filter._id));
      if (!record || claimed.has(String(record._id)) || !record.inactivityRemindersEnabled || +new Date(record.lastSeenAt) !== +filter.lastSeenAt) return null;
      if (record.inactivityReminderSentAt && +new Date(record.inactivityReminderSentAt) >= +new Date(record.lastSeenAt)) return null;
      claimed.add(String(record._id));
      record.inactivityReminderClaimedAt = NOW;
      return record;
    },
    async exists(filter) {
      const record = records.find((item) => String(item._id) === String(filter._id));
      if (activeBeforeCheckId === String(filter._id)) { record.lastSeenAt = NOW; record.inactivityReminderClaimedAt = null; claimed.delete(String(filter._id)); return null; }
      return claimed.has(String(filter._id)) ? { _id: filter._id } : null;
    },
    async updateOne(filter, update) {
      const record = records.find((item) => String(item._id) === String(filter._id));
      if (update.$unset?.inactivityReminderClaimedAt) { claimed.delete(String(filter._id)); record.inactivityReminderClaimedAt = null; }
      if (update.$set?.inactivityReminderSentAt) {
        claimed.delete(String(filter._id));
        record.inactivityReminderSentAt = update.$set.inactivityReminderSentAt;
        record.inactivityReminderProviderId = update.$set.inactivityReminderProviderId;
      }
      return { modifiedCount: 1 };
    },
    setActiveBeforeCheck(id = records[0]?._id) { activeBeforeCheckId = String(id); }
  };
  return model;
}

const acceptedBrevo = async (_url, options) => ({ ok: true, json: async () => ({ messageId: 'brevo-accepted-id', payload: JSON.parse(options.body) }) });

test('28-hour eligibility uses server timestamps and safely rejects missing or invalid timestamps', () => {
  assert.equal(isInactive(new Date(NOW.getTime() - INACTIVITY_MS + 1), NOW), false);
  assert.equal(isInactive(new Date(NOW.getTime() - INACTIVITY_MS), NOW), true);
  assert.equal(isInactive(new Date(NOW.getTime() - INACTIVITY_MS - 1), NOW), true);
  assert.equal(isInactive(null, NOW), false);
  assert.equal(isInactive('not-a-date', NOW), false);
});

test('reminder email has a plain-text alternative, escaped name, and configured site link', () => {
  const email = createReminderEmail({ name: '<Member>', email: 'member@example.test' }, 'https://vuprise.example');
  assert.match(email.subject, /Vuprise/);
  assert.match(email.text, /28 hours/);
  assert.match(email.html, /&lt;Member&gt;/);
  assert.match(email.html, /https:\/\/vuprise\.example/);
});

test('less than 28 hours sends nothing; exactly 28 hours and more than 28 hours can send', async () => {
  for (const [offset, expected] of [[INACTIVITY_MS - 1, 0], [INACTIVITY_MS, 1], [INACTIVITY_MS + 1, 1]]) {
    const model = fakeModel([userAt(offset)]);
    let sent = 0;
    const result = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async (...args) => { sent += 1; return acceptedBrevo(...args); }, env: { BREVO_API_KEY: 'server-key', PASSWORD_RESET_FROM: 'vuprise@example.test', CLIENT_URL: 'https://vuprise.example' }, logger: { warn() {} } });
    assert.equal(sent, expected);
    assert.equal(result.accepted, expected);
  }
});

test('a user returning before the final pre-send check receives no reminder', async () => {
  const model = fakeModel([userAt(INACTIVITY_MS + 1000)]);
  model.setActiveBeforeCheck();
  let sent = 0;
  const result = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async () => { sent += 1; return acceptedBrevo(); }, env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  assert.equal(sent, 0);
  assert.equal(result.skipped, 1);
});

test('already-notified periods and opted-out users are not sent another reminder', async () => {
  const inactive = userAt(INACTIVITY_MS + 1000, { inactivityReminderSentAt: new Date(NOW.getTime() - 1000) });
  const optOut = userAt(INACTIVITY_MS + 1000, { _id: 'user-2', inactivityRemindersEnabled: false });
  const model = fakeModel([inactive, optOut]);
  let sent = 0;
  await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async () => { sent += 1; return acceptedBrevo(); }, env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  assert.equal(sent, 0);
});

test('activity after a prior reminder creates a fresh eligible inactivity period', async () => {
  const model = fakeModel([userAt(INACTIVITY_MS + 1000, { inactivityReminderSentAt: new Date(NOW.getTime() - INACTIVITY_MS - 5000) })]);
  let sent = 0;
  const result = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async (...args) => { sent += 1; return acceptedBrevo(...args); }, env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  assert.equal(sent, 1);
  assert.equal(result.accepted, 1);
});

test('provider failures release the claim so the next scheduled run can retry', async () => {
  const model = fakeModel([userAt(INACTIVITY_MS + 1000)]);
  const result = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async () => ({ ok: false, json: async () => ({}) }), env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  assert.equal(result.failed, 1);
  assert.equal(model.lastFilter.inactivityRemindersEnabled.$ne, false);
});

test('overlapping cron runs are protected by an atomic claim', async () => {
  const model = fakeModel([userAt(INACTIVITY_MS + 1000)]);
  let sent = 0;
  // The first run claims the fake record before the second one can reserve it.
  const first = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async (...args) => { sent += 1; return acceptedBrevo(...args); }, env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  const second = await processInactivityReminders({ now: NOW, UserModel: model, fetchImpl: async (...args) => { sent += 1; return acceptedBrevo(...args); }, env: { BREVO_API_KEY: 'test' }, logger: { warn() {} } });
  assert.equal(first.accepted, 1);
  assert.equal(second.skipped, 1);
  assert.equal(sent, 1);
});
