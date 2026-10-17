const test = require('node:test');
const assert = require('node:assert/strict');
const AiConversation = require('../models/AiConversation');
const aiImageStorage = require('../services/aiImageStorage');
const aiImageQuota = require('../services/aiImageQuota');
const { listConversations, createConversation, getConversation, sendConversationMessage, validateAttachmentUrls, sanitizeAssistantReply } = require('../controllers/aiController');
const { resetStateForTests, describeAiProvider, SYSTEM_PROMPT, TEMP_WORKSPACE_DIR } = require('../services/aiChatService');
const { installRateLimitCounter } = require('./helpers/rateLimitCounterDouble');

// Mirrors the Express response object closely enough for the controller,
// including the 'close' event used for client-disconnect cancellation.
const response = () => {
  const handlers = {};
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); return this; },
    removeListener(event, handler) { handlers[event] = (handlers[event] || []).filter((item) => item !== handler); return this; },
    simulateClose() { (handlers.close || []).slice().forEach((handler) => handler()); }
  };
};
const jsonResponse = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const user = (id) => ({ _id: id, email: `${id}@example.com` });
const isSessionCreate = (url) => /\/session\?directory=/.test(url);
const replyPayload = (text) => ({ info: { id: 'msg_1' }, parts: [{ type: 'text', text }] });
const classifierReply = (intent, imagePrompt = '') => replyPayload(JSON.stringify({ intent, imagePrompt }));
const isClassifierCall = (options) => {
  try { return String(JSON.parse(options.body).system || '').includes('intent classifier'); } catch { return false; }
};

const withMockFetch = (handler) => {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
};

const withImageEnv = (env, fn) => {
  const keys = ['AI_IMAGE_API_URL', 'AI_IMAGE_API_KEY', 'AI_IMAGE_MODEL'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => { delete process.env[key]; });
  Object.entries(env).forEach(([key, value]) => { process.env[key] = value; });
  return Promise.resolve().then(fn).finally(() => {
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });
};

const withAiEnv = (env, fn) => {
  const keys = ['OPENCODE_BASE_URL', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_MODEL_PROVIDER', 'OPENCODE_MODEL_ID'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => { delete process.env[key]; });
  Object.entries(env).forEach(([key, value]) => { process.env[key] = value; });
  return Promise.resolve().then(fn).finally(() => {
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });
};

const installLimiter = () => installRateLimitCounter({ windowMs: 5 * 60 * 1000, max: 30 });

// In-memory double for the rolling-window quota service so controller tests
// never touch MongoDB. The real reservation/release semantics (including
// release-on-failure) are exercised against mongodb-memory-server in
// aiImageQuota.test.js.
const installImageQuota = ({ limit = 5, used = 0 } = {}) => {
  const original = {
    reserveImageGeneration: aiImageQuota.reserveImageGeneration,
    releaseImageGeneration: aiImageQuota.releaseImageGeneration,
    pruneImageGenerations: aiImageQuota.pruneImageGenerations,
    getImageQuotaStatus: aiImageQuota.getImageQuotaStatus
  };
  const records = new Map();
  const timestampsFor = (userId) => {
    const key = String(userId);
    if (!records.has(key)) {
      records.set(key, Array.from({ length: used }, (_, index) => new Date(Date.now() - (index + 1) * 1000)));
    }
    return records.get(key);
  };
  aiImageQuota.reserveImageGeneration = async (userId, now = new Date()) => {
    const timestamps = timestampsFor(userId);
    if (timestamps.length >= limit) {
      return { allowed: false, reservedAt: null, remaining: 0, nextAvailableAt: new Date(timestamps[0].getTime() + 24 * 60 * 60 * 1000) };
    }
    timestamps.push(now);
    return { allowed: true, reservedAt: now, remaining: limit - timestamps.length, nextAvailableAt: null };
  };
  aiImageQuota.releaseImageGeneration = async (userId, reservedAt) => {
    const timestamps = timestampsFor(userId);
    const index = timestamps.findIndex((at) => at.getTime() === reservedAt.getTime());
    if (index >= 0) timestamps.splice(index, 1);
  };
  aiImageQuota.pruneImageGenerations = async () => {};
  aiImageQuota.getImageQuotaStatus = async (userId) => {
    const timestamps = timestampsFor(userId);
    return { limit, used: timestamps.length, remaining: Math.max(0, limit - timestamps.length), nextAvailableAt: null };
  };
  return {
    countFor: (userId) => timestampsFor(userId).length,
    restore: () => { Object.assign(aiImageQuota, original); }
  };
};

let quota = null;
test.beforeEach(() => { quota = installImageQuota(); });
test.afterEach(() => { quota.restore(); });

const conversationDoc = (overrides = {}) => ({
  _id: 'aic_1',
  title: 'New chat',
  opencodeSessionId: '',
  messages: [],
  lastMessageAt: new Date('2026-01-01T00:00:00Z'),
  saved: false,
  async save() { this.saved = true; },
  ...overrides
});

const PNG_B64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64');

// A message fetch handler that answers classifier calls separately from chat
// calls, mirroring the real classifier-first flow.
const chatFetchHandler = (calls, { intent = 'chat', imagePrompt = '', chatReply = 'Hello from Vuprise AI' } = {}) => {
  let sessions = 0;
  return async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
    if (isSessionCreate(url)) return jsonResponse(200, { id: `ses_${++sessions}` });
    if (options?.method === 'DELETE') return jsonResponse(200, {});
    if (isClassifierCall(options)) return jsonResponse(200, classifierReply(intent, imagePrompt));
    return jsonResponse(200, replyPayload(chatReply));
  };
};

