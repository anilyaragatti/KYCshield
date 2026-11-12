const consentCard = document.querySelector('#consent-card');
const errorCard = document.querySelector('#error-card');
const errorTitle = document.querySelector('#error-title');
const errorMessage = document.querySelector('#error-message');
const expiryTimer = document.querySelector('#expiry-timer');
const joinButton = document.querySelector('#join-btn');
const customerCall = document.querySelector('#customer-call');
const callMessage = document.querySelector('#call-message');
const customerStatus = document.querySelector('#customer-status');
const retryMediaButton = document.querySelector('#retry-media-btn');
const leaveButton = document.querySelector('#leave-btn');
const cameraPicker = document.querySelector('.camera-picker');
const cameraSelect = document.querySelector('#camera-select');
const challengeOverlay = document.querySelector('#challenge-overlay');
const challengeText = document.querySelector('#challenge-text');
const challengeTimer = document.querySelector('#challenge-timer');
const remoteVideo = document.querySelector('#remote-video');
const localVideo = document.querySelector('#local-video');
const token = window.location.pathname.split('/').filter(Boolean).pop();
const storageKey = `kycshield.room.${token}`;
let countdownId;
let inviteInfo = null;
let storedRoom = null;
let call = null;
let socket = null;
let leaving = false;
let challengeTimerId = null;

function readStoredRoom() {
  try {
    return JSON.parse(window.sessionStorage.getItem(storageKey) || 'null');
  } catch (_error) {
    return null;
  }
}

function saveStoredRoom(room) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(room));
    storedRoom = room;
  } catch (_error) {
    callMessage.textContent = 'This browser could not save the reconnect key. Keep this tab open during the call.';
  }
}

function showError(title, message) {
  consentCard.hidden = true;
  customerCall.hidden = true;
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorCard.hidden = false;
}

function startCountdown(expiresAt) {
  const expiry = new Date(expiresAt).getTime();
  const update = () => {
    const remaining = Math.max(0, expiry - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    expiryTimer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    if (remaining <= 0) {
      window.clearInterval(countdownId);
      if (socket) socket.disconnect();
      if (call) call.cleanup();
      showError('This invite has expired', 'Ask your bank for a new verification link.');
    }
  };
  update();
  countdownId = window.setInterval(update, 1000);
}

function showCallError(error) {
  callMessage.textContent = error.message || 'The call could not start. Please retry.';
  retryMediaButton.hidden = false;
}

function joinRoom() {
  if (!socket?.connected || !inviteInfo) return;
  const payload = {
    roomId: inviteInfo.roomId,
    role: 'customer',
    token
  };
  if (storedRoom?.joinKey) payload.joinKey = storedRoom.joinKey;
  socket.emit('join-room', payload);
}

async function refreshCameraList() {
  try {
    const devices = await window.KYCVirtualCam.listVideoInputs();
    const activeTrack = call?.getVideoTrack();
    const activeSettings = activeTrack?.getSettings?.() || {};
    cameraSelect.replaceChildren();
    devices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      cameraSelect.append(option);
    });
    if (activeSettings.deviceId) cameraSelect.value = activeSettings.deviceId;
    else if (activeTrack) {
      const match = devices.find((device) => device.label === window.KYCVirtualCam.activeTrackLabel(activeTrack));
      if (match) cameraSelect.value = match.deviceId;
    }
    cameraPicker.hidden = devices.length === 0;
    cameraSelect.disabled = devices.length < 2;
    return devices;
  } catch (_error) {
    cameraPicker.hidden = true;
    return [];
  }
}

async function reportDevice() {
  try {
    if (!socket?.connected || !inviteInfo || !call) return;
    const [activeTrack, devices] = [call.getVideoTrack(), await window.KYCVirtualCam.listVideoInputs()];
    socket.emit('device-report', {
      activeLabel: window.KYCVirtualCam.activeTrackLabel(activeTrack),
      allLabels: devices.map((device) => device.label).filter(Boolean)
    });
  } catch (_error) {
    callMessage.textContent = 'Camera information could not be updated. The call is still active.';
  }
}

