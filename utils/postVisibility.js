const Connection = require('../models/Connection');
const User = require('../models/User');

const isAcceptedConnection = async (viewerId, authorId) => {
  if (!viewerId || !authorId) return false;
  if (viewerId.toString() === authorId.toString()) return true;
  return Boolean(await Connection.exists({
    status: 'accepted',
    $or: [
      { requester: viewerId, recipient: authorId },
      { requester: authorId, recipient: viewerId }
    ]
  }));
};

const isBlockedBy = async (viewerId, authorId) => {
  if (!viewerId || !authorId || viewerId.toString() === authorId.toString()) return false;
  return Boolean(await User.exists({ _id: viewerId, blockedUsers: authorId }));
};

const canViewUserPosts = async (viewerId, author) => {
  if (await isBlockedBy(viewerId, author?._id)) return false;
  if (!author?.privateAccount) return true;
  return isAcceptedConnection(viewerId, author._id);
};

const postVisibilityFilter = async (viewerId) => {
  const privateUsers = await User.find({ privateAccount: true }).select('_id').lean();
  let blockedIds = [];
  if (viewerId) {
    const viewer = await User.findById(viewerId).select('+blockedUsers').lean();
    blockedIds = viewer?.blockedUsers || [];
  }
  if (!privateUsers.length && !blockedIds.length) return null;

  const allowedIds = new Set(viewerId ? [viewerId.toString()] : []);
  if (viewerId && privateUsers.length) {
    const accepted = await Connection.find({
      status: 'accepted',
      $or: [{ requester: viewerId }, { recipient: viewerId }]
    }).select('requester recipient').lean();

    accepted.forEach((connection) => {
      const other = connection.requester.toString() === viewerId.toString()
        ? connection.recipient
        : connection.requester;
      allowedIds.add(other.toString());
    });
  }

  const privateIds = privateUsers.map(({ _id }) => _id);
  const visiblePrivateIds = privateUsers
    .filter(({ _id }) => allowedIds.has(_id.toString()))
    .map(({ _id }) => _id);

  const clauses = [];
  if (privateUsers.length) {
    clauses.push({
      $or: [
        { author: { $nin: privateIds } },
        { author: { $in: visiblePrivateIds } }
      ]
    });
  }
  if (blockedIds.length) clauses.push({ author: { $nin: blockedIds } });
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

const addPostVisibility = (query, visibilityFilter) => {
  if (!visibilityFilter) return query;
  if (Object.keys(query).length === 0) return visibilityFilter;
  return { $and: [query, visibilityFilter] };
};

module.exports = { isAcceptedConnection, isBlockedBy, canViewUserPosts, postVisibilityFilter, addPostVisibility };
