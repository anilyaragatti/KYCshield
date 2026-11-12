const Score = require('../models/Score');

async function getSessionAnalytics(roomId) {
  const [timeline, reasonCounts] = await Promise.all([
    Score.aggregate([
      { $match: { roomId } },
      { $sort: { ts: 1 } },
      {
        $bucketAuto: {
          groupBy: '$ts',
          buckets: 200,
          output: {
            ts: { $first: '$ts' },
            risk: { $avg: '$risk' },
            audio: { $avg: '$audio' },
            face: { $avg: '$face' },
            label: { $last: '$label' }
          }
        }
      },
      { $sort: { ts: 1 } },
      { $limit: 200 },
      { $project: { _id: 0, ts: 1, risk: 1, audio: 1, face: 1, label: 1 } }
    ]),
    Score.aggregate([
      { $match: { roomId } },
      { $unwind: '$reasons' },
      { $group: { _id: '$reasons', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 8 },
      { $project: { _id: 0, text: '$_id', count: 1 } }
    ])
  ]);
  return { timeline, reasonCounts };
}

module.exports = { getSessionAnalytics };
