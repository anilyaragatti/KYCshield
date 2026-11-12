const Session = require('../models/Session');
const ExpressError = require('../utils/ExpressError');

async function index(req, res) {
  const sessions = await Session.find()
    .sort({ createdAt: -1 })
    .limit(5)
    .select('roomId decision createdAt -_id')
    .lean();

  res.json(sessions.map(({ roomId, decision, createdAt }) => ({
    roomId: roomId.slice(0, 6),
    decision,
    createdAt
  })));
}

async function updateDecision(req, res) {
  const updatedSession = await Session.findOneAndUpdate(
    { roomId: req.validatedParams.roomId },
    { $set: { decision: req.validatedBody.decision } },
    { new: true, runValidators: true }
  ).select('decision');

  if (!updatedSession) throw new ExpressError(404, 'Session not found.');
  res.json({ decision: updatedSession.decision });
}

module.exports = { index, updateDecision };
