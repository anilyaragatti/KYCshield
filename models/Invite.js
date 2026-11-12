const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  roomId: { type: String, required: true },
  contact: { type: String, required: true },
  contactType: { type: String, enum: ['email', 'phone'], required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false }
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('Invite', inviteSchema);
