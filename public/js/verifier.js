const form = document.querySelector('#invite-form');
const contactInput = document.querySelector('#contact-input');
const sendButton = document.querySelector('#send-btn');
const formMessage = document.querySelector('#form-message');
const resultPanel = document.querySelector('#invite-result');
const inviteLink = document.querySelector('#invite-link');
const copyButton = document.querySelector('#copy-btn');
const whatsappLink = document.querySelector('#whatsapp-link');
const openRoomButton = document.querySelector('#open-room-btn');
const sessionsList = document.querySelector('#sessions-list');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'message';
  resultPanel.hidden = true;
  sendButton.disabled = true;
  sendButton.textContent = 'Sending…';
  try {
    const response = await fetch('/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ contact: contactInput.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create invite.');
    inviteLink.href = data.link;
    inviteLink.textContent = data.link;
    openRoomButton.href = `/room/${encodeURIComponent(data.roomId)}`;
    whatsappLink.hidden = !data.whatsappUrl;
    if (data.whatsappUrl) whatsappLink.href = data.whatsappUrl;
    resultPanel.hidden = false;
    formMessage.textContent = data.emailSent === false ? data.error : (data.emailSent ? 'Invite link created and email sent.' : 'Invite link created.');
    formMessage.classList.add(data.emailSent === false ? 'error' : 'success');
    loadSessions();
  } catch (error) {
    formMessage.textContent = error.message || 'Network error. Please try again.';
    formMessage.classList.add('error');
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'Send invite';
  }
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.href);
    copyButton.textContent = 'Copied';
    window.setTimeout(() => { copyButton.textContent = 'Copy'; }, 1600);
  } catch (_error) {
    formMessage.textContent = 'Copy failed. Select and copy the invite link manually.';
    formMessage.className = 'message error';
  }
});

async function loadSessions() {
  try {
    const response = await fetch('/api/sessions', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load sessions.');
    const sessions = await response.json();
    sessionsList.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No verification sessions yet.';
      sessionsList.append(empty);
      return;
    }
    sessions.forEach((session) => {
      const item = document.createElement('div');
      item.className = 'session-item';
      const meta = document.createElement('div');
      const room = document.createElement('div');
      room.className = 'session-room';
      room.textContent = `Room ${session.roomId}`;
      const time = document.createElement('div');
      time.className = 'session-time';
      time.textContent = new Date(session.createdAt).toLocaleString();
      meta.append(room, time);
      const decision = document.createElement('span');
      decision.className = `decision ${session.decision}`;
      decision.textContent = session.decision;
      item.append(meta, decision);
      sessionsList.append(item);
    });
  } catch (_error) {
    sessionsList.replaceChildren();
    const error = document.createElement('p');
    error.className = 'empty-state';
    error.textContent = 'Recent sessions are unavailable.';
    sessionsList.append(error);
  }
}

loadSessions();
