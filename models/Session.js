const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  inviteToken: { type: String, required: true },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  decision: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  virtualCamera: {
    flagged: { type: Boolean, default: false },
    label: { type: String, default: null },
    at: { type: Date, default: null }
  },
  challenges: [{
    type: { type: String, required: true },
    text: { type: String, default: undefined },
    result: { type: String, enum: ['pass', 'fail', 'timeout'], required: true },
    at: { type: Date, required: true }
  }],
  summary: {
    peakRisk: { type: Number, default: null },
    avgRisk: { type: Number, default: null },
    finalLabel: { type: String, default: 'Waiting for data' },
    scoreCount: { type: Number, default: 0 },
    mockUsed: { type: Boolean, default: false },
    durationSec: { type: Number, default: 0 }
  }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('Session', sessionSchema);
