const crypto = require('crypto');

const CHALLENGE_TYPES = [
  { type: 'turn_left', text: 'Turn your head to the left' },
  { type: 'turn_right', text: 'Turn your head to the right' },
  { type: 'blink_twice', text: 'Blink twice slowly' },
  { type: 'show_palm', text: 'Show your open palm to the camera' },
  { type: 'read_digits', text: null }
];

function createChallenge() {
  try {
    const challenge = CHALLENGE_TYPES[crypto.randomInt(CHALLENGE_TYPES.length)];
    const ttlCandidate = Number(process.env.CHALLENGE_TTL_MS || 15000);
    const ttlMs = Number.isFinite(ttlCandidate) && ttlCandidate > 0 ? ttlCandidate : 15000;
    let text = challenge.text;
    if (challenge.type === 'read_digits') {
      let digits = '';
      for (let index = 0; index < 4; index += 1) digits += String(crypto.randomInt(0, 10));
      text = `Read these digits aloud: ${digits}`;
    }
    return {
      id: crypto.randomBytes(12).toString('hex'),
      type: challenge.type,
      text,
      ttlMs
    };
  } catch (error) {
    throw new Error('Could not create a liveness challenge.', { cause: error });
  }
}

module.exports = { createChallenge };
