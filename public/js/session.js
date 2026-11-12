const sessionPage = document.querySelector('#session-page');
const roomId = sessionPage.dataset.roomId;
const sessionMessage = document.querySelector('#session-message');
const feedbackMessage = document.querySelector('#feedback-message');
const feedbackNote = document.querySelector('#feedback-note');
const feedbackFraudButton = document.querySelector('#feedback-fraud-btn');
const feedbackFalseButton = document.querySelector('#feedback-false-btn');
const chartSvg = document.querySelector('#session-timeline');
const chartArea = document.querySelector('#timeline-area');
const chartLine = document.querySelector('#timeline-line');
const chartPoints = document.querySelector('#timeline-points');

function formatDate(value) {
  try {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString();
  } catch (_error) {
    return 'Not recorded';
  }
}

function challengeName(type) {
  const names = {
    turn_left: 'Turn head left',
    turn_right: 'Turn head right',
    blink_twice: 'Blink twice',
    show_palm: 'Show open palm',
    read_digits: 'Read digits aloud'
  };
  return names[type] || 'Liveness challenge';
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  element.textContent = value == null ? '—' : String(value);
}

function svgElement(tag, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function renderTimeline(points) {
  const validPoints = (Array.isArray(points) ? points : []).filter((point) => Number.isFinite(point.risk));
  chartLine.setAttribute('d', '');
  chartArea.setAttribute('d', '');
  chartPoints.replaceChildren();
  document.querySelector('#timeline-empty').hidden = validPoints.length > 0;
  chartSvg.classList.toggle('timeline-has-data', validPoints.length > 0);
  if (!validPoints.length) return;

  const left = 52;
  const right = 784;
  const top = 24;
  const bottom = 256;
  const coords = validPoints.map((point, index) => ({
    x: validPoints.length === 1 ? (left + right) / 2 : left + (index / (validPoints.length - 1)) * (right - left),
    y: bottom - (Math.max(0, Math.min(100, point.risk)) / 100) * (bottom - top)
  }));
  const linePath = coords.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  chartLine.setAttribute('d', linePath);
  chartArea.setAttribute('d', `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${bottom} L ${coords[0].x.toFixed(2)} ${bottom} Z`);
  const stride = Math.max(1, Math.ceil(coords.length / 40));
  coords.forEach((point, index) => {
    if (index % stride !== 0 && index !== coords.length - 1) return;
    chartPoints.append(svgElement('circle', { cx: point.x, cy: point.y, r: 2.4, class: 'timeline-point' }));
  });
}

function renderReasons(reasons) {
  const list = document.querySelector('#session-reasons');
  const rows = (Array.isArray(reasons) ? reasons : []).map((reason) => {
    const item = document.createElement('li');
    item.className = 'counted-reason';
    const text = document.createElement('span');
    text.textContent = reason.text;
    const count = document.createElement('strong');
    count.textContent = String(reason.count);
    item.append(text, count);
    return item;
  });
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No reason signals recorded.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
}

function renderChallenges(challenges) {
  const list = document.querySelector('#session-challenges');
  const rows = (Array.isArray(challenges) ? challenges : []).map((challenge) => {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = challengeName(challenge.type);
    const result = document.createElement('span');
    result.className = `challenge-result ${challenge.result}`;
    result.textContent = challenge.result;
    const time = document.createElement('time');
    time.textContent = formatDate(challenge.at);
    item.append(title, result, time);
    return item;
  });
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No challenges recorded.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
}

function showFeedback(feedback) {
  const existing = document.querySelector('#existing-feedback');
  if (!feedback) {
    existing.hidden = true;
    return;
  }
  existing.hidden = false;
  existing.replaceChildren();
  const verdict = document.createElement('strong');
  verdict.textContent = feedback.verdict === 'false_alarm' ? 'False alarm' : 'Fraud';
  const savedAt = document.createElement('span');
  savedAt.textContent = `Saved ${formatDate(feedback.updatedAt || feedback.createdAt)}`;
  const note = document.createElement('p');
  note.textContent = feedback.note || 'No note provided.';
  existing.append(verdict, savedAt, note);
  if (typeof feedback.note === 'string') feedbackNote.value = feedback.note;
}

function renderSession(data) {
  const summary = data.summary || {};
  setText('#detail-peak-risk', summary.peakRisk == null ? '—' : `${Math.round(summary.peakRisk)} / 100`);
  setText('#detail-average-risk', summary.avgRisk == null ? '—' : `${Math.round(summary.avgRisk)} / 100`);
  setText('#detail-final-label', summary.finalLabel || 'Waiting for data');
  setText('#detail-duration', `${summary.durationSec || 0}s`);
  setText('#detail-score-count', summary.scoreCount || 0);
  setText('#detail-decision', data.session?.decision || 'pending');
  renderTimeline(data.timeline);
  renderReasons(data.reasonCounts);
  renderChallenges(data.challenges);

  const virtualCamera = data.session?.virtualCamera;
  const cameraText = virtualCamera?.flagged
    ? `Detected${virtualCamera.label ? `: ${virtualCamera.label}` : ''}`
    : 'Not detected';
  setText('#session-camera-result', cameraText);
  setText('#session-camera-time', virtualCamera?.at ? `Checked ${formatDate(virtualCamera.at)}` : '');
  showFeedback(data.feedback);
  sessionMessage.textContent = summary.mockUsed ? 'This session includes simulated MOCK scores.' : '';
  sessionMessage.classList.toggle('mock-session-message', Boolean(summary.mockUsed));
}

async function loadSession() {
  try {
    const response = await fetch(`/api/dashboard/sessions/${encodeURIComponent(roomId)}`, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.detail || 'Session could not be loaded.');
    renderSession(data);
  } catch (error) {
    sessionMessage.textContent = error.message || 'Session could not be loaded.';
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
    showFeedback(result.feedback);
    feedbackMessage.textContent = 'Feedback saved. It is stored for future model retraining.';
  } catch (error) {
    feedbackMessage.textContent = error.message || 'Feedback could not be saved. Try again.';
  } finally {
    feedbackFraudButton.disabled = false;
    feedbackFalseButton.disabled = false;
  }
}

feedbackFraudButton.addEventListener('click', () => saveFeedback('fraud'));
feedbackFalseButton.addEventListener('click', () => saveFeedback('false_alarm'));
loadSession();
