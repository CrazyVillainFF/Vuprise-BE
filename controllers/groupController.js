const mongoose = require('mongoose');
const fs = require('fs/promises');
const Group = require('../models/Group');
const GroupMessage = require('../models/GroupMessage');
const Connection = require('../models/Connection');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { processUploadedMedia, deleteUploadedMedia } = require('../middleware/uploadMiddleware');
const { canManageDetails, canManageRoles, canRemoveMember } = require('../utils/groupPermissions');

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const connected = async (a, b) => Boolean(await Connection.exists({ status: 'accepted', $or: [{ requester: a, recipient: b }, { requester: b, recipient: a }] }));
const getAuthorizedGroup = async (id, userId) => {
  if (!mongoose.isValidObjectId(id)) return { error: [404, 'Group not found.'] };
  const group = await Group.findById(id).populate('members.user', 'name headline profilePicture company jobTitle').populate('invitations.user', 'name headline profilePicture');
  if (!group) return { error: [404, 'Group not found.'] };
  const member = group.memberFor(userId);
  if (!member) return { error: [403, 'You must be a group member to do that.'] };
  return { group, member };
};

exports.listGroups = async (req, res, next) => {
  try {
    const [groups, invitations] = await Promise.all([
      Group.find({ 'members.user': req.user._id }).populate('members.user', 'name headline profilePicture').populate({ path: 'lastMessage', select: 'text createdAt sender', populate: { path: 'sender', select: 'name profilePicture' } }).sort({ lastMessageAt: -1, updatedAt: -1 }),
      Group.find({ invitations: { $elemMatch: { user: req.user._id, status: 'pending' } } }).select('name photo owner invitations')
    ]);
    const pending = invitations.map((group) => ({ ...group.toObject(), invitations: group.invitations.filter((i) => String(i.user?._id || i.user) === req.user._id.toString() && i.status === 'pending') }));
    res.json({ success: true, groups, invitations: pending });
  } catch (error) { next(error); }
};

exports.createGroup = async (req, res, next) => {
  let photo;
  let createdGroup;
  try {
    const name = String(req.body.name || '').trim();
    const about = String(req.body.about || '').trim();
    if (name.length < 2 || name.length > 80 || about.length > 1000) return fail(res, 400, 'Group name must be 2–80 characters and About must be at most 1000 characters.');
    const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds.map((id) => String(id)) : [];
    if (memberIds.length < 2) return fail(res, 400, 'Choose at least two connected people to invite.');
    if (new Set(memberIds).size !== memberIds.length || memberIds.some((id) => !mongoose.isValidObjectId(id) || id === req.user._id.toString())) {
      return fail(res, 400, 'Choose two different connected people.');
    }
    const inviteeUsers = await User.find({ _id: { $in: memberIds } }).select('_id');
    if (inviteeUsers.length !== memberIds.length) return fail(res, 400, 'One or more selected people are no longer available.');
    const connectionStates = await Promise.all(memberIds.map((id) => connected(req.user._id, id)));
    if (connectionStates.some((isConnected) => !isConnected)) return fail(res, 403, 'Groups can only invite your accepted connections.');
    if (req.file) photo = await processUploadedMedia(req.file, req, 'groups');
    createdGroup = await Group.create({
      name,
      about,
      photo: photo?.url || '',
      photoPublicId: photo?.publicId || '',
      owner: req.user._id,
      members: [{ user: req.user._id, role: 'owner' }],
      invitations: memberIds.map((user) => ({ user, invitedBy: req.user._id, status: 'pending' })),
    });
    await Notification.insertMany(memberIds.map((recipient) => ({
      recipient,
      sender: req.user._id,
      type: 'group_invitation',
      group: createdGroup._id,
      message: `${req.user.name || 'A Vuprise connection'} invited you to join ${name}.`,
    })));
    res.status(201).json({ success: true, group: createdGroup });
  } catch (error) {
    if (createdGroup) {
      await Notification.deleteMany({ group: createdGroup._id, type: 'group_invitation' }).catch(() => {});
      await Group.deleteOne({ _id: createdGroup._id }).catch(() => {});
    }
    if (photo) await deleteUploadedMedia({ publicId: photo.publicId, url: photo.url }).catch(() => {});
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    next(error);
  }
};

exports.getGroup = async (req, res, next) => {
  try { const result = await getAuthorizedGroup(req.params.id, req.user._id); if (result.error) return fail(res, ...result.error); res.json({ success: true, group: result.group }); }
  catch (error) { next(error); }
};

exports.updateGroup = async (req, res, next) => {
  let photo;
  try {
    const result = await getAuthorizedGroup(req.params.id, req.user._id);
    if (result.error) return fail(res, ...result.error);
    const { group, member } = result;
    if (!canManageDetails(member.role)) return fail(res, 403, 'Only a group owner or administrator can edit group details.');
    const name = req.body.name === undefined ? group.name : String(req.body.name).trim();
    const about = req.body.about === undefined ? group.about : String(req.body.about).trim();
    if (name.length < 2 || name.length > 80 || about.length > 1000) return fail(res, 400, 'Group name must be 2–80 characters and About must be at most 1000 characters.');
    group.name = name; group.about = about;
    if (req.file) {
      photo = await processUploadedMedia(req.file, req, 'groups');
      const old = { publicId: group.photoPublicId, url: group.photo };
      group.photo = photo.url; group.photoPublicId = photo.publicId;
      await group.save();
      await deleteUploadedMedia(old).catch(() => {});
    } else await group.save();
    res.json({ success: true, group });
  } catch (error) { if (photo) await deleteUploadedMedia({ publicId: photo.publicId, url: photo.url }).catch(() => {}); if (req.file?.path) await fs.unlink(req.file.path).catch(() => {}); next(error); }
};

