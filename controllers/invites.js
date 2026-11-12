const crypto = require('crypto');
const nodemailer = require('nodemailer');
const Invite = require('../models/Invite');
const Session = require('../models/Session');

function identifyContact(contact) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
    return { contactType: 'email' };
  }
  const digits = contact.replace(/[\s().-]/g, '').replace(/^\+/, '');
  return { contactType: 'phone', digits };
}

async function sendInviteEmail(to, link) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email delivery is not configured.');
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: `KYCShield <${process.env.SMTP_USER}>`,
    to,
    subject: 'Your secure video identity check',
    text: `Your bank invited you to a live verification call. The call is analyzed in real time to detect deepfake fraud. Join here: ${link}`,
    html: `<div><h2>Your video identity check</h2><p>Your bank invited you to a live verification call. The call is analyzed in real time to detect deepfake fraud.</p><p><a href="${link}">Join verification</a></p><p>If the link does not work, copy this address: <a href="${link}">${link}</a></p></div>`
  });
}

async function create(req, res) {
  const { contact } = req.validatedBody;
  const { contactType, digits } = identifyContact(contact);
  const ttlMinutes = Number.parseInt(process.env.INVITE_TTL_MINUTES, 10) || 15;
  const token = crypto.randomBytes(24).toString('hex');
  const roomId = crypto.randomBytes(6).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const invite = await new Invite({
    token,
    roomId,
    contact,
    contactType,
    expiresAt
  }).save();
  await new Session({ roomId, inviteToken: token }).save();

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:1009').replace(/\/$/, '');
  const link = `${baseUrl}/join/${token}`;
  const response = { link, roomId };
  if (contactType === 'phone') {
    response.whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(link)}`;
  } else {
    try {
      await sendInviteEmail(contact, link);
      response.emailSent = true;
    } catch (_error) {
      response.emailSent = false;
      response.error = 'Invite link created, but email could not be sent. Check SMTP settings and share the link manually.';
    }
  }
  res.status(201).json(response);
}

async function validateToken(req, res) {
  const invite = await Invite.findOne({ token: req.params.token }).lean();
  if (!invite) return res.json({ valid: false, reason: 'not_found' });
  if (invite.used) return res.json({ valid: false, reason: 'used' });
  if (invite.expiresAt <= new Date()) return res.json({ valid: false, reason: 'expired' });
  return res.json({ valid: true, roomId: invite.roomId, expiresAt: invite.expiresAt });
}

module.exports = { create, validateToken };
