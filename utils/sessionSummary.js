const Session = require('../models/Session');
const Score = require('../models/Score');

async function recomputeSessionSummary(roomId) {
  const session = await Session.findOne({ roomId })
    .select('startedAt endedAt createdAt')
    .lean();
  if (!session) return null;

  const [scoreStats] = await Score.aggregate([
    { $match: { roomId } },
    { $sort: { ts: 1, createdAt: 1 } },
    {
      $group: {
        _id: null,
        peakRisk: { $max: '$risk' },
        avgRisk: { $avg: '$risk' },
        finalLabel: { $last: '$label' },
        scoreCount: { $sum: 1 },
        mockUsed: { $max: { $cond: [{ $eq: ['$backend', 'mock'] }, 1, 0] } }
      }
    }
  ]);

  const startedAt = session.startedAt || session.createdAt;
  const endedAt = session.endedAt || new Date();
  const durationSec = startedAt
    ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000))
    : 0;
  const summary = {
    peakRisk: scoreStats?.peakRisk ?? null,
    avgRisk: scoreStats?.avgRisk ?? null,
    finalLabel: scoreStats?.finalLabel || 'Waiting for data',
    scoreCount: scoreStats?.scoreCount || 0,
    mockUsed: Boolean(scoreStats?.mockUsed),
    durationSec
  };

  await Session.updateOne({ roomId }, { $set: { summary } });
  return summary;
}

async function backfillMissingSummaries() {
  let lastId = null;
  while (true) {
    const filter = { 'summary.scoreCount': { $exists: false } };
    if (lastId) filter._id = { $gt: lastId };
    const batch = await Session.find(filter).sort({ _id: 1 }).limit(100).select('_id roomId').lean();
    if (!batch.length) break;
    await Promise.all(batch.map((session) => recomputeSessionSummary(session.roomId)));
    lastId = batch[batch.length - 1]._id;
  }
}

module.exports = { recomputeSessionSummary, backfillMissingSummaries };
