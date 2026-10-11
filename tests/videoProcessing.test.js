const test = require('node:test');
const assert = require('node:assert/strict');
const { getClipRange, MAX_VIDEO_SECONDS } = require('../utils/videoProcessing');

test('video clip range accepts exactly 35 seconds', () => {
  assert.deepEqual(getClipRange(70, 10, 45), { start: 10, end: 45, duration: 35 });
  assert.equal(MAX_VIDEO_SECONDS, 35);
});

test('video clip range rejects any selection longer than 35 seconds', () => {
  assert.throws(() => getClipRange(70, 10, 45.001), /35 seconds or less/);
});

test('video clip range rejects invalid or out-of-source timestamps', () => {
  assert.throws(() => getClipRange(20, -1, 10), /valid start and end/);
  assert.throws(() => getClipRange(20, 10, 9), /valid start and end/);
  assert.throws(() => getClipRange(20, 0, 21), /valid start and end/);
});
