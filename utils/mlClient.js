const ML_SERVICE_URL = (process.env.ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 2500;

async function postMedia(path, buffer, filename, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Media payload must be a Buffer.');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (typeof timeoutId.unref === 'function') timeoutId.unref();

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), filename);
    const response = await fetch(`${ML_SERVICE_URL}${path}`, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`Detector service returned HTTP ${response.status}.`);
      error.code = 'service_unavailable';
      throw error;
    }

    const result = await response.json();
    if (
      !result ||
      !(result.score === null || (Number.isFinite(result.score) && result.score >= 0 && result.score <= 1)) ||
      !['mock', 'hf'].includes(result.backend)
    ) {
      const error = new Error('Detector service returned an invalid response.');
      error.code = 'invalid_response';
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Detector request timed out.');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    if (!error.code) error.code = 'service_unavailable';
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function callFrame(buffer) {
  return postMedia('/frame', buffer, 'frame.jpg', 'image/jpeg');
}

function callAudio(buffer) {
  return postMedia('/audio', buffer, 'audio.wav', 'audio/wav');
}

module.exports = { callFrame, callAudio };
