const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { validateInvite } = require('../middleware');
const ExpressError = require('../utils/ExpressError');
const wrapAsync = require('../utils/wrapAsync');
const inviteController = require('../controllers/invites');

const router = express.Router();
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new ExpressError(429, 'Too many invite requests. Please try again later.'))
});

router.route('/')
  .post(inviteLimiter, validateInvite, wrapAsync(inviteController.create));
router.route('/:token/validate')
  .get(wrapAsync(inviteController.validateToken));

module.exports = router;
