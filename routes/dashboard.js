const express = require('express');
const { basicAuth, validateRoomId } = require('../middleware');
const wrapAsync = require('../utils/wrapAsync');
const dashboardController = require('../controllers/dashboard');

const router = express.Router();

router.route('/dashboard')
  .get(basicAuth, wrapAsync(dashboardController.dashboardPage));
router.route('/dashboard/sessions/:roomId')
  .get(basicAuth, validateRoomId, wrapAsync(dashboardController.sessionPage));
router.route('/api/dashboard/stats')
  .get(basicAuth, wrapAsync(dashboardController.stats));
router.route('/api/dashboard/sessions')
  .get(basicAuth, wrapAsync(dashboardController.sessions));
router.route('/api/dashboard/sessions/:roomId')
  .get(basicAuth, validateRoomId, wrapAsync(dashboardController.sessionDetail));
router.route('/api/dashboard/feedback.csv')
  .get(basicAuth, wrapAsync(dashboardController.feedbackCsv));

module.exports = router;