exports.inviteMember = async (req, res, next) => {
  try {
    const result = await getAuthorizedGroup(req.params.id, req.user._id);
    if (result.error) return fail(res, ...result.error);
    const { group, member } = result;
    if (!canManageDetails(member.role)) return fail(res, 403, 'Only an owner or administrator can invite people.');
    const targetId = req.params.userId;
    if (!mongoose.isValidObjectId(targetId) || targetId === req.user._id.toString()) return fail(res, 400, 'Choose a valid connected person.');
    if (!(await User.exists({ _id: targetId }))) return fail(res, 404, 'User not found.');
    if (!(await connected(req.user._id, targetId))) return fail(res, 403, 'You can invite accepted connections only.');
    if (group.members.some((m) => m.user.toString() === targetId)) return fail(res, 409, 'This person is already a member.');
    const existing = group.invitations.find((i) => i.user.toString() === targetId && i.status === 'pending');
    if (existing) return fail(res, 409, 'An invitation is already pending.');
    group.invitations.push({ user: targetId, invitedBy: req.user._id, status: 'pending' }); await group.save();
    await Notification.create({
      recipient: targetId,
      sender: req.user._id,
      type: 'group_invitation',
      group: group._id,
      message: `${req.user.name || 'A Vuprise connection'} invited you to join ${group.name}.`,
    });
    res.status(201).json({ success: true, group });
  } catch (error) { next(error); }
};

exports.respondInvitation = async (req, res, next) => {
  try {
    if (!['accept', 'decline'].includes(req.params.action)) return fail(res, 400, 'Invalid invitation action.');
    const group = await Group.findOne({ _id: req.params.id, invitations: { $elemMatch: { user: req.user._id, status: 'pending' } } });
    if (!group) return fail(res, 404, 'Pending invitation not found.');
    const invitation = group.invitations.find((i) => i.user.toString() === req.user._id.toString() && i.status === 'pending');
    if (req.params.action === 'accept' && !(await connected(invitation.invitedBy, req.user._id))) {
      invitation.status = 'cancelled'; await group.save();
      return fail(res, 403, 'You must still be connected to the group owner to accept this invitation.');
    }
    invitation.status = req.params.action === 'accept' ? 'accepted' : 'declined';
    if (req.params.action === 'accept' && !group.members.some((m) => m.user.toString() === req.user._id.toString())) group.members.push({ user: req.user._id, role: 'member' });
    await group.save();
    await Notification.updateMany({ recipient: req.user._id, group: group._id, type: 'group_invitation', read: false }, { $set: { read: true } });
    res.json({ success: true, group });
  } catch (error) { next(error); }
};

exports.setMemberRole = async (req, res, next) => {
  try {
    const result = await getAuthorizedGroup(req.params.id, req.user._id);
    if (result.error) return fail(res, ...result.error);
    if (!canManageRoles(result.member.role)) return fail(res, 403, 'Only the group owner can assign or remove administrators.');
    if (!['admin', 'member'].includes(req.body.role) || req.params.userId === result.group.owner.toString()) return fail(res, 400, 'The owner role cannot be changed here.');
    const target = result.group.memberFor(req.params.userId);
    if (!target) return fail(res, 404, 'Group member not found.');
    target.role = req.body.role; await result.group.save(); res.json({ success: true, group: result.group });
  } catch (error) { next(error); }
};

exports.removeMember = async (req, res, next) => {
  try {
    const result = await getAuthorizedGroup(req.params.id, req.user._id);
    if (result.error) return fail(res, ...result.error);
    const { group, member } = result; const target = group.memberFor(req.params.userId);
    if (!target) return fail(res, 404, 'Group member not found.');
    if (!canRemoveMember(member.role, target.role, req.params.userId === req.user._id.toString())) return fail(res, 403, 'You do not have permission to remove this member.');
    group.members = group.members.filter((m) => m.user.toString() !== req.params.userId);
    await group.save(); res.json({ success: true, group });
  } catch (error) { next(error); }
};

exports.deleteGroup = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, 'Group not found.');
    const group = await Group.findOne({ _id: req.params.id, owner: req.user._id });
    if (!group) return fail(res, 404, 'Group not found or only its owner can delete it.');
    await Promise.all([
      GroupMessage.deleteMany({ group: group._id }),
      group.photoPublicId ? deleteUploadedMedia({ publicId: group.photoPublicId, url: group.photo }).catch(() => {}) : Promise.resolve()
    ]);
    await group.deleteOne();
    res.json({ success: true, deletedGroupId: group._id });
  } catch (error) { next(error); }
};
