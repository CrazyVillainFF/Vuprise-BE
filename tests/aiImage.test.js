const test = require('node:test');
const assert = require('node:assert/strict');
const {
  imageGenerationConfig,
  validateImageConfig,
  classifyImageProviderError,
  parseImageResponse,
  sniffImageMime,
  generateImage,
  AiChatError
} = require('../services/aiChatService');

const IMAGE_ENV_KEYS = ['AI_IMAGE_API_URL', 'AI_IMAGE_API_KEY', 'AI_IMAGE_MODEL'];

const withImageEnv = (env, fn) => {
  const saved = Object.fromEntries(IMAGE_ENV_KEYS.map((key) => [key, process.env[key]]));
  IMAGE_ENV_KEYS.forEach((key) => { delete process.env[key]; });
  Object.entries(env).forEach(([key, value]) => { if (value !== undefined) process.env[key] = value; });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      IMAGE_ENV_KEYS.forEach((key) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      });
    });
};

const withMockFetch = (handler) => {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
};

const jsonResponse = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

const expectAiChatError = async (promise, code, statusCode) => {
  try {
    await promise;
    assert.fail(`expected AiChatError ${code}`);
  } catch (error) {
    assert.ok(error instanceof AiChatError);
    assert.equal(error.code, code);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    return error;
  }
};

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const pngBufferResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: (name) => (name === 'content-type' ? 'image/png' : null) },
  arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength)
});

test('image config is unavailable when either value is missing and invalid URLs are reported separately', async () => {
  await withImageEnv({}, () => {
    const result = validateImageConfig();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AI_IMAGE_UNAVAILABLE');
    assert.match(result.message, /AI_IMAGE_API_URL/);
    assert.match(result.message, /AI_IMAGE_API_KEY/);
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1' }, () => {
    assert.equal(validateImageConfig().code, 'AI_IMAGE_UNAVAILABLE');
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'not a url', AI_IMAGE_API_KEY: 'secret-key' }, () => {
    const result = validateImageConfig();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AI_IMAGE_CONFIG_ERROR');
    assert.match(result.message, /http\(s\)/);
    assert.equal(result.message.includes('secret-key'), false);
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'ftp://img.test/v1', AI_IMAGE_API_KEY: 'secret-key' }, () => {
    assert.equal(validateImageConfig().code, 'AI_IMAGE_CONFIG_ERROR');
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1/', AI_IMAGE_API_KEY: 'secret-key' }, () => {
    assert.equal(validateImageConfig().ok, true);
    assert.equal(imageGenerationConfig().apiUrl, 'https://img.test/v1');
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'http://127.0.0.1:20128/v1', AI_IMAGE_API_KEY: 'secret-key' }, () => {
    assert.equal(validateImageConfig().ok, true);
  });
});

test('image model defaults to gpt-image-1 and can be overridden', async () => {
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'k' }, () => {
    assert.equal(imageGenerationConfig().model, 'gpt-image-1');
  });
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'k', AI_IMAGE_MODEL: 'custom-image-model' }, () => {
    assert.equal(imageGenerationConfig().model, 'custom-image-model');
  });
});

test('image responses are parsed for both url and base64 payloads', () => {
  assert.deepEqual(parseImageResponse({ data: [{ url: 'https://cdn.test/image.png' }] }), { kind: 'url', url: 'https://cdn.test/image.png' });
  assert.deepEqual(parseImageResponse({ data: [{ b64_json: 'aGVsbG8=' }] }), { kind: 'b64', data: 'aGVsbG8=' });
  assert.deepEqual(parseImageResponse({ data: [{ url: 'https://cdn.test/image.png', b64_json: 'aGVsbG8=' }] }), { kind: 'url', url: 'https://cdn.test/image.png' });

  assert.throws(() => parseImageResponse({ data: [] }), (error) => error instanceof AiChatError && error.code === 'AI_IMAGE_BAD_RESPONSE');
  assert.throws(() => parseImageResponse(null), (error) => error instanceof AiChatError && error.code === 'AI_IMAGE_BAD_RESPONSE');
  assert.throws(() => parseImageResponse({ data: [{ url: 'not-a-url' }] }), (error) => error.code === 'AI_IMAGE_BAD_RESPONSE');
  assert.throws(() => parseImageResponse({ data: [{ b64_json: '' }] }), (error) => error.code === 'AI_IMAGE_BAD_RESPONSE');
});

test('generated image bytes are sniffed for their real MIME type', () => {
  assert.equal(sniffImageMime(PNG_BYTES), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('not an image')), '');
});

