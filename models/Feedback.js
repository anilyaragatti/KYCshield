const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  verdict: { type: String, enum: ['fraud', 'false_alarm'], required: true },
  note: { type: String, maxlength: 300, default: '' },
  riskAtDecision: { type: Number, default: null },
  label: { type: String, default: 'Waiting for data' }
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
