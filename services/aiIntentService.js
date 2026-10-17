const { oneShot } = require('./aiChatService');

// The classifier is a lightweight structured-JSON call to the same local model.
// It is the only authority on intent: keyword heuristics are never trusted on
// their own, and any classifier failure safely falls back to ordinary chat.
const CLASSIFIER_SYSTEM_PROMPT = [
  'You are an intent classifier for the chat assistant on Vuprise, a professional networking platform.',
  'Decide whether the user message asks for an IMAGE to be created (image, logo, banner, poster, illustration, picture, graphic, artwork) or is an ordinary CHAT request (questions, drafts, advice, anything about an attached photo).',
  'Reply with ONLY one JSON object and nothing else: {"intent":"image"|"chat","imagePrompt":"..."}',
  'Never answer the user, never explain, never add text outside the JSON object - your only job is classification.',
  'Rules:',
  '- intent "image" only when the user wants a new image produced, including short requests like "make a banner" or "create a logo for Vuprise".',
  '- intent "chat" for every other request, including questions about an attached image.',
  '- For "image": imagePrompt is an expanded, vivid English prompt for an image model. Never ask the user questions; fill missing details with Vuprise design guidance: modern professional networking platform, dark theme with white and blue accents, subtle star-burst logo motif, clean modern digital illustration, high detail.',
  '- For "chat": imagePrompt must be an empty string.'
].join('\n');

const CHAT_RESULT = { intent: 'chat', imagePrompt: '' };

const VUPRISE_IMAGE_STYLE = 'Vuprise professional networking platform context, modern dark theme with white and blue accents, subtle star-burst logo motif, clean modern digital illustration, high detail';

const expandVaguePrompt = (base) => {
  const subject = typeof base === 'string' && base.trim() ? base.trim() : 'A modern professional networking scene';
  return `${subject}. Design guidance: ${VUPRISE_IMAGE_STYLE}.`;
};

// Accepts plain JSON, JSON wrapped in code fences, or JSON embedded in prose,
// and fails safe to a chat result whenever the shape is not exactly valid.
const parseClassifierOutput = (raw, fallbackPrompt = '') => {
  if (typeof raw !== 'string' || !raw.trim()) return { ...CHAT_RESULT };
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return { ...CHAT_RESULT };
  let parsed = null;
  try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return { ...CHAT_RESULT }; }
  if (!parsed || parsed.intent !== 'image') return { ...CHAT_RESULT };
  if (typeof parsed.imagePrompt !== 'string') return { ...CHAT_RESULT };
  const prompt = parsed.imagePrompt.trim().slice(0, 1000);
  return { intent: 'image', imagePrompt: prompt || expandVaguePrompt(fallbackPrompt) };
};

const buildClassifierMessage = (text) => `User message: """${String(text).slice(0, 2000)}"""`;

// True only when the reply contains a well-formed classifier JSON object with
// a known intent. Used to distinguish "classifier validly said chat" from
// "classifier failed", which enables a safe secondary check on failure.
const hasValidClassifierShape = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Boolean(parsed) && (parsed.intent === 'image' || parsed.intent === 'chat');
  } catch {
    return false;
  }
};

// Secondary signal used ONLY when the classifier itself failed (network error,
// non-JSON answer). The classifier stays the authority: a valid "chat" verdict
// is never overridden.
const IMAGE_ACTION_PATTERN = /(create|generate|make|draw|design|render|produce|paint|illustrate)/;
const IMAGE_SUBJECT_PATTERN = /(image|picture|photo|logo|banner|poster|illustration|graphic|artwork|icon|wallpaper|scene)/;
const looksLikeImageRequest = (text) => {
  const value = String(text || '').toLowerCase();
  return IMAGE_ACTION_PATTERN.test(value) && IMAGE_SUBJECT_PATTERN.test(value);
};

// Runs the classifier against the model. Any upstream failure (timeout, free
// tier rejection, invalid JSON, empty reply) degrades to chat so ordinary
// messaging is never blocked by the classifier; a clearly image-shaped request
// whose classifier failed is still routed to image generation.
const classifyImageIntent = async (text, signal) => {
  let reply = '';
  try {
    reply = await oneShot(buildClassifierMessage(text), { system: CLASSIFIER_SYSTEM_PROMPT, variant: 'low', signal });
  } catch {
    reply = '';
  }
  const parsed = parseClassifierOutput(reply, text);
  if (parsed.intent === 'image') return parsed;
  if (!hasValidClassifierShape(reply) && looksLikeImageRequest(text)) {
    return { intent: 'image', imagePrompt: expandVaguePrompt(text) };
  }
  return parsed;
};

module.exports = { classifyImageIntent, parseClassifierOutput, expandVaguePrompt, CLASSIFIER_SYSTEM_PROMPT };
