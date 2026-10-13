const express = require('express');
const { optionalAuth } = require('../middleware/authMiddleware');
const { supportUpload, validateImageContent } = require('../middleware/uploadMiddleware');
const { createRequest } = require('../controllers/supportController');
const router = express.Router();

router.post('/requests', optionalAuth, supportUpload.array('evidence', 5), validateImageContent, createRequest);

module.exports = router;
