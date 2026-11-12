const express = require('express');
const pageController = require('../controllers/pages');

const router = express.Router();

router.route('/')
  .get(pageController.verifier);
router.route('/join/:token')
  .get(pageController.join);
router.route('/room/:roomId')
  .get(pageController.room);

module.exports = router;
