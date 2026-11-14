const roomId = document.querySelector('#room-id').textContent.trim();
const verifierToken = document.querySelector('#room-page').dataset.verifierToken;
const statusChip = document.querySelector('#status-chip');
const callMessage = document.querySelector('#call-message');
const retryMediaButton = document.querySelector('#retry-media-btn');
const remotePlaceholder = document.querySelector('#remote-placeholder');
const timerDisplay = document.querySelector('#call-timer');
const latencyChip = document.querySelector('#latency-chip');
const riskGaugeValue = document.querySelector('#risk-gauge-value');
const riskGaugeArc = document.querySelector('#risk-gauge-arc');
const riskLabel = document.querySelector('#risk-label');
const reasonsList = document.querySelector('#reasons-list');
const modeChip = document.querySelector('#mode-chip');
const detectorChip = document.querySelector('#detector-chip');
let lastDetectorStatus = null;
detectorChip.textContent = 'Waiting for detector';
detectorChip.classList.remove('detector-online', 'detector-offline');
const cameraFlag = document.querySelector('#camera-flag');
const challengeButton = document.querySelector('#challenge-btn');
const challengeStatus = document.querySelector('#challenge-status');
const challengeInstruction = document.querySelector('#challenge-instruction');
const challengePassButton = document.querySelector('#challenge-pass-btn');
const challengeFailButton = document.querySelector('#challenge-fail-btn');
const challengeHistory = document.querySelector('#challenge-history');
const decisionMessage = document.querySelector('#decision-message');
const approveButton = document.querySelector('#approve-btn');
const rejectButton = document.querySelector('#reject-btn');
const endCallButton = document.querySelector('#end-call-btn');
const feedbackCard = document.querySelector('#analyst-feedback-card');
const feedbackFraudButton = document.querySelector('#feedback-fraud-btn');
const feedbackFalseButton = document.querySelector('#feedback-false-btn');
const feedbackNote = document.querySelector('#feedback-note');
const feedbackMessage = document.querySelector('#feedback-message');
const remoteVideo = document.querySelector('#remote-video');
const localVideo = document.querySelector('#local-video');

let manuallyEnded = false;
let timerStartedAt = null;
let elapsedCallTime = 0;
let timerInterval = null;
let latencySamples = [];
let activeChallenge = null;
let challengeCountdownTimer = null;
let challengeCooldownTimer = null;
let challengeCooldownUntil = 0;
let challengeRequestPending = false;
let challengeResultPending = false;

const call = window.KYCWebRTC.createCall({
  localVideo,
  remoteVideo,
  onRemoteStream: () => { remotePlaceholder.hidden = true; },
  onConnectionChange: (state) => {
    if (state === 'connected') {
      statusChip.textContent = 'Connected';
      callMessage.textContent = 'Call connected.';
      startCallTimer();
    } else if (state === 'failed') {
      callMessage.textContent = 'Video connection failed. Check the connection and retry your camera.';
      retryMediaButton.hidden = false;
    }
  }
});

const socket = io({ autoConnect: false });
window.kycSocket = socket;
call.setSocket(socket);

