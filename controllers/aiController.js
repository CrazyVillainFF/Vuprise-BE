const AiConversation = require('../models/AiConversation');
const { chat, acquireUserLock, releaseUserLock, deleteSession, isAvailable, generateImage, AiChatError } = require('../services/aiChatService');
const aiImageStorage = require('../services/aiImageStorage');
const aiImageQuota = require('../services/aiImageQuota');
const { classifyImageIntent } = require('../services/aiIntentService');
const { processUploadedMedia, discardUploadedFile } = require('../middleware/uploadMiddleware');
const { consumeLimitSafe } = require('../utils/apiRateLimit');

const MESSAGE_MAX_LENGTH = 2000;
const ATTACHMENT_LIMIT = 4;
const CHAT_WINDOW_MS = 5 * 60 * 1000;
const CHAT_MAX_MESSAGES = 30;
const IMAGE_WINDOW_MS = 5 * 60 * 1000;
const IMAGE_MAX_PER_WINDOW = 10;
const HISTORY_MESSAGE_LIMIT = 200;
const CONVERSATION_LIST_LIMIT = 50;
const IMAGE_UNAVAILABLE_USER_MESSAGE = 'Image generation is temporarily unavailable.';
const IMAGE_QUOTA_USER_MESSAGE = `You've reached your limit of ${aiImageQuota.AI_IMAGE_DAILY_LIMIT} AI images in 24 hours. Please try again later.`;
const IMAGE_EDIT_LIMITATION_MESSAGE = 'I can create brand-new images from a text description, but editing or transforming attached photos is not supported yet. Remove the attachment and send the request again to generate a new image.';

// Upstream AI failures surface as 502/503/504 with a friendly message instead
// of crashing the request pipeline. Anything unexpected goes to the shared
// error middleware.
const handleAiError = (res, next, error) => {
  if (error instanceof AiChatError) {
    return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
  }
  return next(error);
};

const fail = (res, statusCode, message, code, extra) => res.status(statusCode).json({ success: false, code, message, ...(extra || {}) });

// The assistant's public identity is only "Vuprise AI": scrub any model or
// provider name that may slip through a reply before it reaches the browser.
const IDENTITY_SCRUBBERS = [
  [/deepseek-v4\.1-flash-free/gi, 'Vuprise AI'],
  [/deepseek/gi, 'Vuprise AI'],
  [/opencode/gi, 'Vuprise AI'],
  [/flagshiprouter/gi, 'Vuprise AI']
];

const sanitizeAssistantReply = (text) => {
  if (typeof text !== 'string') return text;
  return IDENTITY_SCRUBBERS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
};

// Loads a conversation scoped to its owner. Every history request goes through
// this so one member can never read another member's AI conversations.
const findOwnedConversation = (userId, id) => AiConversation.findOne({ _id: id, user: userId });

const toSummary = (conversation) => ({
  id: conversation._id,
  title: conversation.title,
  lastMessageAt: conversation.lastMessageAt,
  preview: conversation.messages?.length
    ? (conversation.messages[conversation.messages.length - 1].imageUrl ? 'Generated image' : conversation.messages[conversation.messages.length - 1].text || '')
    : ''
});

// GET /api/ai/conversations
const listConversations = async (req, res, next) => {
  try {
    const conversations = await AiConversation.find({ user: req.user._id })
      .sort({ lastMessageAt: -1 })
      .limit(CONVERSATION_LIST_LIMIT)
      .select('title lastMessageAt messages.text messages.imageUrl messages.createdAt')
      .lean();
    return res.status(200).json({ success: true, conversations: conversations.map(toSummary) });
  } catch (error) {
    return next(error);
  }
};

// POST /api/ai/conversations
const createConversation = async (req, res, next) => {
  try {
    const conversation = await AiConversation.create({ user: req.user._id, title: 'New chat', messages: [] });
    return res.status(201).json({ success: true, conversation: { id: conversation._id, title: conversation.title, lastMessageAt: conversation.lastMessageAt, preview: '' } });
  } catch (error) {
    return next(error);
  }
};

// GET /api/ai/conversations/:id
const getConversation = async (req, res, next) => {
  try {
    const conversation = await findOwnedConversation(req.user._id, req.params.id).lean();
    if (!conversation) return fail(res, 404, 'This conversation was not found.');
    return res.status(200).json({
      success: true,
      conversation: {
        id: conversation._id,
        title: conversation.title,
        lastMessageAt: conversation.lastMessageAt,
        messages: (conversation.messages || []).map((message) => ({ id: message._id, role: message.role, text: message.text, imageUrl: message.imageUrl || null, imageUrls: message.imageUrls || [], createdAt: message.createdAt }))
      }
    });
  } catch (error) {
    return next(error);
  }
};

