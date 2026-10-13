const ALLOWED_POST_REACTIONS = new Set(['👍', '❤️', '🎉', '🤝', '💡', '😂']);

const normalizePostReaction = (emoji) => (
  typeof emoji === 'string' && ALLOWED_POST_REACTIONS.has(emoji) ? emoji : null
);

const togglePostReaction = (reactions, userId, emoji) => {
  const current = Array.isArray(reactions) ? reactions : [];
  const user = String(userId);
  const existing = current.find((reaction) => String(reaction.user?._id || reaction.user) === user);
  const withoutUser = current.filter((reaction) => String(reaction.user?._id || reaction.user) !== user);
  if (existing?.emoji === emoji) return withoutUser;
  return [...withoutUser, { user: userId, emoji }];
};

module.exports = { ALLOWED_POST_REACTIONS, normalizePostReaction, togglePostReaction };
