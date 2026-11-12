function verifier(_req, res) {
  res.render('verifier', { title: 'Verifier console' });
}

function join(req, res) {
  res.render('join', { title: 'Video identity check', token: req.params.token });
}

function room(req, res) {
  const configuredInterval = Number(process.env.FRAME_INTERVAL_MS || 350);
  const frameIntervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 50 && configuredInterval <= 5000
    ? configuredInterval
    : 350;
  res.render('room', { title: 'Verification call', roomId: req.params.roomId, frameIntervalMs });
}

module.exports = { verifier, join, room };