// Attachment URLs must point at Vuprise's own storage (local /uploads served by
// this server or the configured Cloudinary account). Arbitrary remote URLs are
// rejected so client input can never turn into an SSRF probe.
const validateAttachmentUrls = (attachments, req) => {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_LIMIT) return null;
  const host = req.get('host');
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  const urls = [];
  for (const raw of attachments) {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
    let parsed = null;
    try { parsed = new URL(raw); } catch { return null; }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const isLocalUpload = parsed.host === host && parsed.pathname.startsWith('/uploads/');
    const isCloudinary = Boolean(cloudName) && parsed.hostname === 'res.cloudinary.com' && parsed.pathname.includes(`/${cloudName}/`);
    if (!isLocalUpload && !isCloudinary) return null;
    urls.push(raw);
  }
  return urls;
};

// Appends the completed exchange to the conversation and answers the client.
// Only completed exchanges are persisted, so a failed generation never leaves
// half-written history behind and Retry always resends the original prompt.
const persistExchange = async (res, conversation, userMessage, assistantMessage, titleSeed, extra = {}) => {
  conversation.messages.push(userMessage, assistantMessage);
  if (conversation.messages.length > HISTORY_MESSAGE_LIMIT) conversation.messages = conversation.messages.slice(-HISTORY_MESSAGE_LIMIT);
  if (conversation.title === 'New chat' && titleSeed) conversation.title = titleSeed.slice(0, 60);
  // Mongoose assigns _id when the plain objects are cast into subdocuments, so
  // the response must be built from the stored documents, not the inputs.
  const savedUserMessage = conversation.messages[conversation.messages.length - 2];
  const savedAssistantMessage = conversation.messages[conversation.messages.length - 1];
  conversation.lastMessageAt = savedAssistantMessage.createdAt;
  await conversation.save();
  return res.status(201).json({
    success: true,
    title: conversation.title,
    userMessage: { id: savedUserMessage._id, role: 'user', text: savedUserMessage.text, imageUrl: null, imageUrls: savedUserMessage.imageUrls || [], createdAt: savedUserMessage.createdAt },
    assistantMessage: { id: savedAssistantMessage._id, role: 'assistant', text: savedAssistantMessage.text, imageUrl: savedAssistantMessage.imageUrl, imageUrls: [], createdAt: savedAssistantMessage.createdAt },
    ...extra
  });
};

// POST /api/ai/conversations/:id/messages
// One input for everything: the intent classifier decides between an ordinary
// text answer and an automatic image generation. Keyword matching is never the
// deciding factor; the classifier output is validated and fails safe to chat.
const sendConversationMessage = async (req, res, next) => {
  // A client that closes the connection (Stop button, navigation) means the
  // work is no longer wanted: the signal aborts upstream provider calls and
  // every abort check below exits before any result is persisted.
  const disconnect = new AbortController();
  const onDisconnect = () => { if (!res.writableEnded) disconnect.abort(); };
  res.on('close', onDisconnect);
  try {
    const { message, attachments } = req.body || {};
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!trimmed) return fail(res, 400, 'Please type a message before sending.');
    if (trimmed.length > MESSAGE_MAX_LENGTH) return fail(res, 400, `Messages are limited to ${MESSAGE_MAX_LENGTH} characters.`);
    const attachmentUrls = validateAttachmentUrls(attachments, req);
    if (attachmentUrls === null) return fail(res, 400, `Attachments must be up to ${ATTACHMENT_LIMIT} images uploaded through Vuprise.`);

    const allowed = await consumeLimitSafe({ key: `ai-chat:${req.user._id}`, windowMs: CHAT_WINDOW_MS, max: CHAT_MAX_MESSAGES });
    if (!allowed) return fail(res, 429, 'You have reached the AI chat limit for now. Please try again in a few minutes.');

    const conversation = await findOwnedConversation(req.user._id, req.params.id).select('+opencodeSessionId');
    if (!conversation) return fail(res, 404, 'This conversation was not found.');

    const userMessage = { role: 'user', text: trimmed, imageUrl: null, imageUrls: attachmentUrls, createdAt: new Date() };
    const intent = await classifyImageIntent(trimmed, disconnect.signal);
    if (disconnect.signal.aborted) return;

    if (intent.intent === 'image' && attachmentUrls.length) {
      const assistantMessage = { role: 'assistant', text: IMAGE_EDIT_LIMITATION_MESSAGE, imageUrl: null, imageUrls: [], createdAt: new Date() };
      return persistExchange(res, conversation, userMessage, assistantMessage, trimmed);
    }

    if (intent.intent === 'image') {
      const imageAllowed = await consumeLimitSafe({ key: `ai-image:${req.user._id}`, windowMs: IMAGE_WINDOW_MS, max: IMAGE_MAX_PER_WINDOW });
      if (!imageAllowed) return fail(res, 429, 'You have reached the image generation limit for now. Please try again in a few minutes.');
      if (!acquireUserLock(req.user._id)) return fail(res, 429, 'Please wait for the current reply before sending another message.');
      let assistantMessage;
      let reservation = null;
      try {
        reservation = await aiImageQuota.reserveImageGeneration(req.user._id);
        if (!reservation.allowed) {
          return fail(res, 429, IMAGE_QUOTA_USER_MESSAGE, 'AI_IMAGE_QUOTA_EXCEEDED', {
            remaining: 0,
            limit: aiImageQuota.AI_IMAGE_DAILY_LIMIT,
            nextAvailableAt: reservation.nextAvailableAt
          });
        }
        const generated = await generateImage(intent.imagePrompt, disconnect.signal);
        const stored = await aiImageStorage.persistGeneratedImage({
          buffer: generated.buffer,
          mime: generated.mime,
          baseUrl: `${req.protocol}://${req.get('host')}`
        });
        assistantMessage = { role: 'assistant', text: '', imageUrl: stored.url, imageUrls: [], createdAt: new Date() };
        aiImageQuota.pruneImageGenerations(req.user._id).catch(() => {});
      } catch (error) {
        // Failed or stopped generations must not consume the member's quota.
        if (reservation?.allowed) await aiImageQuota.releaseImageGeneration(req.user._id, reservation.reservedAt).catch(() => {});
        if (disconnect.signal.aborted) return;
        if (error instanceof AiChatError) console.warn(`[ai-image] generation failed code=${error.code} status=${error.statusCode} detail=${error.message}`);
        else console.error('[ai-image] storing the generated image failed:', error?.message || error);
        return fail(res, 503, IMAGE_UNAVAILABLE_USER_MESSAGE, 'AI_IMAGE_TEMPORARILY_UNAVAILABLE');
      } finally {
        releaseUserLock(req.user._id);
      }
      return persistExchange(res, conversation, userMessage, assistantMessage, trimmed, {
        imageQuota: { remaining: reservation.remaining, limit: aiImageQuota.AI_IMAGE_DAILY_LIMIT }
      });
    }

    let result;
    try {
      result = await chat(req.user._id, conversation.opencodeSessionId, trimmed, { imageUrls: attachmentUrls, signal: disconnect.signal });
    } catch (error) {
      if (attachmentUrls.length && error instanceof AiChatError) {
        console.warn(`[ai-vision] vision request failed code=${error.code} upstream=${error.upstreamStatus}`);
        return fail(res, 502, 'I could not read the attached image. The configured AI model does not support image input yet - try sending the message without the attachment.', 'AI_VISION_UNAVAILABLE');
      }
      throw error;
    }
    if (disconnect.signal.aborted) return;
    conversation.opencodeSessionId = result.sessionId || '';
    const assistantMessage = { role: 'assistant', text: sanitizeAssistantReply(result.reply), imageUrl: null, imageUrls: [], createdAt: new Date() };
    return persistExchange(res, conversation, userMessage, assistantMessage, trimmed);
  } catch (error) {
    // The response socket is already gone on a disconnect; nothing to report.
    if (disconnect.signal.aborted) return;
    return handleAiError(res, next, error);
  } finally {
    res.removeListener('close', onDisconnect);
  }
};

