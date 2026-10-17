// Server-side client for the local OpenCode HTTP API (http://127.0.0.1:4096 by
// default). Everything here stays on the backend: the browser only talks to
// /api/ai, never to OpenCode directly, so no server address, credential, or
// token is exposed to the client. The API surface used here was verified
// against the running server (GET /doc): POST /session, POST
// /session/:id/message, DELETE /session/:id, GET /global/health.

const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';
const DEFAULT_PROVIDER_ID = 'opencode';
const DEFAULT_MODEL_ID = 'deepseek-v4.1-flash-free';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_SERVER_USERNAME = 'opencode';

// Sessions run in an empty temp directory outside the project so project
// files, CLAUDE.md, or repo content can never enter the model context.
const TEMP_WORKSPACE_DIR = path.join(os.tmpdir(), 'vuprise-ai-chat');

// Public identity: the assistant must only ever present itself as Vuprise AI.
const SYSTEM_PROMPT = 'You are Vuprise AI, the built-in assistant of Vuprise, a professional networking platform. Help users with networking, profile and post drafts, career advice, and general questions. Your name is Vuprise AI. If asked your name, who made you, or what model you are, say only: \'I\'m Vuprise AI, the assistant built into Vuprise.\' Never mention DeepSeek, OpenCode, FlagshipRouter, Claude, any model or provider name, any codebase, repo, file, CLAUDE.md, or tool. You are not a coding agent and have no access to any repository or files. Keep answers concise and friendly.';

// Requests never carry tool definitions. An all-false tools map was tried
// first in earlier revisions, but the free tier rejects any request that
// includes tools (403 FreeTierError), so that attempt only bought a guaranteed
// rejection plus a duplicate call on every fresh process. With no tools defined
// the model cannot invoke any (verified live: plain requests answer with text
// only), which is exactly what a chat assistant wants.

class AiChatError extends Error {
  constructor(message, statusCode = 502, code = 'AI_UPSTREAM_ERROR', upstreamStatus = null, upstreamCause = null) {
    super(message);
    this.name = 'AiChatError';
    this.statusCode = statusCode;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    // Low-level network cause (e.g. ECONNREFUSED, ENOTFOUND, 'timeout') kept
    // for server-side diagnostics only; never sent to the client.
    this.upstreamCause = upstreamCause;
  }
}

