const express = require('express');
const { optionalAuth } = require('../middleware/authMiddleware');
const { createRequest } = require('../controllers/supportController');
const router = express.Router();

router.post('/requests', optionalAuth, createRequest);

module.exports = router;