test('a chat message runs the classifier first, then a High-variant upstream session, and persists both sides', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  const calls = [];
  const conversation = conversationDoc();
  const originalFindOne = AiConversation.findOne;
  AiConversation.findOne = (filter) => {
    assert.deepEqual(filter, { _id: 'aic_1', user: 'member-1' });
    return { select: async () => conversation };
  };
  const restore = withMockFetch(chatFetchHandler(calls));
  try {
    const res = response();
    await sendConversationMessage({ user: user('member-1'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.assistantMessage.text, 'Hello from Vuprise AI');
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.messages[0].role, 'user');
    assert.equal(conversation.messages[1].role, 'assistant');
    assert.equal(conversation.saved, true);
    assert.equal(conversation.title, 'Hi there');

    const classifierCall = calls.find((call) => isClassifierCall({ body: JSON.stringify(call.body) }));
    assert.ok(classifierCall, 'classifier call was made');
    assert.equal(classifierCall.body.variant, 'low');
    assert.match(classifierCall.body.parts[0].text, /Hi there/);
    assert.equal(classifierCall.body.tools, undefined, 'no tool definitions are sent');

    const chatCall = calls.filter((call) => call.body?.system === SYSTEM_PROMPT).pop();
    assert.ok(chatCall, 'chat call was made');
    assert.equal(chatCall.body.variant, 'high');
    assert.equal(chatCall.body.tools, undefined, 'no tool definitions are sent');

    const chatSessionId = conversation.opencodeSessionId;
    assert.match(chatSessionId, /^ses_/);
    const classifierSessionId = calls.find((call) => isClassifierCall({ body: JSON.stringify(call.body) })) && 'ses_1';
    assert.notEqual(chatSessionId, classifierSessionId, 'chat session differs from the ephemeral classifier session');
    assert.ok(calls.some((call) => call.url.endsWith('/session/ses_1') && call.method === 'DELETE'), 'classifier session is deleted');
    assert.ok(calls.some((call) => call.url.endsWith(`/session?directory=${encodeURIComponent(TEMP_WORKSPACE_DIR)}`)), 'sessions are pinned to the temp workspace');
    assert.equal(TEMP_WORKSPACE_DIR, '/tmp', 'workspace defaults to a directory that exists on the OpenCode server itself');
    assert.doesNotMatch(TEMP_WORKSPACE_DIR, /\\/, 'workspace has no Windows path separators');
  } finally {
    AiConversation.findOne = originalFindOne;
    restore();
    limiter.restore();
  }
});