const config = () => {
  const parsedTimeout = Number.parseInt(process.env.AI_CHAT_TIMEOUT_MS, 10);
  return {
    baseUrl: (process.env.OPENCODE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    providerId: process.env.OPENCODE_MODEL_PROVIDER || DEFAULT_PROVIDER_ID,
    modelId: process.env.OPENCODE_MODEL_ID || DEFAULT_MODEL_ID,
    // Reasoning/response variant. Verified live against GET /provider: the
    // configured model exposes variants low/high/max, so 'high' is a real,
    // accepted value (also settable via AI_CHAT_VARIANT).
    variant: process.env.AI_CHAT_VARIANT || 'high',
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    // Optional HTTP basic auth for a protected OpenCode server (the same names
    // `opencode serve` documents for OPENCODE_SERVER_PASSWORD/OPENCODE_SERVER_USERNAME).
    username: process.env.OPENCODE_SERVER_USERNAME || DEFAULT_SERVER_USERNAME,
    password: process.env.OPENCODE_SERVER_PASSWORD || ''
  };
};

// The provider address can be logged safely: only the origin is ever used, so
// userinfo, paths, and credentials can never leak through diagnostics.
const safeOrigin = (url) => {
  try { return new URL(url).origin; } catch { return 'invalid-url'; }
};

// Headers for every OpenCode server call. The basic-auth credential is read
// from the server environment only; when no password is configured no
// Authorization header is sent at all.
const upstreamHeaders = (extra) => {
  const { username, password } = config();
  const headers = { ...(extra || {}) };
  if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  return Object.keys(headers).length ? headers : undefined;
};

// Startup diagnostic: names the effective provider target and model exactly
// once at boot (never credentials) and calls out the failure modes that are
// silent today - an invalid URL, and the loopback default on a managed host,
// where nothing runs inside the container and every AI request answers 503
// until OPENCODE_BASE_URL is configured.
const describeAiProvider = (env = process.env) => {
  const configured = String(env.OPENCODE_BASE_URL || '').trim();
  const baseUrl = (configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = `${env.OPENCODE_MODEL_PROVIDER || DEFAULT_PROVIDER_ID}/${env.OPENCODE_MODEL_ID || DEFAULT_MODEL_ID}`;
  let parsed = null;
  try { parsed = new URL(baseUrl); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return { level: 'warn', message: '[ai-chat] OPENCODE_BASE_URL is not a valid http(s) URL; every AI chat request will fail. Set it to the reachable OpenCode server (see docs/production-feature-setup.md).' };
  }
  if (!configured && env.NODE_ENV === 'production') {
    return { level: 'warn', message: `[ai-chat] OPENCODE_BASE_URL is not configured for this deployment (falling back to ${DEFAULT_BASE_URL}). Unless an OpenCode server runs inside this container, AI chat answers 503; set OPENCODE_BASE_URL in the Render environment (see docs/production-feature-setup.md).` };
  }
  return { level: 'info', message: `[ai-chat] provider target ${parsed.origin} (${model}${env.OPENCODE_SERVER_PASSWORD ? ', basic auth' : ''})` };
};

// Users with a request currently awaiting an upstream reply.
const inFlight = new Set();

const fetchWithTimeout = async (url, options, timeoutMs, externalSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      // A client disconnect is an intentional cancellation, not a timeout.
      // Aborting stops this server from waiting on the provider request; a
      // provider that already accepted it may still finish the work on its
      // own side, and that late result is discarded here.
      if (externalSignal?.aborted) throw new AiChatError('The request was stopped.', 499, 'AI_CANCELLED');
      throw new AiChatError('The AI service took too long to respond. Please try again.', 504, 'AI_TIMEOUT', null, 'timeout');
    }
    const cause = error?.cause?.code || error?.cause?.name || error?.code || error?.name || 'unknown';
    throw new AiChatError('The AI service is currently unavailable. Please try again shortly.', 503, 'AI_UNAVAILABLE', null, cause);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
  }
};

// A failing upstream call must be diagnosable from the server log alone
// without leaking anything to clients. The query string is dropped (it can
// carry the temp workspace path) and session ids are collapsed.
const safeUpstreamPath = (path) => String(path).replace(/\?.*$/, '').replace(/\/ses_[A-Za-z0-9]+/g, '/:session');

// Extracts a single sanitized line from an upstream error body such as
// {"name":"UnknownError","data":{"message":"...","ref":"err_..."}}. The text is
// collapsed, truncated, and the configured server password (if any ever
// appears) is redacted before it can reach a log line.
const upstreamErrorDetail = async (response) => {
  try {
    if (typeof response.text !== 'function') return '';
    const text = await response.text();
    if (!text) return '';
    let message = '';
    try {
      const parsed = JSON.parse(text);
      const raw = parsed?.data?.message || parsed?.error?.message || parsed?.message || parsed?.name;
      message = typeof raw === 'string' ? raw : '';
    } catch {
      message = text;
    }
    const { password } = config();
    let detail = message.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (password) detail = detail.split(password).join('[redacted]');
    return detail;
  } catch {
    return '';
  }
};

