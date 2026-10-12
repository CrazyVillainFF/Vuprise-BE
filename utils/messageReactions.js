const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏']);

const normalizeReaction = (emoji) => typeof emoji === 'string' && ALLOWED_REACTIONS.has(emoji) ? emoji : null;

const toggleReaction = (message, userId, emoji) => {
  const reactions = Array.isArray(message.reactions) ? message.reactions : [];
  const existing = reactions.find((entry) => String(entry.user?._id || entry.user) === String(userId));
  message.reactions = reactions.filter((entry) => String(entry.user?._id || entry.user) !== String(userId));
  if (!existing || existing.emoji !== emoji) message.reactions.push({ user: userId, emoji });
  return message.reactions;
};

module.exports = { ALLOWED_REACTIONS, normalizeReaction, toggleReaction };