test('history endpoints scope every query to the requesting owner', async () => {
  const originalFind = AiConversation.find;
  let listFilter = null;
  AiConversation.find = (filter) => {
    listFilter = filter;
    return { sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }) };
  };
  try {
    const listRes = response();
    await listConversations({ user: user('member-2') }, listRes, (error) => { throw error; });
    assert.equal(listRes.statusCode, 200);
    assert.deepEqual(listFilter, { user: 'member-2' });
  } finally {
    AiConversation.find = originalFind;
  }

  const originalFindOne = AiConversation.findOne;
  let getFilter = null;
  AiConversation.findOne = (filter) => {
    getFilter = filter;
    return { lean: async () => null };
  };
  try {
    const getRes = response();
    await getConversation({ user: user('member-2'), params: { id: 'someone-elses' } }, getRes, (error) => { throw error; });
    assert.equal(getRes.statusCode, 404);
    assert.deepEqual(getFilter, { _id: 'someone-elses', user: 'member-2' });
  } finally {
    AiConversation.findOne = originalFindOne;
  }
});

test('a new AI conversation starts empty and is owned by the creator', async () => {
  const originalCreate = AiConversation.create;
  let created = null;
  AiConversation.create = async (payload) => {
    created = payload;
    return { _id: 'aic_new', title: payload.title, lastMessageAt: new Date('2026-01-01T00:00:00Z') };
  };
  try {
    const res = response();
    await createConversation({ user: user('member-3') }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.user, 'member-3');
    assert.equal(created.title, 'New chat');
    assert.deepEqual(created.messages, []);
    assert.equal(res.body.conversation.id, 'aic_new');
  } finally {
    AiConversation.create = originalCreate;
  }
});

test('image intent without a configured provider fails with the friendly message and persists nothing', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withImageEnv({}, async () => {
    const calls = [];
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(chatFetchHandler(calls, { intent: 'image', imagePrompt: 'a futuristic office' }));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-4'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'AI_IMAGE_TEMPORARILY_UNAVAILABLE');
      assert.equal(res.body.message, 'Image generation is temporarily unavailable.');
      assert.equal(conversation.saved, false);
      assert.equal(conversation.messages.length, 0);
    } finally {
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('image intent with a configured provider generates, stores, and persists only the stored URL', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'test-image-key' }, async () => {
    const calls = [];
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const originalPersist = aiImageStorage.persistGeneratedImage;
    let storedPayload = null;
    aiImageStorage.persistGeneratedImage = async (payload) => {
      storedPayload = payload;
      return { url: 'https://cdn.test/ai/generated.png', publicId: 'ai-images/1' };
    };
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (isClassifierCall(options)) return jsonResponse(200, classifierReply('image', 'a futuristic office, dark theme'));
      if (url === 'https://img.test/v1/images/generations') return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-5'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 201);
      assert.equal(res.body.assistantMessage.imageUrl, 'https://cdn.test/ai/generated.png');
      assert.equal(res.body.assistantMessage.text, '');
      assert.equal(conversation.saved, true);
      assert.equal(conversation.messages.length, 2);
      assert.equal(conversation.messages[1].imageUrl, 'https://cdn.test/ai/generated.png');
      assert.equal(String(conversation.messages[1].imageUrl).startsWith('data:'), false, 'base64 never reaches history');
      assert.ok(Buffer.isBuffer(storedPayload.buffer));
      assert.equal(storedPayload.mime, 'image/png');
      const providerCall = calls.find((call) => call.url === 'https://img.test/v1/images/generations');
      assert.equal(providerCall.body.prompt, 'a futuristic office, dark theme');
      assert.equal(res.body.imageQuota.remaining, 4, 'the response reports the remaining quota');
      assert.equal(quota.countFor('member-5'), 1, 'a successful generation consumes one slot');
    } finally {
      AiConversation.findOne = originalFindOne;
      aiImageStorage.persistGeneratedImage = originalPersist;
      restore();
    }
  });
  limiter.restore();
});

