// Preload for the Gmail views (not the sidebar). Runs in an isolated world next to Gmail's page:
// it can read the DOM and make same-origin requests with Gmail's cookies, but shares no JS with the page.
const { ipcRenderer } = require('electron');

// Settings arrive as process arguments because a sandboxed preload cannot read files.
// They are fixed when the view is created, so main rebuilds the views when one changes.
const flag = (name) => process.argv.includes(`--maildock-${name}`);
const TWEAKS = {
  senderIcons: flag('sender-icons'),
  attachmentsOnTop: flag('attachments-on-top'),
  composeInNewWindow: flag('compose-in-new-window'),
};

const GMAIL_BASE = 'https://mail.google.com/mail/u/0';

// ---------------------------------------------------------------- unread count
// Gmail's class names are obfuscated and can change; .bsU is the count beside the Inbox link.
const INBOX_LINK = 'span > a[href*="#inbox"]';
let lastUnread = '';

function reportUnread() {
  const text = document.querySelector(`div:has(> ${INBOX_LINK}) .bsU`)?.textContent || '';
  if (text === lastUnread) return;
  lastUnread = text;
  ipcRenderer.send('gmail:unread', parseInt(text.replace(/\D/g, ''), 10) || 0);
}

// ---------------------------------------------------------------- tweaks
function addSenderIcons() {
  if (!TWEAKS.senderIcons) return;
  for (const row of document.querySelectorAll("tr[id]:has(span[email*='@'])")) {
    if (row.querySelector('.maildock-sender-icons')) continue;
    const cell = row.querySelector("td:has(span[email*='@'])");
    if (!cell) continue;
    const domains = new Set();
    for (const span of cell.querySelectorAll("span[email*='@']")) {
      const domain = (span.getAttribute('email') || '').split('@')[1];
      if (domain) domains.add(domain.toLowerCase());
    }
    if (domains.size === 0) continue;
    const box = document.createElement('div');
    box.className = 'maildock-sender-icons';
    box.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;min-width:24px;margin-right:8px';
    let first = true;
    for (const domain of domains) {
      const img = document.createElement('img');
      img.src = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(domain)}`;
      img.title = domain;
      img.style.cssText = `width:16px;height:16px;border-radius:50%;background:#fff;${first ? '' : 'margin-left:-8px'}`;
      first = false;
      box.appendChild(img);
    }
    cell.appendChild(box);
  }
}

function moveAttachmentsToTop() {
  if (!TWEAKS.attachmentsOnTop) return;
  for (const message of document.querySelectorAll('div:has(> .hq.gt)')) {
    const attachments = message.querySelector(':scope > .hq.gt');
    if (!attachments || message.firstChild === attachments) continue;
    const line = document.createElement('div');
    line.className = 'hp'; // Gmail's own divider style
    line.style.marginTop = '16px';
    attachments.appendChild(line);
    message.prepend(attachments);
  }
}

// Gmail opens Compose in a pop-out window on Shift+click, so replay the click with Shift held.
function composeInNewWindow() {
  if (!TWEAKS.composeInNewWindow) return;
  const button = document.querySelector('.T-I.T-I-KE.L3:not([data-maildock-compose])');
  if (!button) return;
  button.setAttribute('data-maildock-compose', '');
  let replaying = false;
  button.addEventListener('click', (event) => {
    if (replaying) {
      replaying = false;
      return;
    }
    replaying = true;
    event.stopPropagation();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, shiftKey: true }));
  });
}

// ---------------------------------------------------------------- mail actions
// There is no public endpoint for these, so replay the request Gmail's own page sends.
// Codes are Gmail's: 9 moves the conversation to Trash (same as the Delete button in Gmail).
const ACTION_CODES = { archive: 1, markRead: 3, spam: 7, delete: 9 };
let idKey = null;

async function getIdKey() {
  if (idKey) return idKey;
  const pattern = /GM_ID_KEY\s*=\s*['"]([a-z0-9]+)['"]/i;
  for (const script of document.scripts) {
    const found = script.textContent.match(pattern);
    if (found) return (idKey = found[1]);
  }
  const html = await (await fetch(GMAIL_BASE, { credentials: 'include' })).text();
  const found = html.match(pattern);
  if (!found) throw new Error('Gmail did not provide its page key. Is this account signed in?');
  return (idKey = found[1]);
}

function getActionToken() {
  const entry = document.cookie.split('; ').find((c) => c.startsWith('GMAIL_AT='));
  if (!entry) throw new Error('Gmail did not provide an action token. Is this account signed in?');
  return entry.slice('GMAIL_AT='.length);
}

async function mailAction(messageId, action) {
  const code = ACTION_CODES[action];
  if (!code || !/^[A-Za-z0-9]{10,}$/.test(messageId)) throw new Error('Unknown mail action.');
  const ik = await getIdKey();
  const query = new URLSearchParams({ v: 'or', ik, at: getActionToken(), subui: 'chrome', hl: 'en', ts: String(Date.now()) });
  const flags = [null, null, null, null, null, null, [null, true, false]];
  const body = new FormData();
  body.append('s_jr', JSON.stringify([null, [[null, null, null, [null, code, messageId, messageId, 'l:all', [], [], []]], flags, flags], 2, null, null, null, ik]));
  const res = await fetch(`${GMAIL_BASE}/s/?${query}`, { method: 'POST', credentials: 'include', body });
  if (!res.ok) throw new Error(`Gmail refused the request (${res.status}).`);
  await res.text();
}

ipcRenderer.on('gmail:action', async (_e, { requestId, messageId, action }) => {
  try {
    await mailAction(messageId, action);
    ipcRenderer.send('gmail:action-done', { requestId, ok: true });
  } catch (err) {
    ipcRenderer.send('gmail:action-done', { requestId, ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------- startup
function runFeatures() {
  for (const feature of [reportUnread, addSenderIcons, moveAttachmentsToTop, composeInNewWindow]) {
    try {
      feature();
    } catch (err) {
      console.error('MailDock feature failed:', err);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // Pop-out windows for Calendar, Drive and so on share this preload; only Gmail needs it.
  if (location.hostname !== 'mail.google.com') return;
  // Gmail mutates the page constantly, so run at most once per 250 ms.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      runFeatures();
    }, 250);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
});