async function switchCamera() {
  const deviceId = cameraSelect.value;
  if (!deviceId || !call) return;
  cameraSelect.disabled = true;
  let acquiredStream = null;
  try {
    acquiredStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: deviceId } }
    });
    const newTrack = acquiredStream.getVideoTracks()[0];
    if (!newTrack) throw new Error('The selected camera did not provide a video track.');
    await call.replaceVideoTrack(newTrack);
    acquiredStream = null;
    await refreshCameraList();
    await reportDevice();
    callMessage.textContent = 'Camera switched.';
  } catch (_error) {
    if (acquiredStream) acquiredStream.getTracks().forEach((track) => track.stop());
    callMessage.textContent = 'Could not switch cameras. Choose another camera or retry.';
    await refreshCameraList();
  } finally {
    cameraSelect.disabled = cameraSelect.options.length < 2;
  }
}

function hideChallenge() {
  if (challengeTimerId) window.clearInterval(challengeTimerId);
  challengeTimerId = null;
  challengeOverlay.hidden = true;
  challengeTimer.textContent = '--';
}

function showChallenge(challenge) {
  try {
    if (!challenge || typeof challenge.text !== 'string') return;
    challengeText.textContent = challenge.text;
    challengeOverlay.hidden = false;
    if (challengeTimerId) window.clearInterval(challengeTimerId);
    const expiresAt = new Date(challenge.expiresAt).getTime();
    const update = () => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      challengeTimer.textContent = `${seconds}s`;
      if (seconds <= 0) hideChallenge();
    };
    update();
    challengeTimerId = window.setInterval(update, 250);
  } catch (_error) {
    hideChallenge();
  }
}

function setupCall() {
  if (call) return;
  call = window.KYCWebRTC.createCall({
    localVideo,
    remoteVideo,
    onRemoteStream: () => { customerStatus.textContent = 'Connected'; },
    onConnectionChange: (state) => {
      if (state === 'connected') {
        customerStatus.textContent = 'Connected';
        callMessage.textContent = 'Video call connected.';
      } else if (state === 'failed') {
        customerStatus.textContent = 'Connection issue';
        callMessage.textContent = 'Video connection failed. Check your connection and retry.';
        retryMediaButton.hidden = false;
      }
    }
  });

  socket = io({ autoConnect: false });
  call.setSocket(socket);
  socket.on('connect', async () => {
    if (leaving) return;
    try {
      await call.startMedia();
      joinRoom();
    } catch (error) {
      showCallError(error);
    }
  });
  socket.on('joined', async ({ joinKey }) => {
    try {
      if (joinKey) {
        saveStoredRoom({
          roomId: inviteInfo.roomId,
          joinKey,
          expiresAt: inviteInfo.expiresAt
        });
      }
      customerStatus.textContent = 'Waiting for verifier';
      callMessage.textContent = 'You joined securely. Waiting for the verifier…';
      await refreshCameraList();
      await reportDevice();
    } catch (_error) {
      callMessage.textContent = 'You joined, but camera information could not be loaded.';
    }
  });
  socket.on('peer-joined', ({ role }) => {
    if (role === 'verifier') callMessage.textContent = 'Verifier joined. Connecting video…';
  });
  socket.on('peer-left', ({ role }) => {
    if (role !== 'verifier') return;
    call.cleanup();
    customerStatus.textContent = 'Verifier left';
    callMessage.textContent = 'The verifier ended the call.';
  });
  socket.on('challenge', (challenge) => showChallenge(challenge));
  socket.on('challenge-closed', () => {
    try { hideChallenge(); } catch (_error) { /* call signaling remains active */ }
  });
  socket.on('offer', (payload) => { call.handleOffer(payload).catch(showCallError); });
  socket.on('answer', (payload) => { call.handleAnswer(payload).catch(showCallError); });
  socket.on('ice', (payload) => { call.addIceCandidate(payload).catch(showCallError); });
  socket.on('join-error', ({ reason }) => {
    const messages = {
      not_found: 'This call room no longer exists.',
      ended: 'This call has already ended.',
      expired: 'This invite has expired. Ask your bank for a new link.',
      used: 'This invite was already used in another browser. Ask your bank for a new invite.',
      invalid_token: 'This invite is invalid. Ask your bank for a new invite.',
      server_error: 'The call could not be joined. Reload and try again.'
    };
    call.cleanup();
    callMessage.textContent = messages[reason] || 'This call could not be joined.';
    retryMediaButton.hidden = true;
  });
  socket.on('room-full', () => {
    call.cleanup();
    callMessage.textContent = 'This call already has a verifier and a customer.';
    retryMediaButton.hidden = true;
  });
  socket.on('disconnect', () => {
    if (leaving) return;
    call.cleanup();
    hideChallenge();
    customerStatus.textContent = 'Reconnecting';
    callMessage.textContent = 'Connection lost. Reconnecting…';
  });
  socket.on('connect_error', () => {
    if (!leaving) callMessage.textContent = 'Could not connect to the call server. Check the connection and retry.';
  });
}

