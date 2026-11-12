const Session = require('../models/Session');
const Score = require('../models/Score');
const Feedback = require('../models/Feedback');
const ExpressError = require('../utils/ExpressError');
const { recomputeSessionSummary } = require('../utils/sessionSummary');
const { getSessionAnalytics } = require('../utils/sessionAnalytics');
const { buildAuditReport } = require('../utils/report');

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
  await recomputeSessionSummary(req.validatedParams.roomId);
  res.json({ decision: updatedSession.decision });
}

async function saveFeedback(req, res) {
  const { roomId } = req.validatedParams;
  const { verdict, note } = req.validatedBody;
  await recomputeSessionSummary(roomId);
  const session = await Session.findOne({ roomId }).select('summary').lean();
  if (!session) throw new ExpressError(404, 'Session not found.');
  const [latestScore] = await Score.find({ roomId }).sort({ ts: -1 }).limit(1).select('risk label').lean();

  const feedback = await Feedback.findOneAndUpdate(
    { roomId },
    {
      $set: {
        verdict,
        note,
        riskAtDecision: latestScore?.risk ?? session.summary?.peakRisk ?? null,
        label: latestScore?.label || session.summary?.finalLabel || 'Waiting for data'
      }
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).select('roomId verdict note riskAtDecision label createdAt updatedAt').lean();

  res.status(200).json({ feedback });
}

async function reportPdf(req, res) {
  const { roomId } = req.validatedParams;
  const session = await Session.findOne({ roomId })
    .select('roomId startedAt endedAt decision virtualCamera challenges summary createdAt')
    .lean();
  if (!session) throw new ExpressError(404, 'Session not found.');
  const summary = await recomputeSessionSummary(roomId);
  const [analytics, feedback] = await Promise.all([
    getSessionAnalytics(roomId),
    Feedback.findOne({ roomId }).select('verdict note riskAtDecision label createdAt').lean()
  ]);

  const doc = buildAuditReport({
    session,
    summary: summary || session.summary || {},
    timeline: analytics.timeline,
    reasonCounts: analytics.reasonCounts,
    feedback
  });
  doc.on('error', () => { if (!res.destroyed) res.destroy(); });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="KYCShield-${roomId}.pdf"`,
    'Cache-Control': 'no-store'
  });
  doc.pipe(res);
  doc.end();
}

module.exports = { index, updateDecision, saveFeedback, reportPdf };
