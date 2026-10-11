const User = require('../models/User');
const Connection = require('../models/Connection');
const Post = require('../models/Post');
const { processUploadedFile } = require('../middleware/uploadMiddleware');
const { postVisibilityFilter, addPostVisibility } = require('../utils/postVisibility');
const { isVerifiedAccount } = require('../utils/verifiedAccount');

// @desc    Get all users with filtering and pagination
// @route   GET /api/users
// @access  Public / Optional Auth
const getUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 12;
    const skip = (page - 1) * limit;
    const { skill, location, company, search } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { headline: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { skills: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    if (skill) {
      query.skills = { $in: [new RegExp(skill, 'i')] };
    }

    if (location) {
      query.location = { $regex: location, $options: 'i' };
    }

    if (company) {
      query.company = { $regex: company, $options: 'i' };
    }

    // Exclude current user if logged in
    if (req.user) {
      query._id = { $ne: req.user._id };
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // If logged in, populate connection status with each user
    let enhancedUsers = users;
    if (req.user) {
      const userIds = users.map(u => u._id);
      const connections = await Connection.find({
        $or: [
          { requester: req.user._id, recipient: { $in: userIds } },
          { requester: { $in: userIds }, recipient: req.user._id }
        ]
      });

      const connectionMap = {};
      connections.forEach(c => {
        const otherId = c.requester.toString() === req.user._id.toString() 
          ? c.recipient.toString() 
          : c.requester.toString();
        
        if (c.status === 'accepted') {
          connectionMap[otherId] = 'connected';
        } else if (c.status === 'pending') {
          if (c.requester.toString() === req.user._id.toString()) {
            connectionMap[otherId] = 'pending_sent';
          } else {
            connectionMap[otherId] = 'pending_received';
          }
        }
      });

      enhancedUsers = users.map(u => {
        const uObj = u.toObject();
        uObj.connectionStatus = connectionMap[u._id.toString()] || 'none';
        return uObj;
      });
    }

    const responseUsers = enhancedUsers.map((entry) => {
      const user = typeof entry.toObject === 'function' ? entry.toObject() : entry;
      return { ...user, isVerifiedAccount: isVerifiedAccount(user.email) };
    });

    res.status(200).json({
      success: true,
      count: responseUsers.length,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      users: responseUsers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get suggested professionals
// @route   GET /api/users/suggested
// @access  Private
const getSuggestedUsers = async (req, res, next) => {
  try {
    const currentUserId = req.user._id;
    const currentUser = await User.findById(currentUserId);

    // Get all existing connections or pending requests
    const activeConnections = await Connection.find({
      $or: [{ requester: currentUserId }, { recipient: currentUserId }],
      status: { $in: ['accepted', 'pending'] }
    });

    const excludedIds = [currentUserId];
    activeConnections.forEach(c => {
      excludedIds.push(c.requester);
      excludedIds.push(c.recipient);
    });

    // Find other users with shared skills/companies or generally active profiles
    const suggested = await User.find({
      _id: { $nin: excludedIds }
    })
      .select('email name headline profilePicture company jobTitle location skills connections')
      .limit(6);

    const suggestedUsers = suggested.map((entry) => {
      const user = entry.toObject();
      const isVerified = isVerifiedAccount(user.email);
      delete user.email;
      return { ...user, isVerifiedAccount: isVerified };
    });

    res.status(200).json({
      success: true,
      users: suggestedUsers
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Public / Optional Auth
const getUserById = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('connections', 'name headline profilePicture company jobTitle')
      .populate('followers', 'name headline profilePicture')
      .populate('following', 'name headline profilePicture');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User profile not found.'
      });
    }

    const userObj = user.toObject();
    userObj.isVerifiedAccount = isVerifiedAccount(userObj.email);

    // Check connection status if requester is authenticated
    if (req.user) {
      if (req.user._id.toString() === user._id.toString()) {
        userObj.connectionStatus = 'self';
      } else {
        const connection = await Connection.findOne({
          $or: [
            { requester: req.user._id, recipient: user._id },
            { requester: user._id, recipient: req.user._id }
          ]
        });

        if (!connection) {
          userObj.connectionStatus = 'none';
        } else if (connection.status === 'accepted') {
          userObj.connectionStatus = 'connected';
          userObj.connectionId = connection._id;
        } else if (connection.status === 'pending') {
          if (connection.requester.toString() === req.user._id.toString()) {
            userObj.connectionStatus = 'pending_sent';
          } else {
            userObj.connectionStatus = 'pending_received';
          }
          userObj.connectionId = connection._id;
        } else {
          userObj.connectionStatus = 'none';
        }
      }
    } else {
      userObj.connectionStatus = 'none';
    }

    // Get user's recent posts count
    const postCount = await Post.countDocuments({ author: user._id });
    userObj.postCount = postCount;

    res.status(200).json({
      success: true,
      user: userObj
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
const updateProfile = async (req, res, next) => {
  try {
    const {
      name,
      headline,
      bio,
      location,
      locationCountry,
      locationCountryCode,
      locationRegion,
      locationRegionCode,
      website,
      company,
      jobTitle,
      skills,
      education,
      experience
    } = req.body;

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    if (name !== undefined) user.name = name.trim();
    if (headline !== undefined) user.headline = headline;
    if (bio !== undefined) user.bio = bio;
    if (location !== undefined) user.location = location;
    if ([locationCountry, locationCountryCode, locationRegion, locationRegionCode].some((value) => value !== undefined)) {
      const clearingLocation = [locationCountry, locationCountryCode, locationRegion, locationRegionCode]
        .every((value) => value === undefined || value === '');
      if (clearingLocation) {
        user.locationCountry = '';
        user.locationCountryCode = '';
        user.locationRegion = '';
        user.locationRegionCode = '';
      } else {
        if (typeof locationCountry !== 'string' || !locationCountry.trim() || locationCountry.length > 100 ||
            typeof locationCountryCode !== 'string' || !/^[A-Za-z]{2}$/.test(locationCountryCode) ||
            typeof locationRegion !== 'string' || !locationRegion.trim() || locationRegion.length > 120 ||
            (locationRegionCode !== undefined && (typeof locationRegionCode !== 'string' || locationRegionCode.length > 12))) {
          return res.status(400).json({ success: false, message: 'Choose a valid country and state or region.' });
        }
        user.locationCountry = locationCountry.trim();
        user.locationCountryCode = locationCountryCode.toUpperCase();
        user.locationRegion = locationRegion.trim();
        user.locationRegionCode = (locationRegionCode || '').toUpperCase();
        if (location === undefined) user.location = `${user.locationRegion}, ${user.locationCountry}`;
      }
    }
    if (website !== undefined) user.website = website;
    if (company !== undefined) user.company = company;
    if (jobTitle !== undefined) user.jobTitle = jobTitle;
    if (skills !== undefined) {
      // Clean and split if string or array
      if (Array.isArray(skills)) {
        user.skills = skills.map(s => s.trim()).filter(Boolean);
      } else if (typeof skills === 'string') {
        user.skills = skills.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    if (education !== undefined) user.education = education;
    if (experience !== undefined) user.experience = experience;

    await user.save();

    const updatedUser = await User.findById(user._id)
      .select('-password')
      .populate('connections', 'name headline profilePicture');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
      user: updatedUser
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Upload profile picture
// @route   POST /api/users/avatar
// @access  Private
const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please select an image file to upload as profile picture.'
      });
    }

    const imageUrl = await processUploadedFile(req.file, req, 'avatars');

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { profilePicture: imageUrl },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile picture updated successfully.',
      profilePicture: imageUrl,
      user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Upload cover image
// @route   POST /api/users/cover
// @access  Private
const uploadCover = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please select an image file to upload as cover banner.'
      });
    }

    const imageUrl = await processUploadedFile(req.file, req, 'covers');

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { coverImage: imageUrl },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Cover banner updated successfully.',
      coverImage: imageUrl,
      user
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Global search (users, skills, companies)
// @route   GET /api/users/search
// @access  Public / Optional Auth
const searchUsers = async (req, res, next) => {
  try {
    const query = req.query.q || '';
    if (!query.trim()) {
      return res.status(200).json({ success: true, users: [], posts: [] });
    }

    const regex = new RegExp(query.trim(), 'i');

    const users = await User.find({
      $or: [
        { name: regex },
        { headline: regex },
        { company: regex },
        { jobTitle: regex },
        { skills: regex },
        { location: regex }
      ]
    })
      .select('name headline profilePicture company jobTitle location skills')
      .limit(10);

    let postQuery = {
      content: regex
    };
    postQuery = addPostVisibility(postQuery, await postVisibilityFilter(req.user?._id));

    const posts = await Post.find(postQuery)
      .populate('author', 'name headline profilePicture')
      .sort({ createdAt: -1 })
      .limit(6);

    res.status(200).json({
      success: true,
      users,
      posts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user settings
// @route   PUT /api/users/settings
// @access  Private
const updateSettings = async (req, res, next) => {
  try {
    const { themePreference, privateAccount, hideActivity } = req.body;

    const user = await User.findById(req.user._id).select('+hideActivity');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (themePreference) {
      user.themePreference = themePreference;
    }
    if (privateAccount !== undefined) {
      if (typeof privateAccount !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Private Account must be enabled or disabled.' });
      }
      user.privateAccount = privateAccount;
    }
    if (hideActivity !== undefined) {
      if (typeof hideActivity !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Hide Activity must be enabled or disabled.' });
      }
      user.hideActivity = hideActivity;
    }

    await user.save();
    if (hideActivity !== undefined) require('../realtime/presenceHub').setHidden(user._id, hideActivity);

    res.status(200).json({
      success: true,
      message: 'Settings updated.',
      user: {
        _id: user._id,
        themePreference: user.themePreference,
        privateAccount: user.privateAccount,
        hideActivity: user.hideActivity
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  getSuggestedUsers,
  getUserById,
  updateProfile,
  uploadAvatar,
  uploadCover,
  searchUsers,
  updateSettings
};