// Throttled self-diagnosis for upstream 5xx responses. An unknown model or
// provider id makes the OpenCode server answer 500 for every message while
// GET /global/health still succeeds, which otherwise hides a typo in
// OPENCODE_MODEL_ID/OPENCODE_MODEL_PROVIDER behind a generic upstream error.
// One GET /provider names the offered ids in the log; client responses are
// unchanged and provider details are never forwarded to the browser.
let lastModelCheckAt = 0;
const MODEL_CHECK_THROTTLE_MS = 120000;
const logProviderModelMismatch = async () => {
  const now = Date.now();
  if (now - lastModelCheckAt < MODEL_CHECK_THROTTLE_MS) return;
  lastModelCheckAt = now;
  const { baseUrl, providerId, modelId } = config();
  const response = await fetchWithTimeout(`${baseUrl}/provider`, { method: 'GET', headers: upstreamHeaders() }, 5000);
  if (!response.ok) return;
  const payload = await response.json().catch(() => null);
  const providers = Array.isArray(payload?.all) ? payload.all : null;
  if (!providers) return;
  const provider = providers.find((entry) => entry?.id === providerId);
  if (provider && provider.models && Object.keys(provider.models).includes(modelId)) return;
  if (provider) {
    const offered = Object.keys(provider.models || {}).slice(0, 8).join(', ');
    console.warn(`[ai-chat] configured model "${modelId}" is not offered by provider "${providerId}" on the OpenCode server (offered: ${offered || 'none'}). Fix OPENCODE_MODEL_ID in the server environment (see docs/production-feature-setup.md).`);
  } else {
    console.warn(`[ai-chat] configured provider "${providerId}" was not found on the OpenCode server. Fix OPENCODE_MODEL_PROVIDER/OPENCODE_MODEL_ID in the server environment (see docs/production-feature-setup.md).`);
  }
};

