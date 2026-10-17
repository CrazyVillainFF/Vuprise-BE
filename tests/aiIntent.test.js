const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClassifierOutput, classifyImageIntent, CLASSIFIER_SYSTEM_PROMPT } = require('../services/aiIntentService');

const withMockFetch = (handler) => {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
};

const jsonResponse = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const replyPayload = (text) => ({ info: { id: 'msg_1' }, parts: [{ type: 'text', text }] });

test('classifier output validation accepts plain, fenced, and prose-wrapped JSON', () => {
  assert.deepEqual(
    parseClassifierOutput('{"intent":"image","imagePrompt":"a futuristic office"}'),
    { intent: 'image', imagePrompt: 'a futuristic office' }
  );
  assert.deepEqual(
    parseClassifierOutput('```json\n{"intent":"image","imagePrompt":"a logo"}\n```'),
    { intent: 'image', imagePrompt: 'a logo' }
  );
  assert.deepEqual(
    parseClassifierOutput('Sure! {"intent":"chat","imagePrompt":""} — done'),
    { intent: 'chat', imagePrompt: '' }
  );
});

test('classifier output validation fails safe to chat for invalid shapes', () => {
  const chat = { intent: 'chat', imagePrompt: '' };
  assert.deepEqual(parseClassifierOutput('not json at all'), chat);
  assert.deepEqual(parseClassifierOutput('{"intent":"video","imagePrompt":"x"}'), chat);
  assert.deepEqual(parseClassifierOutput('{"intent":"image"}'), chat);
  assert.deepEqual(parseClassifierOutput(''), chat);
  assert.deepEqual(parseClassifierOutput(null), chat);
  assert.deepEqual(parseClassifierOutput('{"intent":"image","imagePrompt":123}'), chat);
});

test('an image intent with an empty prompt is expanded with Vuprise design guidance instead of asking questions', () => {
  const result = parseClassifierOutput('{"intent":"image","imagePrompt":"  "}', 'Make a banner');
  assert.equal(result.intent, 'image');
  assert.match(result.imagePrompt, /Make a banner/);
  assert.match(result.imagePrompt, /dark theme/);
  assert.match(result.imagePrompt, /star-burst/);
});

test('classifyImageIntent routes the required prompts through the classifier reply', async () => {
  const prompts = [
    'Create an image of a futuristic office',
    'Generate a logo for Vuprise',
    'Make a banner',
    'Draw a professional networking illustration',
    'Create a Image For This Vuprise Website'
  ];
  for (const prompt of prompts) {
    let sawClassifierSystem = false;
    const restore = withMockFetch(async (url, options) => {
      if (/\/session\?directory=/.test(url)) return jsonResponse(200, { id: 'ses_classify' });
      if (/\/session\/ses_classify$/.test(url) && options?.method === 'DELETE') return jsonResponse(200, {});
      const body = JSON.parse(options.body);
      assert.equal(body.system, CLASSIFIER_SYSTEM_PROMPT);
      assert.equal(body.variant, 'low');
      sawClassifierSystem = true;
      return jsonResponse(200, replyPayload('{"intent":"image","imagePrompt":"expanded prompt"}'));
    });
    try {
      const result = await classifyImageIntent(prompt);
      assert.equal(sawClassifierSystem, true);
      assert.deepEqual(result, { intent: 'image', imagePrompt: 'expanded prompt' });
    } finally {
      restore();
    }
  }
});

test('classifyImageIntent falls back to chat when the classifier fails or answers garbage', async () => {
  const restore = withMockFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    assert.deepEqual(await classifyImageIntent('Give me three post ideas about a project I just shipped.'), { intent: 'chat', imagePrompt: '' });
  } finally {
    restore();
  }

  const restoreGarbage = withMockFetch(async (url) => {
    if (/\/session\?directory=/.test(url)) return jsonResponse(200, { id: 'ses_garbage' });
    return jsonResponse(200, replyPayload('I think you want an image!'));
  });
  try {
    assert.deepEqual(await classifyImageIntent('How should I prepare for a networking event this week?'), { intent: 'chat', imagePrompt: '' });
  } finally {
    restoreGarbage();
  }
});

test('an image-shaped request still routes to image when the classifier fails, but a valid chat verdict is never overridden', async () => {
  const restoreFailure = withMockFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    const result = await classifyImageIntent('Generate a logo for Vuprise');
    assert.equal(result.intent, 'image');
    assert.match(result.imagePrompt, /Generate a logo for Vuprise/);
    assert.match(result.imagePrompt, /star-burst/);
  } finally {
    restoreFailure();
  }

  const restoreChat = withMockFetch(async (url) => {
    if (/\/session\?directory=/.test(url)) return jsonResponse(200, { id: 'ses_chat' });
    return jsonResponse(200, replyPayload('{"intent":"chat","imagePrompt":""}'));
  });
  try {
    assert.deepEqual(await classifyImageIntent('Create a Image For This Vuprise Website'), { intent: 'chat', imagePrompt: '' });
  } finally {
    restoreChat();
  }
});