function updateTimer() {
  if (!timerStartedAt) return;
  const runningTime = elapsedCallTime + (timerStartedAt ? Date.now() - timerStartedAt : 0);
  const seconds = Math.floor(runningTime / 1000);
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secondsPart = String(seconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${minutesPart}:${secondsPart}`;
}

function startCallTimer() {
  if (timerInterval) return;
  timerStartedAt = Date.now();
  updateTimer();
  timerInterval = window.setInterval(updateTimer, 1000);
}

function stopCallTimers() {
  if (timerStartedAt) {
    elapsedCallTime += Date.now() - timerStartedAt;
    timerStartedAt = null;
    updateTimer();
  }
  if (timerInterval) window.clearInterval(timerInterval);
  timerInterval = null;
}

function showMediaError(error) {
  callMessage.textContent = error.message || 'Could not start camera and microphone. Please retry.';
  retryMediaButton.hidden = false;
}

async function connectRoom() {
  retryMediaButton.hidden = true;
  callMessage.textContent = 'Requesting camera and microphone…';
  try {
    await call.startMedia();
    if (!socket.connected) socket.connect();
    else socket.emit('join-room', { roomId, role: 'verifier', verifierToken });
  } catch (error) {
    showMediaError(error);
  }
}

socket.on('connect', async () => {
  if (manuallyEnded) return;
  try {
    await call.startMedia();
    socket.emit('join-room', { roomId, role: 'verifier', verifierToken });
  } catch (error) {
    showMediaError(error);
  }
});

socket.on('joined', ({ role }) => {
  if (role === 'verifier') {
    statusChip.textContent = 'Waiting for customer';
    callMessage.textContent = 'You are in the room. Waiting for the customer to join…';
  }
});

socket.on('peer-joined', ({ role }) => {
  if (role !== 'customer') return;
  callMessage.textContent = 'Customer joined. Connecting video…';
  call.createOffer().catch(showMediaError);
});

socket.on('peer-left', ({ role }) => {
  if (role !== 'customer') return;
  statusChip.textContent = 'Customer left';
  callMessage.textContent = 'The customer left the call.';
  remotePlaceholder.hidden = false;
  remotePlaceholder.textContent = 'Customer left the call';
  call.cleanup();
  window.kycDetection?.stop().catch(() => {});
  stopCallTimers();
});

socket.on('offer', (payload) => { call.handleOffer(payload).catch(showMediaError); });
socket.on('answer', (payload) => { call.handleAnswer(payload).catch(showMediaError); });
socket.on('ice', (payload) => { call.addIceCandidate(payload).catch(showMediaError); });

socket.on('join-error', ({ reason }) => {
  const messages = {
    not_found: 'This room does not exist.',
    ended: 'This call has already ended.',
    unauthorized: 'Verifier authorization failed. Reload the room and try again.',
    rate_limited: 'Too many room join attempts. Wait a minute and try again.',
    server_error: 'The room could not be joined. Reload and try again.'
  };
  callMessage.textContent = messages[reason] || 'This room could not be joined.';
  call.cleanup();
  retryMediaButton.hidden = true;
});

socket.on('room-full', () => {
  callMessage.textContent = 'This room already has a verifier and a customer.';
  call.cleanup();
  retryMediaButton.hidden = true;
});

socket.on('disconnect', () => {
  if (manuallyEnded) return;
  call.cleanup();
  window.kycDetection?.stop().catch(() => {});
  statusChip.textContent = 'Waiting for customer';
  callMessage.textContent = 'Connection lost. Reconnecting…';
  remotePlaceholder.hidden = false;
  remotePlaceholder.textContent = 'Reconnecting to the room…';
  stopCallTimers();
});

socket.on('connect_error', () => {
  if (!manuallyEnded) callMessage.textContent = 'Could not connect to the call server. Check the connection and retry.';
});

function updateGauge(risk, label) {
  const percent = risk === null ? null : Math.max(0, Math.min(100, Number(risk)));
  riskGaugeValue.textContent = percent === null || !Number.isFinite(percent) ? '--' : String(percent);
  const fill = percent === null || !Number.isFinite(percent) ? 0 : percent / 100;
  const arcLength = 251.33;
  riskGaugeArc.style.strokeDasharray = String(arcLength);
  riskGaugeArc.style.strokeDashoffset = String(arcLength * (1 - fill));
  riskGaugeArc.setAttribute('class', `risk-gauge-arc ${String(label || '').toLowerCase()}`);
  const labels = { Low: 'LOW RISK', Medium: 'MEDIUM RISK', High: 'HIGH RISK' };
  riskLabel.textContent = labels[label] || 'Waiting for data';
}

function resetDetectionDisplay() {
  latencySamples = [];
  latencyChip.textContent = 'Latency -- ms';
  updateGauge(null, 'Waiting for data');
  updateReasons([{ text: 'Reasons will appear here', level: 'info' }]);
  modeChip.textContent = 'Waiting for detector';
  modeChip.classList.remove('mock-mode');
}

function updateReasons(reasons) {
  const normalized = Array.isArray(reasons) ? reasons : [];
  const signature = JSON.stringify(normalized.map((item) => [item.text, item.level]));
  if (reasonsList.dataset.signature === signature) return;
  reasonsList.dataset.signature = signature;
  if (reasonsList.children.length === normalized.length && [...reasonsList.children].every((row) => row.classList.contains('reason-row'))) {
    normalized.forEach((item, index) => {
      const row = reasonsList.children[index];
      const dot = row.querySelector('.reason-dot');
      const text = row.querySelector('.reason-text');
      dot.className = `reason-dot ${['high', 'medium', 'low', 'info'].includes(item.level) ? item.level : 'info'}`;
      if (text.textContent !== item.text) text.textContent = item.text;
    });
    return;
  }
  const rows = normalized.map((item) => {
    const row = document.createElement('li');
    row.className = 'reason-row';
    const dot = document.createElement('span');
    dot.className = `reason-dot ${['high', 'medium', 'low', 'info'].includes(item.level) ? item.level : 'info'}`;
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'reason-text';
    text.textContent = item.text;
    row.append(dot, text);
    return row;
  });
  reasonsList.replaceChildren(...rows);
}

function recordLatency(update) {
  if (!window.kycDetection?.isFrameTimestamp(update.clientTs)) return;
  const sample = Math.max(0, Date.now() - update.clientTs);
  latencySamples.push(sample);
  if (latencySamples.length > 5) latencySamples.shift();
  const average = Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length);
  latencyChip.textContent = `Latency ${average} ms`;
}

socket.on('score-update', (update) => {
  try {
    if (!update || typeof update !== 'object') return;
    window.kycDetection?.resolveFrame(update);
    updateGauge(update.risk, update.label);
    updateReasons(update.reasons);
    modeChip.textContent = update.backend === 'mock'
      ? 'MOCK MODE - not real detection'
      : update.backend === 'hf' ? 'Live models' : 'Waiting for detector';
    modeChip.classList.toggle('mock-mode', Boolean(update.mock));
    recordLatency(update);
  } catch (_error) {
    callMessage.textContent = 'Detection display issue; the call remains active.';
  }
});

function renderDetectorStatus(status) {
  const online = Boolean(status?.ok);
  detectorChip.textContent = online ? 'Detector online' : 'Detector offline';
  detectorChip.classList.toggle('detector-online', online);
  detectorChip.classList.toggle('detector-offline', !online);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && lastDetectorStatus) {
    renderDetectorStatus(lastDetectorStatus);
  }
});

socket.on('detector-status', (status) => {
  try {
    lastDetectorStatus = status;
    renderDetectorStatus(status);
    const online = Boolean(status?.ok);
    if (!online) callMessage.textContent = 'Detector unavailable; the video call is still active.';
    else if (status && status.ok) callMessage.textContent = 'Call connected.';
  } catch (_error) {
    // Keep display errors isolated from the call connection.
  }
});

socket.on('camera-flag', (flag) => {
  try {
    if (!flag?.flagged) {
      cameraFlag.hidden = true;
      cameraFlag.textContent = '';
      return;
    }
    cameraFlag.textContent = `Virtual camera detected: ${flag.label || flag.matched || 'Unknown camera'}`;
    cameraFlag.hidden = false;
  } catch (_error) {
    // Camera label rendering must not interfere with the call.
  }
});

function challengeTypeLabel(type) {
  const labels = {
    turn_left: 'Turn head left',
    turn_right: 'Turn head right',
    blink_twice: 'Blink twice',
    show_palm: 'Show open palm',
    read_digits: 'Read digits aloud'
  };
  return labels[type] || 'Liveness challenge';
}

function updateChallengeCountdown() {
  if (!activeChallenge) return;
  const remainingMs = activeChallenge.expiresAt - Date.now();
  if (remainingMs <= 0) {
    challengeStatus.textContent = 'Waiting for result…';
    challengePassButton.disabled = true;
    challengeFailButton.disabled = true;
    return;
  }
  challengeStatus.textContent = `${Math.ceil(remainingMs / 1000)}s remaining`;
  challengePassButton.disabled = challengeResultPending;
  challengeFailButton.disabled = challengeResultPending;
}

function scheduleChallengeButton() {
  if (challengeCooldownTimer) window.clearTimeout(challengeCooldownTimer);
  const wait = challengeCooldownUntil - Date.now();
  challengeButton.disabled = Boolean(activeChallenge) || challengeRequestPending || wait > 0;
  if (wait > 0 && !activeChallenge) {
    challengeCooldownTimer = window.setTimeout(() => {
      challengeCooldownTimer = null;
      scheduleChallengeButton();
    }, wait);
  }
}

function closeChallenge(challengeId, result) {
  if (!activeChallenge || activeChallenge.id !== challengeId) return;
  if (challengeCountdownTimer) window.clearInterval(challengeCountdownTimer);
  challengeCountdownTimer = null;
  challengeHistory.querySelector('.challenge-empty')?.remove();
  const row = document.createElement('li');
  row.className = `challenge-history-row ${result}`;
  const description = document.createElement('span');
  description.textContent = challengeTypeLabel(activeChallenge.type);
  const outcome = document.createElement('strong');
  outcome.textContent = result === 'pass' ? 'Passed' : result === 'fail' ? 'Failed' : 'Timed out';
  const time = document.createElement('time');
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString();
  row.append(description, outcome, time);
  challengeHistory.prepend(row);
  activeChallenge = null;
  challengeResultPending = false;
  challengeRequestPending = false;
  challengeStatus.textContent = 'Idle';
  challengeInstruction.textContent = '';
  challengeInstruction.hidden = true;
  challengePassButton.disabled = true;
  challengeFailButton.disabled = true;
  scheduleChallengeButton();
}

challengeButton.addEventListener('click', () => {
  try {
    if (!socket.connected || activeChallenge) return;
    challengeRequestPending = true;
    challengeButton.disabled = true;
    challengeStatus.textContent = 'Waiting for customer...';
    socket.emit('challenge-request');
  } catch (_error) {
    challengeRequestPending = false;
    challengeStatus.textContent = 'Could not send the challenge. The call is still active.';
    scheduleChallengeButton();
  }
});

socket.on('challenge-sent', (challenge) => {
  try {
    if (!challenge?.id || !challenge?.expiresAt) return;
    activeChallenge = {
      id: challenge.id,
      type: challenge.type,
      text: challenge.text,
      expiresAt: new Date(challenge.expiresAt).getTime()
    };
    challengeRequestPending = false;
    challengeResultPending = false;
    challengeInstruction.textContent = challenge.text;
    challengeInstruction.hidden = false;
    challengeCooldownUntil = Date.now() + 5000;
    challengeStatus.textContent = 'Waiting for customer...';
    challengePassButton.disabled = false;
    challengeFailButton.disabled = false;
    updateChallengeCountdown();
    if (challengeCountdownTimer) window.clearInterval(challengeCountdownTimer);
    challengeCountdownTimer = window.setInterval(updateChallengeCountdown, 250);
    scheduleChallengeButton();
  } catch (_error) {
    challengeStatus.textContent = 'Challenge started, but its status could not be displayed.';
  }
});

socket.on('challenge-error', (error) => {
  try {
    challengeRequestPending = false;
    const messages = {
      customer_not_connected: 'Waiting for customer...',
      active: 'A challenge is already active.',
      cooldown: 'Please wait before sending another challenge.',
      unavailable: 'Could not create a challenge. Try again.'
    };
    challengeStatus.textContent = messages[error?.reason] || 'Could not send the challenge.';
    if (error?.reason === 'cooldown') challengeCooldownUntil = Date.now() + Math.max(0, Number(error.retryAfterMs) || 0);
    scheduleChallengeButton();
  } catch (_error) {
    challengeStatus.textContent = 'Could not send the challenge.';
  }
});

function submitChallengeResult(result) {
  try {
    if (!activeChallenge || Date.now() >= activeChallenge.expiresAt) return;
    challengeResultPending = true;
    challengePassButton.disabled = true;
    challengeFailButton.disabled = true;
    challengeStatus.textContent = 'Submitting result…';
    socket.emit('challenge-result', { id: activeChallenge.id, result });
  } catch (_error) {
    challengeResultPending = false;
    challengeStatus.textContent = 'Could not submit the result.';
    updateChallengeCountdown();
  }
}

challengePassButton.addEventListener('click', () => submitChallengeResult('pass'));
challengeFailButton.addEventListener('click', () => submitChallengeResult('fail'));
socket.on('challenge-closed', ({ id, result }) => {
  try { closeChallenge(id, result); } catch (_error) { /* keep call active if history UI fails */ }
});

window.addEventListener('kyc-analysis-stopped', resetDetectionDisplay);

async function saveDecision(decision) {
  approveButton.disabled = true;
  rejectButton.disabled = true;
  decisionMessage.textContent = 'Saving decision…';
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(roomId)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ decision })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Decision could not be saved.');
    decisionMessage.textContent = `Decision saved: ${result.decision}.`;
    feedbackCard.hidden = false;
    feedbackMessage.textContent = 'Feedback is stored for future model retraining.';
  } catch (error) {
    decisionMessage.textContent = error.message || 'Decision could not be saved. Try again.';
  } finally {
    approveButton.disabled = false;
    rejectButton.disabled = false;
  }
}

async function saveFeedback(verdict) {
  feedbackFraudButton.disabled = true;
  feedbackFalseButton.disabled = true;
  feedbackMessage.textContent = 'Saving feedback…';
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(roomId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ verdict, note: feedbackNote.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.detail || 'Feedback could not be saved.');
    feedbackMessage.textContent = 'Feedback saved. It is stored for future model retraining.';
    feedbackCard.classList.add('feedback-saved');
  } catch (error) {
    feedbackMessage.textContent = error.message || 'Feedback could not be saved. Try again.';
  } finally {
    feedbackFraudButton.disabled = false;
    feedbackFalseButton.disabled = false;
  }
}

function endCall() {
  if (manuallyEnded) return;
  manuallyEnded = true;
  socket.emit('leave');
  window.kycDetection?.stop().catch(() => {});
  call.cleanup();
  stopCallTimers();
  socket.disconnect();
  statusChip.textContent = 'Call ended';
  callMessage.textContent = 'This call has ended.';
  remotePlaceholder.hidden = false;
  remotePlaceholder.textContent = 'Call ended';
  endCallButton.disabled = true;
}

approveButton.addEventListener('click', () => saveDecision('approved'));
rejectButton.addEventListener('click', () => saveDecision('rejected'));
feedbackFraudButton.addEventListener('click', () => saveFeedback('fraud'));
feedbackFalseButton.addEventListener('click', () => saveFeedback('false_alarm'));
endCallButton.addEventListener('click', endCall);
retryMediaButton.addEventListener('click', connectRoom);

connectRoom();
