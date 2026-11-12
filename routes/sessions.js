const express = require('express');
const { validateDecision, validateRoomId } = require('../middleware');
const wrapAsync = require('../utils/wrapAsync');
const sessionController = require('../controllers/sessions');

const router = express.Router();

router.route('/')
  .get(wrapAsync(sessionController.index));
router.route('/:roomId/decision')
  .post(validateRoomId, validateDecision, wrapAsync(sessionController.updateDecision));

module.exports = router;
