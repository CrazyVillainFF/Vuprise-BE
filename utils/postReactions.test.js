const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePostReaction, togglePostReaction } = require('./postReactions');

test('accepts supported post reactions and rejects unknown emoji', () => {
  assert.equal(normalizePostReaction('🎉'), '🎉');
  assert.equal(normalizePostReaction('💡'), '💡');
  assert.equal(normalizePostReaction('🧨'), null);
  assert.equal(normalizePostReaction(undefined), null);
});

test('adds a reaction without removing reactions from other users', () => {
  assert.deepEqual(togglePostReaction([{ user: 'user-2', emoji: '❤️' }], 'user-1', '🎉'), [
    { user: 'user-2', emoji: '❤️' },
    { user: 'user-1', emoji: '🎉' }
  ]);
});

test('clicking the active reaction removes it and changing emoji replaces it', () => {
  const current = [{ user: 'user-1', emoji: '👍' }, { user: 'user-2', emoji: '💡' }];
  assert.deepEqual(togglePostReaction(current, 'user-1', '👍'), [{ user: 'user-2', emoji: '💡' }]);
  assert.deepEqual(togglePostReaction(current, 'user-1', '🎉'), [
    { user: 'user-2', emoji: '💡' },
    { user: 'user-1', emoji: '🎉' }
  ]);
});
