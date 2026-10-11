const crypto = require('crypto');

const HEARTBEAT_TTL_MS = 75_000;
const TYPING_TTL_MS = 5_000;
const sessions = new Map();
const sessionsByUser = new Map();
const watchersByUser = new Map();
const typingStates = new Map();
const privacyByUser = new Map();

const userKey = (id) => String(id);
const send = (session, event, payload) => {
  if (session.closed || session.response.destroyed || session.response.writableEnded) return false;
  try {
    session.response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch { return false; }
};

function publishPresence(id, hidden) {
  const key = userKey(id);
  const isHidden = hidden === undefined ? Boolean(privacyByUser.get(key)) : Boolean(hidden);
  const watchers = watchersByUser.get(key);
  if (!watchers) return;
  const online = (sessionsByUser.get(key)?.size || 0) > 0;
  for (const sessionId of [...watchers]) {
    const session = sessions.get(sessionId);
    if (session) send(session, 'presence', { userId: key, state: isHidden ? 'hidden' : online ? 'online' : 'offline' });
  }
}

function createSession(user, response) {
  const id = crypto.randomUUID();
  const key = userKey(user._id);
  const wasOnline = (sessionsByUser.get(key)?.size || 0) > 0;
  privacyByUser.set(key, Boolean(user.hideActivity));
  const session = { id, userId: key, name: String(user.name || 'Vuprise member').slice(0, 80), hidden: Boolean(user.hideActivity), lastHeartbeatAt: Date.now(), response, watches: new Set(), closed: false };
  sessions.set(id, session);
  if (!sessionsByUser.has(key)) sessionsByUser.set(key, new Set());
  sessionsByUser.get(key).add(id);
  if (!wasOnline || session.hidden) publishPresence(key, session.hidden);
  send(session, 'ready', { sessionId: id, heartbeatMs: 25_000 });
  return session;
}

function removeSession(sessionOrId) {
  const session = typeof sessionOrId === 'string' ? sessions.get(sessionOrId) : sessionOrId;
  if (!session || session.closed) return false;
  session.closed = true;
  sessions.delete(session.id);
  for (const watchedId of session.watches) {
    const watchers = watchersByUser.get(watchedId);
    watchers?.delete(session.id);
    if (watchers?.size === 0) {
      watchersByUser.delete(watchedId);
      if (!sessionsByUser.has(watchedId)) privacyByUser.delete(watchedId);
    }
  }
  const userSessions = sessionsByUser.get(session.userId);
  userSessions?.delete(session.id);
  if (userSessions?.size === 0) {
    sessionsByUser.delete(session.userId);
    publishPresence(session.userId);
    if (!watchersByUser.has(session.userId)) privacyByUser.delete(session.userId);
  }
  try { session.response.end(); } catch { /* The peer may already have disconnected. */ }
  return true;
}

function heartbeat(userId, sessionId) {
  const session = sessions.get(String(sessionId));
  if (!session || session.userId !== userKey(userId) || session.closed) return false;
  session.lastHeartbeatAt = Date.now();
  return true;
}

function replaceWatches(userId, sessionId, targetIds) {
  const session = sessions.get(String(sessionId));
  if (!session || session.userId !== userKey(userId) || session.closed) return false;
  for (const targetId of session.watches) {
    const watchers = watchersByUser.get(targetId);
    watchers?.delete(session.id);
    if (watchers?.size === 0) {
      watchersByUser.delete(targetId);
      if (!sessionsByUser.has(targetId)) privacyByUser.delete(targetId);
    }
  }
  session.watches = new Set(targetIds.map(userKey).filter((id) => id !== session.userId));
  for (const targetId of session.watches) {
    if (!watchersByUser.has(targetId)) watchersByUser.set(targetId, new Set());
    watchersByUser.get(targetId).add(session.id);
    const targetSessions = sessionsByUser.get(targetId);
    const hidden = Boolean(privacyByUser.get(targetId));
    send(session, 'presence', { userId: targetId, state: hidden ? 'hidden' : targetSessions?.size ? 'online' : 'offline' });
  }
  return true;
}

function setHidden(userId, hidden) {
  const key = userKey(userId);
  privacyByUser.set(key, Boolean(hidden));
  for (const sessionId of sessionsByUser.get(key) || []) {
    const session = sessions.get(sessionId);
    if (session) session.hidden = Boolean(hidden);
  }
  publishPresence(key, Boolean(hidden));
}

function sendTyping(recipients, payload) {
  for (const recipientId of recipients) {
    for (const sessionId of sessionsByUser.get(userKey(recipientId)) || []) {
      const session = sessions.get(sessionId);
      if (session) send(session, 'typing', payload);
    }
  }
}

function setTyping({ scopeId, scopeType, senderId, senderName, recipients, active }) {
  const key = `${scopeType}:${scopeId}:${userKey(senderId)}`;
  const previous = typingStates.get(key);
  if (previous) clearTimeout(previous.timer);
  if (!active) {
    if (previous) {
      typingStates.delete(key);
      sendTyping(recipients, { scopeId: String(scopeId), scopeType, userId: userKey(senderId), active: false });
    }
    return;
  }
  const timer = setTimeout(() => {
    typingStates.delete(key);
    sendTyping(recipients, { scopeId: String(scopeId), scopeType, userId: userKey(senderId), active: false });
  }, TYPING_TTL_MS);
  timer.unref?.();
  typingStates.set(key, { timer });
  if (!previous) sendTyping(recipients, { scopeId: String(scopeId), scopeType, userId: userKey(senderId), name: String(senderName || 'A member').slice(0, 80), active: true });
}

function getSessionCount(userId) { return sessionsByUser.get(userKey(userId))?.size || 0; }
function getSession(sessionId) { return sessions.get(String(sessionId)); }

function expireStaleSessions(now = Date.now()) {
  const cutoff = now - HEARTBEAT_TTL_MS;
  for (const session of sessions.values()) if (session.lastHeartbeatAt < cutoff) removeSession(session);
}
const expirationTimer = setInterval(expireStaleSessions, 15_000);
expirationTimer.unref?.();

module.exports = { HEARTBEAT_TTL_MS, TYPING_TTL_MS, createSession, removeSession, heartbeat, replaceWatches, setHidden, setTyping, getSessionCount, getSession, expireStaleSessions };
