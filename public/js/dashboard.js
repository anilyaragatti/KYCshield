const tableBody = document.querySelector('#sessions-table-body');
const dashboardMessage = document.querySelector('#dashboard-message');
const labelFilter = document.querySelector('#filter-label');
const decisionFilter = document.querySelector('#filter-decision');
const previousButton = document.querySelector('#previous-page-btn');
const nextButton = document.querySelector('#next-page-btn');
const pageIndicator = document.querySelector('#page-indicator');

let currentPage = 1;
let totalPages = 1;
let loading = false;

function formatDate(value) {
  try {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  } catch (_error) {
    return '—';
  }
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function makeCell(content) {
  const cell = document.createElement('td');
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content == null ? '—' : String(content);
  return cell;
}

function makeChip(text, className) {
  const chip = document.createElement('span');
  chip.className = `table-chip ${className}`;
  chip.textContent = text;
  return chip;
}

function makeSessionRow(session) {
  const row = document.createElement('tr');
  const shortId = document.createElement('strong');
  shortId.className = 'table-session-id';
  shortId.textContent = session.roomId ? session.roomId.slice(0, 8) : '—';
  const sessionCell = document.createElement('td');
  sessionCell.append(shortId);
  if (session.mockUsed) {
    const mock = document.createElement('span');
    mock.className = 'mock-tag';
    mock.textContent = 'MOCK';
    sessionCell.append(mock);
  }
  row.append(
    sessionCell,
    makeCell(formatDate(session.startedAt)),
    makeCell(formatDuration(session.durationSec))
  );

  const peakRisk = Number.isFinite(session.peakRisk) ? `${Math.round(session.peakRisk)} · ${session.finalLabel || 'Waiting'}` : '—';
  const riskTone = String(session.finalLabel || '').toLowerCase();
  row.append(makeCell(makeChip(peakRisk, `risk-${['low', 'medium', 'high'].includes(riskTone) ? riskTone : 'unknown'}`)));
  row.append(makeCell(session.virtualCamera ? 'Yes' : 'No'));

  const livenessNames = { pass: 'Pass', fail: 'Fail', timeout: 'Timeout', none: 'None' };
  const liveness = session.lastLiveness || 'none';
  row.append(makeCell(makeChip(livenessNames[liveness] || 'None', `liveness-${liveness}`)));
  const decision = session.decision || 'pending';
  row.append(makeCell(makeChip(decision, `decision-${decision}`)));

  const feedbackNames = { fraud: 'Fraud', false_alarm: 'False alarm' };
  const feedback = session.feedbackVerdict;
  row.append(makeCell(feedback ? makeChip(feedbackNames[feedback] || feedback, `feedback-${feedback}`) : '—'));

  const link = document.createElement('a');
  link.className = 'table-view-link';
  link.href = `/dashboard/sessions/${encodeURIComponent(session.roomId)}`;
  link.textContent = 'View';
  row.append(makeCell(link));
  return row;
}

async function loadStats() {
  try {
    const response = await fetch('/api/dashboard/stats', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Statistics are unavailable.');
    const stats = await response.json();
    document.querySelector('#stat-total').textContent = String(stats.total ?? 0);
    document.querySelector('#stat-high-risk').textContent = String(stats.highRisk ?? 0);
    document.querySelector('#stat-rejected').textContent = String(stats.rejected ?? 0);
    document.querySelector('#stat-average-risk').textContent = stats.avgPeakRisk == null ? '—' : `${Math.round(stats.avgPeakRisk)}`;
  } catch (_error) {
    dashboardMessage.textContent = 'Could not load dashboard statistics. Refresh to try again.';
  }
}

async function loadSessions() {
  if (loading) return;
  loading = true;
  try {
    const params = new URLSearchParams({
      page: String(currentPage),
      limit: '10',
      label: labelFilter.value,
      decision: decisionFilter.value
    });
    const response = await fetch(`/api/dashboard/sessions?${params}`, { headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.detail || 'Sessions are unavailable.');
    totalPages = Math.max(1, result.pages || 1);
    if (currentPage > totalPages) currentPage = totalPages;
    const rows = Array.isArray(result.sessions) ? result.sessions.map(makeSessionRow) : [];
    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 9;
      emptyCell.className = 'empty-table';
      emptyCell.textContent = 'No sessions match these filters.';
      emptyRow.append(emptyCell);
      rows.push(emptyRow);
    }
    tableBody.replaceChildren(...rows);
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages} · ${result.total || 0} sessions`;
    previousButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage >= totalPages;
    dashboardMessage.textContent = '';
  } catch (error) {
    dashboardMessage.textContent = error.message || 'Could not load sessions.';
  } finally {
    loading = false;
  }
}

function refreshDashboard() {
  loadStats().catch(() => {});
  loadSessions().catch(() => {});
}

labelFilter.addEventListener('change', () => { currentPage = 1; loadSessions().catch(() => {}); });
decisionFilter.addEventListener('change', () => { currentPage = 1; loadSessions().catch(() => {}); });
previousButton.addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; loadSessions().catch(() => {}); } });
nextButton.addEventListener('click', () => { if (currentPage < totalPages) { currentPage += 1; loadSessions().catch(() => {}); } });

refreshDashboard();
window.setInterval(refreshDashboard, 10000);