test('a provider that has no credentials fails with the friendly message and logs a sanitized diagnostic', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withImageEnv({ AI_IMAGE_API_URL: 'http://127.0.0.1:20128/v1', AI_IMAGE_API_KEY: 'router-secret-key', AI_IMAGE_MODEL: 'cloudflare-ai/@cf/black-forest-labs/flux-1-schnell' }, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(async (url, options) => {
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (isClassifierCall(options)) return jsonResponse(200, classifierReply('image', 'a futuristic office'));
      if (url === 'http://127.0.0.1:20128/v1/images/generations') {
        return jsonResponse(400, { error: { message: 'No credentials for provider: cloudflare-ai', type: 'invalid_request_error' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-6'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'AI_IMAGE_TEMPORARILY_UNAVAILABLE');
      assert.equal(res.body.message, 'Image generation is temporarily unavailable.');
      assert.equal(conversation.saved, false);
      assert.equal(conversation.messages.length, 0);
      const log = warnings.join('\n');
      assert.match(log, /\[ai-image\] upstream failure status=400 code=AI_IMAGE_AUTH_FAILED/);
      assert.match(log, /No credentials for provider: cloudflare-ai/, 'the provider reason reaches the server log');
      assert.match(log, /AI_IMAGE_API_KEY/, 'the log names the variable to check');
      assert.equal(log.includes('router-secret-key'), false, 'the API key never reaches logs');
      assert.equal(res.body.message.includes('cloudflare-ai'), false, 'provider internals never reach the client');
    } finally {
      console.warn = originalWarn;
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('a storage failure after generation keeps the friendly message and persists nothing', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'test-image-key' }, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const originalPersist = aiImageStorage.persistGeneratedImage;
    aiImageStorage.persistGeneratedImage = async () => { throw new Error('Cloudinary upload failed'); };
    const restore = withMockFetch(async (url, options) => {
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (isClassifierCall(options)) return jsonResponse(200, classifierReply('image', 'a futuristic office'));
      if (url === 'https://img.test/v1/images/generations') return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
      throw new Error(`unexpected fetch ${url}`);
    });
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-7'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'AI_IMAGE_TEMPORARILY_UNAVAILABLE');
      assert.equal(res.body.message, 'Image generation is temporarily unavailable.');
      assert.equal(conversation.saved, false, 'a failed upload leaves no half-written history');
      assert.equal(conversation.messages.length, 0);
      assert.match(errors.join('\n'), /\[ai-image\] storing the generated image failed/);
      assert.match(errors.join('\n'), /Cloudinary upload failed/);
    } finally {
      console.error = originalError;
      AiConversation.findOne = originalFindOne;
      aiImageStorage.persistGeneratedImage = originalPersist;
      restore();
    }
  });
  limiter.restore();
});

test('attachments are validated, passed to the vision model as file parts, and persisted on the user message', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  const calls = [];
  const conversation = conversationDoc();
  const originalFindOne = AiConversation.findOne;
  AiConversation.findOne = () => ({ select: async () => conversation });
  const restore = withMockFetch(chatFetchHandler(calls, { chatReply: 'The image shows a red circle.' }));
  try {
    const res = response();
    await sendConversationMessage({
      user: user('member-6'),
      params: { id: 'aic_1' },
      body: { message: 'What is in this image?', attachments: ['http://localhost:3000/uploads/ai-1.png'] },
      get: () => 'localhost:3000'
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.userMessage.imageUrls.length, 1);
    assert.equal(conversation.messages[0].imageUrls[0], 'http://localhost:3000/uploads/ai-1.png');
    const chatCall = calls.filter((call) => call.body?.system === SYSTEM_PROMPT).pop();
    assert.deepEqual(chatCall.body.parts[1], { type: 'file', mime: 'image/png', url: 'http://localhost:3000/uploads/ai-1.png' });
  } finally {
    AiConversation.findOne = originalFindOne;
    restore();
    limiter.restore();
  }
});

test('attachment URL validation only accepts Vuprise storage and enforces the 4-image limit', () => {
  const req = { get: () => 'localhost:3000' };
  const oldCloud = process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  try {
    assert.deepEqual(validateAttachmentUrls(undefined, req), []);
    assert.deepEqual(validateAttachmentUrls(['http://localhost:3000/uploads/ai-1.png'], req), ['http://localhost:3000/uploads/ai-1.png']);
    assert.equal(validateAttachmentUrls(['https://evil.example.com/track.png'], req), null);
    assert.equal(validateAttachmentUrls(['ftp://localhost:3000/uploads/ai-1.png'], req), null);
    assert.equal(validateAttachmentUrls(['http://other-host/uploads/ai-1.png'], req), null);
    assert.equal(validateAttachmentUrls(['not a url'], req), null);
    assert.equal(validateAttachmentUrls(new Array(5).fill('http://localhost:3000/uploads/ai-1.png'), req), null);

    process.env.CLOUDINARY_CLOUD_NAME = 'vuprise-cloud';
    assert.deepEqual(
      validateAttachmentUrls(['https://res.cloudinary.com/vuprise-cloud/image/upload/v1/nexora/ai-chat/x.png'], req),
      ['https://res.cloudinary.com/vuprise-cloud/image/upload/v1/nexora/ai-chat/x.png']
    );
    assert.equal(validateAttachmentUrls(['https://res.cloudinary.com/other-cloud/image/upload/v1/x.png'], req), null);
  } finally {
    if (oldCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = oldCloud;
  }
});

test('invalid attachment payloads are rejected before any classifier or model call', async () => {
  const limiter = installLimiter();
  let fetched = false;
  const restore = withMockFetch(async () => { fetched = true; return jsonResponse(200, {}); });
  try {
    const res = response();
    await sendConversationMessage({
      user: user('member-7'),
      params: { id: 'aic_1' },
      body: { message: 'What is in this image?', attachments: ['https://evil.example.com/track.png'] },
      get: () => 'localhost:3000'
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /uploaded through Vuprise/);
    assert.equal(fetched, false);
  } finally {
    restore();
    limiter.restore();
  }
});

test('a vision request that the model rejects fails with an honest limitation message and persists nothing', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  const conversation = conversationDoc();
  const originalFindOne = AiConversation.findOne;
  AiConversation.findOne = () => ({ select: async () => conversation });
  const restore = withMockFetch(async (url, options) => {
    if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
    if (options?.method === 'DELETE') return jsonResponse(200, {});
    if (isClassifierCall(options)) return jsonResponse(200, classifierReply('chat'));
    return jsonResponse(400, { error: 'model does not support image input' });
  });
  try {
    const res = response();
    await sendConversationMessage({
      user: user('member-8'),
      params: { id: 'aic_1' },
      body: { message: 'What is in this image?', attachments: ['http://localhost:3000/uploads/ai-1.png'] },
      get: () => 'localhost:3000'
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'AI_VISION_UNAVAILABLE');
    assert.match(res.body.message, /does not support image input/);
    assert.equal(conversation.saved, false);
  } finally {
    AiConversation.findOne = originalFindOne;
    restore();
    limiter.restore();
  }
});

test('a client disconnect aborts upstream work and leaves history and quota untouched', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  const conversation = conversationDoc();
  const originalFindOne = AiConversation.findOne;
  AiConversation.findOne = () => ({ select: async () => conversation });
  const restore = withMockFetch(async (url, options) => {
    if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
    if (options?.method === 'DELETE') return jsonResponse(200, {});
    if (isClassifierCall(options)) return jsonResponse(200, classifierReply('chat'));
    const abortError = () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return error;
    };
    if (options?.signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  });
  try {
    const res = response();
    const pending = sendConversationMessage({ user: user('member-stop'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
    await new Promise((resolve) => setImmediate(resolve));
    res.simulateClose();
    await pending;
    assert.equal(conversation.saved, false, 'nothing is persisted after a disconnect');
    assert.equal(res.body, null, 'no response body is written after a disconnect');
    assert.equal(res.statusCode, 200, 'the response is left untouched');
  } finally {
    AiConversation.findOne = originalFindOne;
    restore();
    limiter.restore();
  }
});

test('the sixth image generation inside 24 hours is rejected with the quota response and no provider call', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  quota.restore();
  quota = installImageQuota({ used: 5 });
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'test-image-key' }, async () => {
    const calls = [];
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (isClassifierCall(options)) return jsonResponse(200, classifierReply('image', 'a futuristic office'));
      if (url === 'https://img.test/v1/images/generations') return jsonResponse(200, { data: [{ b64_json: PNG_B64 }] });
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-quota'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 429);
      assert.equal(res.body.code, 'AI_IMAGE_QUOTA_EXCEEDED');
      assert.equal(res.body.message, "You've reached your limit of 5 AI images in 24 hours. Please try again later.");
      assert.equal(res.body.remaining, 0);
      assert.equal(res.body.limit, 5);
      assert.ok(res.body.nextAvailableAt, 'the retry time is included');
      assert.equal(conversation.saved, false, 'a quota rejection persists nothing');
      assert.equal(calls.some((call) => call.url === 'https://img.test/v1/images/generations'), false, 'the provider is never called once the quota is spent');
    } finally {
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('a generation failure releases its quota reservation so a retry is not charged', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withImageEnv({}, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(chatFetchHandler([], { intent: 'image', imagePrompt: 'a futuristic office' }));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-refund'), params: { id: 'aic_1' }, body: { message: 'Create an image of a futuristic office' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(quota.countFor('member-refund'), 0, 'a failed generation does not consume quota');
    } finally {
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('the reply scrubber keeps the public identity free of model and provider names', () => {
  assert.equal(sanitizeAssistantReply('I am deepseek-v4.1-flash-free via OpenCode'), 'I am Vuprise AI via Vuprise AI');
});

test('an unreachable OpenCode server fails with the retryable 503 and logs a sanitized diagnostic', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withAiEnv({}, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-down'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'AI_UNAVAILABLE');
      assert.equal(res.body.message, 'The AI service is currently unavailable. Please try again shortly.');
      assert.equal(conversation.saved, false, 'a failed provider call persists nothing');
      const log = warnings.join('\n');
      assert.match(log, /\[ai-chat\] upstream request failed/);
      assert.match(log, /target=http:\/\/127\.0\.0\.1:4096/);
      assert.match(log, /cause=ECONNREFUSED/, 'the network cause reaches the server log');
      assert.match(log, /OPENCODE_BASE_URL/, 'the log names the variable to check');
      assert.equal(res.body.message.includes('ECONNREFUSED'), false, 'network internals never reach the client');
    } finally {
      console.warn = originalWarn;
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('an upstream 5xx logs the provider detail and names a mismatched configured model', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withAiEnv({ OPENCODE_BASE_URL: 'http://10.0.0.7:4096', OPENCODE_MODEL_ID: 'not-an-offered-model' }, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const unknownError = () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_test' } }),
      json: async () => ({})
    });
    const calls = [];
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method });
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (String(url).endsWith('/provider')) return jsonResponse(200, { all: [{ id: 'opencode', models: { 'offered-model-id': {} } }] });
      if (isClassifierCall(options)) return unknownError();
      return unknownError();
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-badmodel'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.code, 'AI_UPSTREAM_ERROR');
      assert.equal(res.body.message, 'The AI service could not complete this request. Please try again.');
      assert.equal(conversation.saved, false, 'a failed provider call persists nothing');
      const log = warnings.join('\n');
      assert.match(log, /\[ai-chat\] upstream failure method=POST path=\/session\/:session\/message status=500/);
      assert.match(log, /detail="Unexpected server error\. Check server logs for details\."/);
      assert.match(log, /configured model "not-an-offered-model" is not offered by provider "opencode"/);
      assert.match(log, /offered: offered-model-id/, 'the log names the ids the server does offer');
      assert.match(log, /OPENCODE_MODEL_ID/, 'the log names the variable to fix');
      assert.equal(calls.filter((call) => String(call.url).endsWith('/provider')).length, 1, 'the model list is checked once per throttle window');
      assert.equal(res.body.message.includes('Unexpected server error'), false, 'provider internals never reach the client');
    } finally {
      console.warn = originalWarn;
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('an upstream auth rejection logs the status without probing the model list', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withAiEnv({ OPENCODE_BASE_URL: 'http://10.0.0.7:4096' }, async () => {
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const calls = [];
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      return { ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({}) };
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-401'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 502);
      assert.equal(res.body.code, 'AI_UPSTREAM_ERROR');
      const log = warnings.join('\n');
      assert.match(log, /\[ai-chat\] upstream failure method=POST path=\/session status=401 detail="Unauthorized"/);
      assert.equal(calls.some((call) => String(call.url).endsWith('/provider')), false, 'no model probe for non-5xx failures');
      assert.equal(res.body.message.includes('Unauthorized'), false, 'provider internals never reach the client');
    } finally {
      console.warn = originalWarn;
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('HTTP basic credentials from the environment are attached to every upstream request and never echoed', async () => {
  resetStateForTests();
  const limiter = installLimiter();
  await withAiEnv({ OPENCODE_BASE_URL: 'http://10.0.0.7:4096', OPENCODE_SERVER_PASSWORD: 'vuprise-secret', OPENCODE_SERVER_USERNAME: 'vuprise' }, async () => {
    const calls = [];
    const conversation = conversationDoc();
    const originalFindOne = AiConversation.findOne;
    AiConversation.findOne = () => ({ select: async () => conversation });
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method, headers: options?.headers || {} });
      if (isSessionCreate(url)) return jsonResponse(200, { id: 'ses_1' });
      if (options?.method === 'DELETE') return jsonResponse(200, {});
      if (isClassifierCall(options)) return jsonResponse(200, classifierReply('chat'));
      return jsonResponse(200, replyPayload('Hello from Vuprise AI'));
    });
    try {
      const res = response();
      await sendConversationMessage({ user: user('member-auth'), params: { id: 'aic_1' }, body: { message: 'Hi there' }, get: () => 'localhost' }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 201);
      const expected = `Basic ${Buffer.from('vuprise:vuprise-secret').toString('base64')}`;
      assert.ok(calls.length >= 3, 'session, classifier, and chat calls were made');
      calls.forEach((call) => assert.equal(call.headers.Authorization, expected, `authorization missing for ${call.method} ${call.url}`));
      assert.equal(JSON.stringify(res.body).includes('vuprise-secret'), false, 'the password never reaches the response');
    } finally {
      AiConversation.findOne = originalFindOne;
      restore();
    }
  });
  limiter.restore();
});

test('no Authorization header is sent when no server password is configured', async () => {
  resetStateForTests();
  await withAiEnv({}, async () => {
    const calls = [];
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, headers: options?.headers || {} });
      return jsonResponse(200, { healthy: true, version: '1.19.2' });
    });
    try {
      const { isAvailable } = require('../services/aiChatService');
      assert.equal(await isAvailable(), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.Authorization, undefined);
    } finally {
      restore();
    }
  });
});

test('the startup provider diagnostic names the configuration problem without leaking credentials', () => {
  const productionDefault = describeAiProvider({ NODE_ENV: 'production' });
  assert.equal(productionDefault.level, 'warn');
  assert.match(productionDefault.message, /OPENCODE_BASE_URL is not configured/);
  assert.match(productionDefault.message, /127\.0\.0\.1:4096/);

  const invalid = describeAiProvider({ OPENCODE_BASE_URL: 'not a url' });
  assert.equal(invalid.level, 'warn');
  assert.match(invalid.message, /not a valid http\(s\) URL/);

  const configured = describeAiProvider({ OPENCODE_BASE_URL: 'https://ai.internal.example:4096', OPENCODE_SERVER_PASSWORD: 'top-secret' });
  assert.equal(configured.level, 'info');
  assert.match(configured.message, /https:\/\/ai\.internal\.example:4096/);
  assert.match(configured.message, /opencode\/deepseek-v4\.1-flash-free/);
  assert.match(configured.message, /basic auth/);
  assert.equal(configured.message.includes('top-secret'), false, 'the password never reaches the boot log');
});
