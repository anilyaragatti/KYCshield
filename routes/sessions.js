const express = require('express');
const { basicAuth, validateDecision, validateFeedback, validateRoomId } = require('../middleware');
const wrapAsync = require('../utils/wrapAsync');
const sessionController = require('../controllers/sessions');

const router = express.Router();

router.route('/')
  .get(basicAuth, wrapAsync(sessionController.index));
router.route('/:roomId/decision')
  .post(basicAuth, validateRoomId, validateDecision, wrapAsync(sessionController.updateDecision));
router.route('/:roomId/feedback')
  .post(basicAuth, validateRoomId, validateFeedback, wrapAsync(sessionController.saveFeedback));
router.route('/:roomId/report.pdf')
  .get(basicAuth, validateRoomId, wrapAsync(sessionController.reportPdf));

module.exports = router;