test('provider failures are classified into distinct codes without exposing secrets', () => {
  const key = 'super-secret-key';
  const openAiError = (message) => ({ error: { message, type: 'invalid_request_error' } });

  assert.equal(classifyImageProviderError(401, openAiError('Incorrect API key provided'), key).code, 'AI_IMAGE_AUTH_FAILED');
  assert.equal(classifyImageProviderError(403, openAiError('Forbidden'), key).code, 'AI_IMAGE_AUTH_FAILED');
  const noCredentials = classifyImageProviderError(400, openAiError('No credentials for provider: openai'), key);
  assert.equal(noCredentials.code, 'AI_IMAGE_AUTH_FAILED');
  assert.match(noCredentials.message, /No credentials for provider: openai/, 'the sanitized upstream reason is kept for server-side diagnostics');
  assert.match(noCredentials.message, /AI_IMAGE_API_KEY/);
  assert.equal(classifyImageProviderError(404, openAiError('model not found'), key).code, 'AI_IMAGE_MODEL_UNSUPPORTED');
  assert.equal(classifyImageProviderError(400, openAiError('unknown model gpt-image-9'), key).code, 'AI_IMAGE_MODEL_UNSUPPORTED');
  assert.match(classifyImageProviderError(404, openAiError('model not found'), key).message, /model not found/);
  assert.equal(classifyImageProviderError(429, openAiError('rate limit reached'), key).code, 'AI_IMAGE_RATE_LIMITED');
  assert.equal(classifyImageProviderError(500, openAiError('internal error'), key).code, 'AI_IMAGE_ERROR');

  const keyed = classifyImageProviderError(401, openAiError(`bad auth for ${key}`), key);
  assert.equal(keyed.message.includes(key), false);
  assert.match(keyed.message, /\[redacted\]/);

  const rejected = classifyImageProviderError(400, openAiError('size must be one of 1024x1024'), key);
  assert.equal(rejected.code, 'AI_IMAGE_REQUEST_REJECTED');
  assert.match(rejected.message, /size must be one of 1024x1024/);

  const leaking = classifyImageProviderError(400, openAiError(`bad request for key ${key}`), key);
  assert.equal(leaking.message.includes(key), false);
  assert.match(leaking.message, /\[redacted\]/);
});

test('generateImage calls the OpenAI-compatible endpoint and returns decoded image bytes', async () => {
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1/', AI_IMAGE_API_KEY: 'test-image-key', AI_IMAGE_MODEL: 'gpt-image-1' }, async () => {
    const calls = [];
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, { data: [{ b64_json: PNG_BYTES.toString('base64') }] });
    });
    try {
      const result = await generateImage('a red circle');
      assert.deepEqual(result.buffer, PNG_BYTES);
      assert.equal(result.mime, 'image/png');
      assert.equal(calls[0].url, 'https://img.test/v1/images/generations');
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer test-image-key');
      assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'gpt-image-1', prompt: 'a red circle', size: '1024x1024', n: 1 });
    } finally {
      restore();
    }
  });
});

test('generateImage downloads provider-hosted urls safely and caps the response', async () => {
  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'test-image-key' }, async () => {
    const calls = [];
    const restore = withMockFetch(async (url, options) => {
      calls.push({ url, method: options?.method });
      if (url === 'https://img.test/v1/images/generations') return jsonResponse(200, { data: [{ url: 'https://cdn.test/generated.png' }] });
      if (url === 'https://cdn.test/generated.png') return pngBufferResponse();
      if (url === 'https://cdn.test/huge.png') return { ...pngBufferResponse(), headers: { get: (name) => (name === 'content-length' ? String(20 * 1024 * 1024) : name === 'content-type' ? 'image/png' : null) } };
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await generateImage('a blue square');
      assert.deepEqual(result.buffer, PNG_BYTES);
      assert.equal(result.mime, 'image/png');
      assert.equal(calls[1].url, 'https://cdn.test/generated.png');

      const restoreHuge = withMockFetch(async (url) => (url === 'https://img.test/v1/images/generations'
        ? jsonResponse(200, { data: [{ url: 'https://cdn.test/huge.png' }] })
        : { ...pngBufferResponse(), headers: { get: (name) => (name === 'content-length' ? String(20 * 1024 * 1024) : null) } }));
      try {
        await expectAiChatError(generateImage('anything'), 'AI_IMAGE_BAD_RESPONSE');
      } finally {
        restoreHuge();
      }
    } finally {
      restore();
    }
  });
});

test('generateImage surfaces missing config, auth failures, unreachable services, and timeouts distinctly', async () => {
  await withImageEnv({}, async () => {
    await expectAiChatError(generateImage('anything'), 'AI_IMAGE_UNAVAILABLE', 503);
  });

  await withImageEnv({ AI_IMAGE_API_URL: 'https://img.test/v1', AI_IMAGE_API_KEY: 'test-image-key' }, async () => {
    let restore = withMockFetch(async () => jsonResponse(401, { error: { message: 'Incorrect API key provided: test-image-key' } }));
    try {
      const error = await expectAiChatError(generateImage('anything'), 'AI_IMAGE_AUTH_FAILED', 502);
      assert.equal(error.message.includes('test-image-key'), false);
    } finally {
      restore();
    }

    restore = withMockFetch(async () => { throw new TypeError('fetch failed'); });
    try {
      await expectAiChatError(generateImage('anything'), 'AI_IMAGE_UNREACHABLE', 502);
    } finally {
      restore();
    }

    restore = withMockFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    try {
      await expectAiChatError(generateImage('anything'), 'AI_IMAGE_TIMEOUT', 504);
    } finally {
      restore();
    }

    restore = withMockFetch(async () => jsonResponse(404, { error: { message: 'model not found' } }));
    try {
      await expectAiChatError(generateImage('anything'), 'AI_IMAGE_MODEL_UNSUPPORTED', 502);
    } finally {
      restore();
    }
  });
});
