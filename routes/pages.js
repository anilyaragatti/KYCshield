const express = require('express');
const { basicAuth, validateRoomId } = require('../middleware');
const pageController = require('../controllers/pages');

const router = express.Router();

router.route('/')
  .get(basicAuth, pageController.verifier);
router.route('/join/:token')
  .get(pageController.join);
router.route('/room/:roomId')
  .get(basicAuth, validateRoomId, pageController.room);

module.exports = router;