// POST /api/ai/conversations/:id/attachments
const uploadAttachments = async (req, res, next) => {
  try {
    const conversation = await findOwnedConversation(req.user._id, req.params.id);
    if (!conversation) {
      await Promise.all((req.files || []).map((file) => discardUploadedFile(file)));
      return fail(res, 404, 'This conversation was not found.');
    }
    const files = req.files || [];
    if (!files.length) return fail(res, 400, 'Choose at least one JPG, PNG, or WebP image.');
    const attachments = [];
    try {
      for (const file of files) {
        const media = await processUploadedMedia(file, req, 'ai-chat');
        attachments.push({ url: media.url, publicId: media.publicId });
      }
    } catch (error) {
      await Promise.all(files.map((file) => discardUploadedFile(file)));
      throw error;
    }
    return res.status(201).json({ success: true, attachments: attachments.map((item) => ({ url: item.url })) });
  } catch (error) {
    return next(error);
  }
};

// DELETE /api/ai/conversations/:id
const deleteConversation = async (req, res, next) => {
  try {
    const conversation = await findOwnedConversation(req.user._id, req.params.id).select('+opencodeSessionId');
    if (!conversation) return fail(res, 404, 'This conversation was not found.');
    await deleteSession(conversation.opencodeSessionId);
    await AiConversation.deleteOne({ _id: conversation._id, user: req.user._id });
    return res.status(200).json({ success: true });
  } catch (error) {
    return handleAiError(res, next, error);
  }
};

// GET /api/ai/status
const getAiStatus = async (req, res, next) => {
  try {
    const [available, imageQuota] = await Promise.all([
      isAvailable(),
      aiImageQuota.getImageQuotaStatus(req.user._id).catch(() => null)
    ]);
    return res.status(200).json({ success: true, available, imageQuota });
  } catch (error) {
    return next(error);
  }
};

module.exports = { listConversations, createConversation, getConversation, sendConversationMessage, uploadAttachments, deleteConversation, getAiStatus, sanitizeAssistantReply, validateAttachmentUrls, MESSAGE_MAX_LENGTH, ATTACHMENT_LIMIT };
