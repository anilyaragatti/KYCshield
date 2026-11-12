(() => {
  const root = document.querySelector('#room-page');
  const remoteVideo = document.querySelector('#remote-video');
  const toggleButton = document.querySelector('#analysis-toggle-btn');
  const analysisStatus = document.querySelector('#analysis-status');
  const socket = window.kycSocket;
  const frameIntervalMs = Number(root?.dataset.frameIntervalMs) || 350;
  const FRAME_LIMIT_BYTES = 300 * 1024;
  const TARGET_RATE = 16000;
  const WINDOW_SECONDS = 2;
  const SILENCE_RMS = 0.008;

  let active = false;
  let frameTimer = null;
  let audioTimer = null;
  let frameTimeout = null;
  let frameInFlight = null;
  let framePreparing = false;
  let frameSequence = 0;
  let audioSequence = 0;
  let audioContext = null;
  let audioSource = null;
  let audioNode = null;
  let silentGain = null;
  let ring = null;
  let ringWrite = 0;
  let ringCount = 0;
  let frameTimes = [];

  function setStatus(message) {
    analysisStatus.textContent = message;
  }

  function appendAudioBlock(block) {
    if (!ring) return;
    for (let index = 0; index < block.length; index += 1) {
      ring[ringWrite] = block[index];
      ringWrite = (ringWrite + 1) % ring.length;
      ringCount = Math.min(ringCount + 1, ring.length);
    }
  }

  function latestWindow() {
    const sourceRate = audioContext.sampleRate;
    const needed = Math.round(sourceRate * WINDOW_SECONDS);
    if (ringCount < needed) return null;
    const samples = new Float32Array(needed);
    const start = (ringWrite - needed + ring.length) % ring.length;
    for (let index = 0; index < needed; index += 1) samples[index] = ring[(start + index) % ring.length];

    const outputLength = TARGET_RATE * WINDOW_SECONDS;
    if (sourceRate === TARGET_RATE) return samples;
    const resampled = new Float32Array(outputLength);
    const ratio = (samples.length - 1) / Math.max(1, outputLength - 1);
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const low = Math.floor(position);
      const high = Math.min(samples.length - 1, low + 1);
      const fraction = position - low;
      resampled[index] = samples[low] * (1 - fraction) + samples[high] * fraction;
    }
    return resampled;
  }

  function createWav(samples) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const writeText = (offset, text) => {
      for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, TARGET_RATE, true);
    view.setUint32(28, TARGET_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return bytes;
  }

  function sendAudioWindow() {
    try {
      if (!active || !socket?.connected) return;
      const samples = latestWindow();
      if (!samples) {
        setStatus('Collecting 2 seconds of customer audio…');
        return;
      }
      let squareSum = 0;
      for (const sample of samples) squareSum += sample * sample;
      const rms = Math.sqrt(squareSum / samples.length);
      if (rms < SILENCE_RMS) {
        setStatus('No speech detected yet');
        return;
      }
      const ts = Date.now();
      socket.emit('audio', { seq: ++audioSequence, ts, data: createWav(samples) });
      setStatus('Live analysis running');
    } catch (_error) {
      setStatus('Audio analysis unavailable; the call is still active');
    }
  }

  async function sendFrame() {
    if (!active || !socket?.connected || frameInFlight || framePreparing || remoteVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    framePreparing = true;
    try {
      const width = remoteVideo.videoWidth;
      const height = remoteVideo.videoHeight;
      if (!width || !height) return;
      const scale = Math.min(1, 640 / width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      context.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob || blob.size > FRAME_LIMIT_BYTES || !active || !socket.connected) return;
      const data = await blob.arrayBuffer();
      const ts = Date.now();
      frameInFlight = { ts, seq: ++frameSequence };
      frameTimes.push(ts);
      if (frameTimes.length > 12) frameTimes.shift();
      socket.emit('frame', { seq: frameInFlight.seq, ts, data });
      frameTimeout = window.setTimeout(() => {
        frameInFlight = null;
        frameTimeout = null;
      }, 3000);
    } catch (_error) {
      frameInFlight = null;
      setStatus('Frame analysis unavailable; the call is still active');
    } finally {
      framePreparing = false;
    }
  }

  async function start() {
    if (active) return;
    if (!socket?.connected) {
      setStatus('Connect to the customer before starting analysis');
      return;
    }
    const stream = remoteVideo.srcObject;
    if (!stream || !stream.getAudioTracks().length) {
      setStatus('Customer audio is not available yet');
      return;
    }
    try {
      active = true;
      toggleButton.textContent = 'Stop analysis';
      remoteVideo.muted = false;
      await remoteVideo.play().catch(() => {});
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio capture is not supported in this browser.');
      try {
        audioContext = new AudioContextClass({ sampleRate: TARGET_RATE });
      } catch (_error) {
        audioContext = new AudioContextClass();
      }
      await audioContext.resume();
      await audioContext.audioWorklet.addModule('/js/audio-worklet.js');
      audioSource = audioContext.createMediaStreamSource(stream);
      audioNode = new AudioWorkletNode(audioContext, 'kyc-mono-capture');
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      ring = new Float32Array(Math.max(TARGET_RATE * 4, audioContext.sampleRate * 4));
      ringWrite = 0;
      ringCount = 0;
      audioNode.port.onmessage = (event) => appendAudioBlock(new Float32Array(event.data));
      audioSource.connect(audioNode);
      audioNode.connect(silentGain);
      silentGain.connect(audioContext.destination);
      frameTimer = window.setInterval(() => { sendFrame().catch(() => {}); }, frameIntervalMs);
      audioTimer = window.setInterval(sendAudioWindow, 1000);
      sendFrame().catch(() => {});
      setStatus('Live analysis running');
    } catch (error) {
      await stop(false);
      setStatus(error.message || 'Could not start analysis; the call is still active');
    }
  }

  async function stop(updateStatus = true) {
    active = false;
    if (frameTimer) window.clearInterval(frameTimer);
    if (audioTimer) window.clearInterval(audioTimer);
    if (frameTimeout) window.clearTimeout(frameTimeout);
    frameTimer = null;
    audioTimer = null;
    frameTimeout = null;
    frameInFlight = null;
    framePreparing = false;
    frameTimes = [];
    try { audioNode?.disconnect(); } catch (_error) { /* already disconnected */ }
    try { audioSource?.disconnect(); } catch (_error) { /* already disconnected */ }
    try { silentGain?.disconnect(); } catch (_error) { /* already disconnected */ }
    audioNode = null;
    audioSource = null;
    silentGain = null;
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close(); } catch (_error) { /* context already closed */ }
    }
    audioContext = null;
    ring = null;
    ringCount = 0;
    ringWrite = 0;
    toggleButton.textContent = 'Start analysis';
    if (updateStatus) setStatus('Analysis stopped');
    try {
      window.dispatchEvent(new CustomEvent('kyc-analysis-stopped'));
    } catch (_error) {
      // Resetting the display must not interfere with call cleanup.
    }
  }

  function resolveFrame(update) {
    if (!frameInFlight || update.clientTs !== frameInFlight.ts) return false;
    if (frameTimeout) window.clearTimeout(frameTimeout);
    frameTimeout = null;
    frameInFlight = null;
    return true;
  }

  function isFrameTimestamp(ts) {
    return frameTimes.includes(ts);
  }

  toggleButton.addEventListener('click', () => {
    if (active) stop().catch(() => {});
    else start().catch(() => {});
  });

  window.kycDetection = { stop, resolveFrame, isFrameTimestamp, setStatus };
})();
