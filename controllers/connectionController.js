const mongoose = require('mongoose');
const Connection = require('../models/Connection');
const User = require('../models/User');
const Notification = require('../models/Notification');

const connectionPairKey = (firstId, secondId) => [String(firstId), String(secondId)].sort().join(':');

// @desc    Send connection request to a user
// @route   POST /api/connections/:userId
// @access  Private
const sendConnectionRequest = async (req, res, next) => {
  try {
    const recipientId = req.params.userId;
    const requesterId = req.user._id;

    if (!mongoose.isValidObjectId(recipientId)) {
      return res.status(400).json({ success: false, message: 'Choose a valid user.' });
    }

    if (recipientId.toString() === requesterId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot send a connection request to yourself.'
      });
    }

    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Check if connection or request already exists in either direction
    const existing = await Connection.findOne({
      $or: [
        { requester: requesterId, recipient: recipientId },
        { requester: recipientId, recipient: requesterId }
      ]
    });

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({
          success: false,
          message: 'You are already connected with this user.'
        });
      }
      if (existing.status === 'pending') {
        return res.status(400).json({
          success: false,
          message: existing.requester.toString() === requesterId.toString()
            ? 'Connection request already sent.'
            : 'This user has already sent you a connection request. Please accept it.'
        });
      }
    }

    let connection;
    if (existing?.status === 'rejected') {
      connection = await Connection.findOneAndUpdate(
        { _id: existing._id, status: 'rejected' },
        { $set: { requester: requesterId, recipient: recipientId, pairKey: connectionPairKey(requesterId, recipientId), status: 'pending' } },
        { new: true, runValidators: true }
      );
      if (!connection) return res.status(409).json({ success: false, message: 'The connection request changed. Refresh and try again.' });
    } else {
      try {
        connection = await Connection.create({ requester: requesterId, recipient: recipientId, status: 'pending' });
      } catch (error) {
        if (error.code === 11000) return res.status(409).json({ success: false, message: 'A connection request already exists.' });
        throw error;
      }
    }

    // Create Notification
    await Notification.findOneAndUpdate(
      { recipient: recipientId, connection: connection._id, type: 'connection_request' },
      { $set: {
        recipient: recipientId,
        sender: requesterId,
        connection: connection._id,
        type: 'connection_request',
        message: `${req.user.name} sent you a connection request.`,
        read: false,
        createdAt: new Date()
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({
      success: true,
      message: 'Connection request sent successfully.',
      connection
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Accept connection request
// @route   PUT /api/connections/:requestId/accept
// @access  Private
const acceptConnectionRequest = async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const currentUserId = req.user._id;

    // Find request where current user is the recipient (or by ID)
    let connection = await Connection.findOneAndUpdate({
      _id: requestId,
      recipient: currentUserId,
      status: 'pending'
    }, { $set: { status: 'accepted' } }, { new: true });

    // Also support finding by requester ID if someone passes sender's user ID
    if (!connection) {
      connection = await Connection.findOneAndUpdate({
        requester: requestId,
        recipient: currentUserId,
        status: 'pending'
      }, { $set: { status: 'accepted' } }, { new: true });
    }

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Pending connection request not found or already accepted.'
      });
    }

    // Update both users' connections array
    await User.findByIdAndUpdate(connection.requester, {
      $addToSet: { connections: connection.recipient, followers: connection.recipient, following: connection.recipient }
    });

    await User.findByIdAndUpdate(connection.recipient, {
      $addToSet: { connections: connection.requester, followers: connection.requester, following: connection.requester }
    });

    await Notification.updateMany({ recipient: currentUserId, connection: connection._id, type: 'connection_request' }, { $set: { read: true } });

    // Notify requester that their connection request was accepted
    await Notification.findOneAndUpdate(
      { recipient: connection.requester, connection: connection._id, type: 'connection_accepted' },
      { $setOnInsert: {
        recipient: connection.requester,
        sender: currentUserId,
        connection: connection._id,
        type: 'connection_accepted',
        message: `${req.user.name} accepted your connection request. You are now connected!`
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({
      success: true,
      message: 'Connection accepted!',
      connection
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Reject or cancel connection request
// @route   DELETE /api/connections/:requestId
// @access  Private
const rejectOrRemoveConnection = async (req, res, next) => {
  try {
    const targetId = req.params.requestId;
    const currentUserId = req.user._id;

    // Search either by connection ID or other user's ID
    const connection = await Connection.findOne({
      $or: [
        { _id: targetId },
        { requester: currentUserId, recipient: targetId },
        { requester: targetId, recipient: currentUserId }
      ]
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Connection record not found.'
      });
    }

    // Authorization check
    if (
      connection.requester.toString() !== currentUserId.toString() &&
      connection.recipient.toString() !== currentUserId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to modify this connection.'
      });
    }

    // Accepted connections are removed; a pending request is retained as rejected so it can be cleanly re-sent.
    if (connection.status === 'accepted') {
      await User.findByIdAndUpdate(connection.requester, {
        $pull: { connections: connection.recipient }
      });
      await User.findByIdAndUpdate(connection.recipient, {
        $pull: { connections: connection.requester }
      });
      await Connection.findByIdAndDelete(connection._id);
    } else if (connection.status === 'pending') {
      const rejected = await Connection.findOneAndUpdate(
        { _id: connection._id, status: 'pending' },
        { $set: { status: 'rejected' } },
        { new: true }
      );
      if (!rejected) return res.status(409).json({ success: false, message: 'This connection request has already been updated.' });
      await Notification.updateMany({ connection: connection._id, recipient: connection.recipient, type: 'connection_request' }, { $set: { read: true } });
    } else {
      return res.status(409).json({ success: false, message: 'This connection request is no longer pending.' });
    }

    res.status(200).json({
      success: true,
      message: 'Connection removed successfully.'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user connections & pending requests
// @route   GET /api/connections
// @access  Private
const getConnections = async (req, res, next) => {
  try {
    const currentUserId = req.user._id;

    // Accepted connections
    const accepted = await Connection.find({
      $or: [{ requester: currentUserId }, { recipient: currentUserId }],
      status: 'accepted'
    })
      .populate('requester', 'name headline profilePicture company jobTitle location')
      .populate('recipient', 'name headline profilePicture company jobTitle location');

    const connectionsList = accepted.map(c => {
      return c.requester._id.toString() === currentUserId.toString()
        ? c.recipient
        : c.requester;
    });

    // Pending incoming requests (sent to current user)
    const pendingIncoming = await Connection.find({
      recipient: currentUserId,
      status: 'pending'
    }).populate('requester', 'name headline profilePicture company jobTitle location');

    // Pending outgoing requests (sent by current user)
    const pendingOutgoing = await Connection.find({
      requester: currentUserId,
      status: 'pending'
    }).populate('recipient', 'name headline profilePicture company jobTitle location');

    res.status(200).json({
      success: true,
      count: connectionsList.length,
      connections: connectionsList,
      pendingIncoming,
      pendingOutgoing
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  sendConnectionRequest,
  acceptConnectionRequest,
  rejectOrRemoveConnection,
  getConnections
};
