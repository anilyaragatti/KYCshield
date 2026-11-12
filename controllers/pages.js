const { signVerifierToken } = require('../utils/verifierToken');

function verifier(_req, res) {
  res.render('verifier', { title: 'Verifier console' });
}

function join(req, res) {
  res.render('join', { title: 'Video identity check', token: req.params.token });
}

function room(req, res) {
  res.set('Cache-Control', 'no-store');
  const configuredInterval = Number(process.env.FRAME_INTERVAL_MS || 350);
  const frameIntervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 50 && configuredInterval <= 5000
    ? configuredInterval
    : 350;
  const roomId = req.validatedParams.roomId;
  res.render('room', {
    title: 'Verification call', roomId, frameIntervalMs,
    verifierToken: signVerifierToken(roomId)
  });
}

module.exports = { verifier, join, room };