async function startCustomerCall() {
  if (!inviteInfo) return;
  consentCard.hidden = true;
  customerCall.hidden = false;
  callMessage.textContent = 'Requesting camera and microphone…';
  retryMediaButton.hidden = true;
  joinButton.disabled = true;
  try {
    setupCall();
    await call.startMedia();
    await refreshCameraList();
    if (!socket.connected) socket.connect();
    else joinRoom();
  } catch (error) {
    showCallError(error);
  } finally {
    joinButton.disabled = false;
  }
}

async function retryMedia() {
  retryMediaButton.hidden = true;
  callMessage.textContent = 'Requesting camera and microphone…';
  try {
    await call.startMedia();
    await refreshCameraList();
    if (!socket.connected) socket.connect();
    else joinRoom();
  } catch (error) {
    showCallError(error);
  }
}

function leaveCall() {
  leaving = true;
  if (socket?.connected) socket.emit('leave');
  if (call) call.cleanup();
  hideChallenge();
  if (socket) socket.disconnect();
  customerStatus.textContent = 'Call ended';
  callMessage.textContent = 'You left the call.';
  retryMediaButton.hidden = true;
  leaveButton.disabled = true;
  leaveButton.textContent = 'Call ended';
}

async function validateInvite() {
  if (!token) return showError('This invite is unavailable', 'The verification link is missing or incomplete.');
  storedRoom = readStoredRoom();
  try {
    const response = await fetch(`/api/invites/${encodeURIComponent(token)}/validate`, {
      headers: { Accept: 'application/json' }
    });
    const data = await response.json();
    if (data.valid) {
      inviteInfo = data;
    } else if (data.reason === 'used' && storedRoom?.joinKey && storedRoom.roomId && storedRoom.expiresAt > new Date().toISOString()) {
      inviteInfo = { valid: true, roomId: storedRoom.roomId, expiresAt: storedRoom.expiresAt };
    } else {
      const messages = {
        expired: ['This invite has expired', 'Ask your bank for a new verification link.'],
        used: ['This invite was already used', 'Ask your bank for a new verification link if you still need to verify.'],
        not_found: ['This invite is unavailable', 'Check the link or ask your bank to send another invite.']
      };
      const [title, message] = messages[data.reason] || messages.not_found;
      return showError(title, message);
    }
    consentCard.hidden = false;
    startCountdown(inviteInfo.expiresAt);
  } catch (_error) {
    showError('Unable to check this invite', 'Please check your connection and reload the page.');
  }
}

joinButton.addEventListener('click', startCustomerCall);
retryMediaButton.addEventListener('click', retryMedia);
leaveButton.addEventListener('click', leaveCall);
cameraSelect.addEventListener('change', () => { switchCamera().catch(() => {}); });
validateInvite();
