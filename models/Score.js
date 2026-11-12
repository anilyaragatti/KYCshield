const mongoose = require('mongoose');

const scoreSchema = new mongoose.Schema({
  roomId: { type: String, required: true },
  ts: { type: Date, required: true },
  audio: { type: Number, default: null },
  face: { type: Number, default: null },
  risk: { type: Number, default: null },
  label: { type: String, enum: ['Low', 'Medium', 'High', 'Waiting for data'], required: true },
  reasons: { type: [String], default: [] },
  backend: { type: String, enum: ['mock', 'hf'], required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

scoreSchema.index({ roomId: 1 });

module.exports = mongoose.model('Score', scoreSchema);
