const canManageDetails = (role) => role === 'owner' || role === 'admin';
const canManageRoles = (role) => role === 'owner';
const canRemoveMember = (actorRole, targetRole, isSelf = false) => {
  if (targetRole === 'owner') return false;
  if (isSelf) return true;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && targetRole === 'member';
};

module.exports = { canManageDetails, canManageRoles, canRemoveMember };
