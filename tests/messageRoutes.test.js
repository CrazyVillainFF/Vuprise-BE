const test = require('node:test');
const assert = require('node:assert/strict');

test('message routes load with every registered controller callback', () => {
  assert.doesNotThrow(() => require('../routes/messageRoutes'));
});
