const test = require('node:test');
const assert = require('node:assert/strict');
const { canManageDetails, canManageRoles, canRemoveMember } = require('../utils/groupPermissions');

test('only owner and admins can manage group details; only owner assigns admins', () => {
  assert.equal(canManageDetails('owner'), true); assert.equal(canManageDetails('admin'), true); assert.equal(canManageDetails('member'), false);
  assert.equal(canManageRoles('owner'), true); assert.equal(canManageRoles('admin'), false); assert.equal(canManageRoles('member'), false);
});

test('members can leave, but cannot remove other members or the owner', () => {
  assert.equal(canRemoveMember('member', 'member', true), true);
  assert.equal(canRemoveMember('member', 'member', false), false);
  assert.equal(canRemoveMember('owner', 'owner', true), false);
});

test('admins cannot remove owners or other admins', () => {
  assert.equal(canRemoveMember('admin', 'member', false), true);
  assert.equal(canRemoveMember('admin', 'admin', false), false);
  assert.equal(canRemoveMember('admin', 'owner', false), false);
});
