const crypto = require('crypto');

let verifierSecret = process.env.VERIFIER_TOKEN_SECRET || null;

function initializeVerifierTokenSecret() {
  if (!verifierSecret) {
    verifierSecret = crypto.randomBytes(32).toString('hex');
    console.warn('VERIFIER_TOKEN_SECRET is unset. Verifier room tokens will reset when the server restarts.');
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signVerifierToken(roomId) {
  initializeVerifierTokenSecret();
  if (typeof roomId !== 'string' || !/^[a-f0-9]{12}$/i.test(roomId)) {
    throw new TypeError('A valid roomId is required to sign a verifier token.');
  }
  const payload = {
    roomId,
    exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
    nonce: crypto.randomBytes(16).toString('hex')
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', verifierSecret).update(encodedPayload).digest();
  return `${encodedPayload}.${signature.toString('base64url')}`;
}

function verifyVerifierToken(token, roomId) {
  try {
    if (typeof token !== 'string' || token.length > 2048 || typeof roomId !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
    initializeVerifierTokenSecret();
    const receivedSignature = Buffer.from(parts[1], 'base64url');
    const expectedSignature = crypto.createHmac('sha256', verifierSecret).update(parts[0]).digest();
    if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) return false;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return payload.roomId === roomId && Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000) &&
      typeof payload.nonce === 'string' && /^[a-f0-9]{32}$/.test(payload.nonce);
  } catch (_error) {
    return false;
  }
}

module.exports = { initializeVerifierTokenSecret, signVerifierToken, verifyVerifierToken };
