const Session = require('../models/Session');
const Feedback = require('../models/Feedback');
const ExpressError = require('../utils/ExpressError');
const { backfillMissingSummaries, recomputeSessionSummary } = require('../utils/sessionSummary');
const { getSessionAnalytics } = require('../utils/sessionAnalytics');

function dashboardPage(_req, res) {
  res.render('dashboard', { title: 'Analyst dashboard' });
}

async function sessionPage(req, res) {
  const session = await Session.findOne({ roomId: req.validatedParams.roomId }).select('roomId').lean();
  if (!session) throw new ExpressError(404, 'Session not found.');
  res.render('session', { title: 'Session review', roomId: session.roomId });
}

async function stats(_req, res) {
  await backfillMissingSummaries();
  const [result] = await Session.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        highRisk: { $sum: { $cond: [{ $eq: ['$summary.finalLabel', 'High'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$decision', 'rejected'] }, 1, 0] } },
        avgPeakRisk: { $avg: '$summary.peakRisk' },
        approvedCount: { $sum: { $cond: [{ $eq: ['$decision', 'approved'] }, 1, 0] } },
        rejectedCount: { $sum: { $cond: [{ $eq: ['$decision', 'rejected'] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $eq: ['$decision', 'pending'] }, 1, 0] } }
      }
    }
  ]);
  res.json({
    total: result?.total || 0,
    highRisk: result?.highRisk || 0,
    rejected: result?.rejected || 0,
    avgPeakRisk: result?.avgPeakRisk ?? null,
    byDecision: {
      approved: result?.approvedCount || 0,
      rejected: result?.rejectedCount || 0,
      pending: result?.pendingCount || 0
    }
  });
}

function parseListQuery(query) {
  const allowed = new Set(['page', 'limit', 'label', 'decision']);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new ExpressError(400, 'Unsupported filter parameter.');
  const parsePositiveInt = (key, fallback, max) => {
    const raw = query[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new ExpressError(400, `Invalid ${key}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ExpressError(400, `Invalid ${key}.`);
    return value;
  };
  const page = parsePositiveInt('page', 1, 1_000_000);
  const limit = parsePositiveInt('limit', 10, 20);
  const label = query.label === undefined ? 'all' : query.label;
  const decision = query.decision === undefined ? 'all' : query.decision;
  if (typeof label !== 'string' || !['all', 'low', 'medium', 'high'].includes(label.toLowerCase())) {
    throw new ExpressError(400, 'Invalid label filter.');
  }
  if (typeof decision !== 'string' || !['all', 'approved', 'rejected', 'pending'].includes(decision.toLowerCase())) {
    throw new ExpressError(400, 'Invalid decision filter.');
  }
  return { page, limit, label: label.toLowerCase(), decision: decision.toLowerCase() };
}

async function sessions(req, res) {
  const filters = parseListQuery(req.query);
  await backfillMissingSummaries();
  const match = {};
  if (filters.label !== 'all') match['summary.finalLabel'] = filters.label[0].toUpperCase() + filters.label.slice(1);
  if (filters.decision !== 'all') match.decision = filters.decision;

  const makePipeline = () => [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        metadata: [{ $count: 'total' }],
        rows: [
          { $skip: (filters.page - 1) * filters.limit },
          { $limit: filters.limit },
          {
            $lookup: {
              from: Feedback.collection.name,
              localField: 'roomId',
              foreignField: 'roomId',
              as: 'feedbackDocs'
            }
          },
          {
            $addFields: {
              feedbackVerdict: { $ifNull: [{ $arrayElemAt: ['$feedbackDocs.verdict', 0] }, null] },
              lastChallenge: { $arrayElemAt: ['$challenges', -1] },
              storedScoreCount: { $ifNull: ['$summary.scoreCount', -1] }
            }
          },
          {
            $project: {
              _id: 0,
              roomId: 1,
              startedAt: 1,
              durationSec: { $ifNull: ['$summary.durationSec', 0] },
              peakRisk: '$summary.peakRisk',
              finalLabel: { $ifNull: ['$summary.finalLabel', 'Waiting for data'] },
              virtualCamera: { $ifNull: ['$virtualCamera.flagged', false] },
              lastLiveness: { $ifNull: ['$lastChallenge.result', 'none'] },
              decision: 1,
              feedbackVerdict: 1,
              mockUsed: { $ifNull: ['$summary.mockUsed', false] },
              storedScoreCount: 1
            }
          }
        ]
      }
    }
  ];

  let [result] = await Session.aggregate(makePipeline());
  const missingSummaries = (result?.rows || []).filter((session) => session.storedScoreCount < 0);
  if (missingSummaries.length) {
    await Promise.all(missingSummaries.map((session) => recomputeSessionSummary(session.roomId)));
    [result] = await Session.aggregate(makePipeline());
  }
  const total = result?.metadata?.[0]?.total || 0;
  const rows = (result?.rows || []).map(({ storedScoreCount, ...session }) => session);
  res.json({ sessions: rows, page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) });
}

async function sessionDetail(req, res) {
  const { roomId } = req.validatedParams;
  const summary = await recomputeSessionSummary(roomId);
  const session = await Session.findOne({ roomId })
    .select('roomId startedAt endedAt decision virtualCamera challenges summary createdAt')
    .lean();
  if (!session) throw new ExpressError(404, 'Session not found.');
  const [analytics, feedback] = await Promise.all([
    getSessionAnalytics(roomId),
    Feedback.findOne({ roomId }).select('verdict note riskAtDecision label createdAt updatedAt').lean()
  ]);
  res.json({
    session: {
      roomId: session.roomId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      decision: session.decision,
      virtualCamera: session.virtualCamera,
      createdAt: session.createdAt
    },
    summary: summary || session.summary,
    timeline: analytics.timeline,
    reasonCounts: analytics.reasonCounts,
    challenges: (session.challenges || []).slice(-100).map(({ type, result, at }) => ({ type, result, at })),
    feedback
  });
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => { clean(); resolve(); };
    const onClose = () => { clean(); resolve(); };
    const onError = (error) => { clean(); reject(error); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

async function feedbackCsv(_req, res) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="kycshield-feedback.csv"',
    'Cache-Control': 'no-store'
  });
  res.write('roomId,finalLabel,peakRisk,decision,verdict,createdAt\r\n');
  try {
    const cursor = Feedback.aggregate([
      {
        $lookup: {
          from: Session.collection.name,
          localField: 'roomId',
          foreignField: 'roomId',
          as: 'session'
        }
      },
      { $unwind: '$session' },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $project: {
          _id: 0,
          roomId: 1,
          finalLabel: { $ifNull: ['$session.summary.finalLabel', 'Waiting for data'] },
          peakRisk: '$session.summary.peakRisk',
          decision: '$session.decision',
          verdict: 1,
          createdAt: 1
        }
      }
    ]).cursor({ batchSize: 500 });

    for await (const row of cursor) {
      if (res.destroyed) break;
      const values = [row.roomId, row.finalLabel, row.peakRisk, row.decision, row.verdict, row.createdAt?.toISOString?.() || ''];
      if (!res.write(`${values.map(csvCell).join(',')}\r\n`)) await waitForDrain(res);
    }
    if (!res.destroyed) res.end();
  } catch (_error) {
    if (!res.destroyed) res.destroy();
  }
}

module.exports = { dashboardPage, sessionPage, stats, sessions, sessionDetail, feedbackCsv };
