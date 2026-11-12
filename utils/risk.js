const MAX_HISTORY = 3;
const RISK_LOW = Number(process.env.RISK_LOW || 0.35);
const RISK_HIGH = Number(process.env.RISK_HIGH || 0.65);
const STALE_MS = Number(process.env.STALE_MS || 6000);
const VCAM_RISK_BONUS = Number(process.env.VCAM_RISK_BONUS || 25);
const LIVENESS_FAIL_BONUS = Number(process.env.LIVENESS_FAIL_BONUS || 30);

function createRiskState() {
  return {
    audio: [],
    face: [],
    faceNote: null,
    virtualCamera: { flagged: false, label: null, matched: null, otherVirtualPresent: false },
    latestChallenge: null
  };
}

function setVirtualCamera(state, flags) {
  state.virtualCamera = {
    flagged: Boolean(flags?.flagged),
    label: flags?.label || null,
    matched: flags?.matched || null,
    otherVirtualPresent: Boolean(flags?.otherVirtualPresent)
  };
}

function setLatestChallenge(state, challenge) {
  state.latestChallenge = challenge ? { type: challenge.type, result: challenge.result } : null;
}

function addScore(state, modality, result, now) {
  if (modality === 'face' && result.note === 'no_face') {
    state.face = [];
    state.faceNote = 'no_face';
    return;
  }
  if (modality === 'face') state.faceNote = null;
  if (result.score === null) return;

  state[modality].push({ score: result.score, ts: now });
  if (state[modality].length > MAX_HISTORY) state[modality].shift();
}

function average(history) {
  if (!history.length) return null;
  return history.reduce((sum, item) => sum + item.score, 0) / history.length;
}

function fresh(history, now) {
  const latest = history[history.length - 1];
  return Boolean(latest && now - latest.ts <= STALE_MS);
}

function reason(text, level) {
  return { text, level };
}

function challengeDescription(type) {
  const labels = {
    turn_left: 'turn head left',
    turn_right: 'turn head right',
    blink_twice: 'blink twice',
    show_palm: 'show open palm',
    read_digits: 'read digits aloud'
  };
  return labels[type] || 'challenge';
}

function fuse(state, now = Date.now()) {
  const audioFresh = fresh(state.audio, now);
  const faceFresh = fresh(state.face, now);
  const audio = audioFresh ? average(state.audio) : null;
  const face = faceFresh ? average(state.face) : null;
  let probability = null;
  let partial = false;

  if (audio !== null && face !== null) probability = (audio + face) / 2;
  else if (audio !== null || face !== null) {
    probability = audio ?? face;
    partial = true;
  }

  const virtualCameraFlagged = Boolean(state.virtualCamera?.flagged);
  const livenessResult = state.latestChallenge?.result;
  const liveness = livenessResult === 'pass' ? 'pass' : ['fail', 'timeout'].includes(livenessResult) ? 'fail' : 'none';
  const modifiers = { virtualCamera: virtualCameraFlagged, liveness };
  const modifierBonus = (virtualCameraFlagged ? VCAM_RISK_BONUS : 0) + (liveness === 'fail' ? LIVENESS_FAIL_BONUS : 0);
  const adjustedProbability = probability === null
    ? (modifierBonus > 0 ? Math.min(1, modifierBonus / 100) : null)
    : Math.min(1, probability + modifierBonus / 100);
  const risk = adjustedProbability === null ? null : Math.round(adjustedProbability * 100);

  let label = 'Waiting for data';
  if (adjustedProbability !== null) {
    if (adjustedProbability < RISK_LOW) label = 'Low';
    else if (adjustedProbability < RISK_HIGH) label = 'Medium';
    else label = 'High';
  }

  const reasons = [];
  if (audioFresh) {
    if (audio >= 0.5) reasons.push(reason(`Voice: synthetic artifacts (${audio.toFixed(2)})`, 'high'));
    else reasons.push(reason(`Voice sounds natural (${audio.toFixed(2)})`, 'low'));
  } else {
    reasons.push(reason('Waiting for audio', 'info'));
  }
  if (faceFresh) {
    if (face >= 0.5) reasons.push(reason(`Face: swap artifacts (${face.toFixed(2)})`, 'high'));
    else reasons.push(reason(`Face looks natural (${face.toFixed(2)})`, 'low'));
  } else if (state.faceNote === 'no_face') {
    reasons.push(reason('No face detected', 'info'));
  } else {
    reasons.push(reason('Waiting for face', 'info'));
  }
  if (virtualCameraFlagged) {
    reasons.push(reason(`Virtual camera detected (${state.virtualCamera.matched || state.virtualCamera.label || 'unknown'})`, 'high'));
  } else if (state.virtualCamera?.otherVirtualPresent) {
    reasons.push(reason('A virtual camera is installed but not in use', 'info'));
  }
  if (liveness === 'pass') {
    reasons.push(reason(`Liveness passed: ${challengeDescription(state.latestChallenge.type)}`, 'ok'));
  } else if (liveness === 'fail') {
    const failedText = state.latestChallenge.result === 'timeout' ? 'timed out' : 'FAILED';
    reasons.push(reason(`Liveness ${failedText}: ${challengeDescription(state.latestChallenge.type)}`, 'high'));
  }

  const severity = { high: 4, medium: 3, info: 2, ok: 1, low: 0 };
  reasons.sort((left, right) => severity[right.level] - severity[left.level]);
  return {
    audio,
    face,
    risk,
    label,
    partial,
    reasons,
    modifiers
  };
}

module.exports = { createRiskState, addScore, setVirtualCamera, setLatestChallenge, fuse };