const requestJson = async (method, path, body, timeoutMs, signal) => {
  const { baseUrl } = config();
  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl}${path}`, {
      method,
      headers: upstreamHeaders(body ? { 'Content-Type': 'application/json' } : null),
      body: body ? JSON.stringify(body) : undefined
    }, timeoutMs, signal);
  } catch (error) {
    // A silent network failure here is what makes a missing/misconfigured
    // provider look like an opaque 503 in production; one sanitized line (no
    // credentials, payloads, or paths) makes it actionable in host logs.
    if (error instanceof AiChatError && error.code !== 'AI_CANCELLED') {
      console.warn(`[ai-chat] upstream request failed method=${method} target=${safeOrigin(baseUrl)} code=${error.code}${error.upstreamCause ? ` cause=${error.upstreamCause}` : ''}. Check that OPENCODE_BASE_URL points at a reachable OpenCode server (see docs/production-feature-setup.md).`);
    }
    throw error;
  }
  if (!response.ok) {
    // An HTTP-level failure (as opposed to an unreachable provider) needs its
    // own sanitized log line: this is how a rejected model id, a failed auth,
    // or a provider outage becomes distinguishable after the fact.
    try {
      const detail = await upstreamErrorDetail(response);
      console.warn(`[ai-chat] upstream failure method=${method} path=${safeUpstreamPath(path)} status=${response.status}${detail ? ` detail="${detail}"` : ''}`);
      if (response.status >= 500) await logProviderModelMismatch();
    } catch {
      // Diagnostics must never replace the real error.
    }
    throw new AiChatError(
      'The AI service could not complete this request. Please try again.',
      response.status >= 500 ? 503 : 502,
      'AI_UPSTREAM_ERROR',
      response.status
    );
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new AiChatError('The AI service returned an unexpected response.', 502, 'AI_UPSTREAM_ERROR');
  }
};

const isAvailable = async () => {
  try {
    const response = await fetchWithTimeout(`${config().baseUrl}/global/health`, { method: 'GET', headers: upstreamHeaders() }, 4000);
    return response.ok;
  } catch {
    return false;
  }
};

const createSession = async (title = 'Vuprise AI chat', signal) => {
  const { modelId, providerId, variant, timeoutMs } = config();
  fs.mkdirSync(TEMP_WORKSPACE_DIR, { recursive: true });
  // POST /session expects { model: { id, providerID } } (variant optional,
  // verified live) and accepts a ?directory= query param that pins the session
  // workspace outside the project (both verified in the spec and live).
  const session = await requestJson('POST', `/session?directory=${encodeURIComponent(TEMP_WORKSPACE_DIR)}`, {
    title,
    model: { id: modelId, providerID: providerId, variant }
  }, timeoutMs, signal);
  if (!session?.id) throw new AiChatError('The AI service returned an unexpected response.', 502, 'AI_UPSTREAM_ERROR');
  return session.id;
};

const deleteSession = async (sessionId) => {
  if (!sessionId) return;
  try {
    await requestJson('DELETE', `/session/${sessionId}`, null, 10000);
  } catch {
    // Deleting the upstream session is best-effort.
  }
};

const sendMessage = (sessionId, message, { system, variant: variantOverride, fileParts = [], signal } = {}) => {
  const { providerId, modelId, variant, timeoutMs } = config();
  const body = {
    model: { providerID: providerId, modelID: modelId },
    variant: variantOverride || variant,
    system: system || SYSTEM_PROMPT,
    parts: [{ type: 'text', text: message }, ...fileParts]
  };
  return requestJson('POST', `/session/${sessionId}/message`, body, timeoutMs, signal);
};

// One-shot helper used by the intent classifier: opens an ephemeral session,
// runs a single exchange with a custom system prompt and variant, and always
// deletes the session again so classification never pollutes chat history.
const oneShot = async (message, { system, variant, signal } = {}) => {
  let sessionId = null;
  try {
    sessionId = await createSession('Vuprise AI helper', signal);
    const payload = await sendMessage(sessionId, message, { system, variant, signal });
    return extractReply(payload);
  } finally {
    await deleteSession(sessionId);
  }
};

const extractReply = (payload) => {
  if (payload?.info?.error) {
    throw new AiChatError('The AI model could not answer this message. Please try again.', 502, 'AI_MODEL_ERROR');
  }
  const reply = (payload?.parts || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  if (!reply) throw new AiChatError('The AI returned an empty reply. Please try again.', 502, 'AI_EMPTY_REPLY');
  return reply;
};

// Runs one exchange in the given upstream session. Self-heals forgotten
// sessions (404) by opening a fresh session, and returns the session id
// actually used so the caller can persist it. Attached images travel as
// documented FilePartInput entries ({ type, mime, url }).
const chat = async (userId, sessionId, message, { imageUrls = [], signal } = {}) => {
  const key = String(userId);
  if (inFlight.has(key)) {
    throw new AiChatError('Please wait for the current reply before sending another message.', 429, 'AI_BUSY');
  }
  inFlight.add(key);
  try {
    const fileParts = (Array.isArray(imageUrls) ? imageUrls : []).slice(0, 4).map((url) => ({
      type: 'file',
      mime: mimeForImageUrl(url),
      url
    }));
    let activeSessionId = sessionId;
    if (!activeSessionId) activeSessionId = await createSession('Vuprise AI chat', signal);
    let payload;
    try {
      payload = await sendMessage(activeSessionId, message, { fileParts, signal });
    } catch (error) {
      if (error instanceof AiChatError && error.upstreamStatus === 404) {
        await deleteSession(activeSessionId);
        activeSessionId = await createSession('Vuprise AI chat', signal);
        payload = await sendMessage(activeSessionId, message, { fileParts, signal });
      } else {
        throw error;
      }
    }
    return { reply: extractReply(payload), sessionId: activeSessionId };
  } finally {
    inFlight.delete(key);
  }
};

// Shared per-user mutual exclusion across text and image requests: the same
// set chat() uses, exposed so the image path can prevent duplicate submissions
// while a generation is already running.
const acquireUserLock = (userId) => {
  const key = String(userId);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
};

const releaseUserLock = (userId) => { inFlight.delete(String(userId)); };

// Image generation uses the OpenAI-compatible Images API:
//   POST {AI_IMAGE_API_URL}/images/generations
//   body { model, prompt, size, n } -> response { data: [{ url }] } or { data: [{ b64_json }] }
// (verified against the OpenAI Images API reference). Credentials are read
// server-side only; the browser never receives the URL or key, and error
// messages are classified without ever echoing the key.
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const IMAGE_SIZE = '1024x1024';
const IMAGE_UNAVAILABLE_MESSAGE = 'Image generation is not available yet. Ask the Vuprise administrator to configure AI_IMAGE_API_URL and AI_IMAGE_API_KEY (OpenAI-compatible image service) on the server.';

const imageGenerationConfig = () => ({
  apiUrl: (process.env.AI_IMAGE_API_URL || '').trim().replace(/\/+$/, ''),
  apiKey: (process.env.AI_IMAGE_API_KEY || '').trim(),
  model: (process.env.AI_IMAGE_MODEL || '').trim() || DEFAULT_IMAGE_MODEL
});

// "Configured" means both values are present; format problems are reported
// separately by validateImageConfig so they are distinguishable from absence.
const isImageGenerationAvailable = () => {
  const { apiUrl, apiKey } = imageGenerationConfig();
  return Boolean(apiUrl && apiKey);
};

const validateImageConfig = () => {
  const { apiUrl, apiKey } = imageGenerationConfig();
  if (!apiUrl || !apiKey) {
    return { ok: false, code: 'AI_IMAGE_UNAVAILABLE', message: IMAGE_UNAVAILABLE_MESSAGE };
  }
  let parsed = null;
  try { parsed = new URL(apiUrl); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return {
      ok: false,
      code: 'AI_IMAGE_CONFIG_ERROR',
      message: 'Image generation is misconfigured: AI_IMAGE_API_URL must be a full http(s) URL (for example https://api.openai.com/v1). Ask the Vuprise administrator to fix it.'
    };
  }
  return { ok: true };
};

// Removes the API key from any provider-supplied text before it is put into an
// error message or log line.
const redactImageSecret = (text, apiKey) => (
  apiKey && typeof text === 'string' ? text.split(apiKey).join('[redacted]') : text
);

const providerErrorDetail = (payload) => {
  const raw = payload?.error?.message || payload?.message;
  return typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
};

// Maps an upstream HTTP failure to a stable, secret-free code and message so
// missing credentials, bad models, auth failures, and rejected requests are
// all distinguishable by the administrator.
const classifyImageProviderError = (status, payload, apiKey = '') => {
  const detail = redactImageSecret(providerErrorDetail(payload), apiKey);
  const because = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403 || (status === 400 && /credential|api[\s_-]?key|unauthori[sz]ed|forbidden/i.test(detail))) {
    return { code: 'AI_IMAGE_AUTH_FAILED', message: `The image service rejected the server's credentials${because}. Ask the Vuprise administrator to check AI_IMAGE_API_KEY.` };
  }
  if (status === 404 || (status === 400 && /model/i.test(detail))) {
    return { code: 'AI_IMAGE_MODEL_UNSUPPORTED', message: `The configured image model was not accepted by the image service${because}. Ask the Vuprise administrator to check AI_IMAGE_MODEL.` };
  }
  if (status === 429) {
    return { code: 'AI_IMAGE_RATE_LIMITED', message: 'The image service is rate limiting requests right now. Please try again in a few minutes.' };
  }
  if (status === 400 || status === 422) {
    return { code: 'AI_IMAGE_REQUEST_REJECTED', message: `The image service rejected the request${detail ? `: ${detail}` : ''}.` };
  }
  return { code: 'AI_IMAGE_ERROR', message: 'The image service could not create an image. Please try again.' };
};

const sniffImageMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
};

// MIME for FilePartInput entries built from stored attachment URLs.
const mimeForImageUrl = (url) => {
  let pathname = String(url).toLowerCase();
  try { pathname = new URL(url).pathname.toLowerCase(); } catch { /* keep raw */ }
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.webp')) return 'image/webp';
  return 'image/png';
};

// Only the documented OpenAI response shapes are accepted: { data: [{ url }] }
// or { data: [{ b64_json }] }. Anything else is a bad upstream response.
const parseImageResponse = (payload) => {
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (first && typeof first.url === 'string' && /^https?:\/\//.test(first.url)) return { kind: 'url', url: first.url };
  if (first && typeof first.b64_json === 'string' && first.b64_json) return { kind: 'b64', data: first.b64_json };
  throw new AiChatError('The image service returned an unexpected response.', 502, 'AI_IMAGE_BAD_RESPONSE');
};

const MAX_GENERATED_IMAGE_BYTES = 15 * 1024 * 1024;

// Downloads a provider-hosted image. The URL always comes from the configured
// provider's own response; only http(s) is accepted, with a byte cap and the
// same timeout budget, so a poisoned response cannot become an SSRF probe.
const downloadGeneratedImage = async (url, signal) => {
  const { timeoutMs } = config();
  const response = await fetchWithTimeout(url, { method: 'GET' }, Math.max(timeoutMs, 60000), signal);
  if (!response.ok) throw new AiChatError('The image service could not deliver the generated image.', 502, 'AI_IMAGE_ERROR', response.status);
  const declaredLength = Number.parseInt(response.headers?.get?.('content-length') || '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new AiChatError('The image service returned an image that is too large.', 502, 'AI_IMAGE_BAD_RESPONSE');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new AiChatError('The image service returned an image that is too large.', 502, 'AI_IMAGE_BAD_RESPONSE');
  }
  const headerType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
  return { buffer, mime: sniffImageMime(buffer) || (headerType.startsWith('image/') ? headerType : 'image/png') };
};

// Returns the raw image bytes and MIME so the caller can persist them with the
// project's storage layer. Base64 data is decoded here and never stored.
const generateImage = async (prompt, signal) => {
  const validation = validateImageConfig();
  if (!validation.ok) throw new AiChatError(validation.message, 503, validation.code);
  const { apiUrl, apiKey, model } = imageGenerationConfig();
  const { timeoutMs } = config();
  let response;
  try {
    response = await fetchWithTimeout(`${apiUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt, size: IMAGE_SIZE, n: 1 })
    }, Math.max(timeoutMs, 60000), signal);
  } catch (error) {
    if (error instanceof AiChatError && error.code === 'AI_TIMEOUT') {
      throw new AiChatError('The image service took too long to respond. Please try again.', 504, 'AI_IMAGE_TIMEOUT');
    }
    if (error instanceof AiChatError && error.code === 'AI_CANCELLED') throw error;
    throw new AiChatError('The image service could not be reached. Ask the Vuprise administrator to check AI_IMAGE_API_URL.', 502, 'AI_IMAGE_UNREACHABLE');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const { code, message } = classifyImageProviderError(response.status, payload, apiKey);
    console.warn(`[ai-image] upstream failure status=${response.status} code=${code} detail=${message}`);
    throw new AiChatError(message, code === 'AI_IMAGE_RATE_LIMITED' ? 503 : 502, code, response.status);
  }
  const parsed = parseImageResponse(payload);
  if (parsed.kind === 'b64') {
    const buffer = Buffer.from(parsed.data, 'base64');
    if (!buffer.length) throw new AiChatError('The image service returned an unexpected response.', 502, 'AI_IMAGE_BAD_RESPONSE');
    return { buffer, mime: sniffImageMime(buffer) || 'image/png' };
  }
  return downloadGeneratedImage(parsed.url, signal);
};

// Test-only helper so suites can start from a clean state.
const resetStateForTests = () => {
  inFlight.clear();
  lastModelCheckAt = 0;
};

module.exports = { chat, oneShot, acquireUserLock, releaseUserLock, createSession, deleteSession, isAvailable, isImageGenerationAvailable, imageGenerationConfig, validateImageConfig, classifyImageProviderError, parseImageResponse, sniffImageMime, mimeForImageUrl, generateImage, config, describeAiProvider, AiChatError, resetStateForTests, SYSTEM_PROMPT, TEMP_WORKSPACE_DIR };
