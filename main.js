const { app, BrowserWindow, WebContentsView, Menu, Tray, Notification, nativeImage, ipcMain, shell, net, dialog, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const SIDEBAR_WIDTH = 68;
// Every account is "user 0" of its own session, so the same URLs work for all of them.
const GMAIL_URL = 'https://mail.google.com/mail/u/0/';
const SIGNIN_URL = `https://accounts.google.com/ServiceLogin?service=mail&continue=${encodeURIComponent(GMAIL_URL)}`;
const FEED_URL = 'https://mail.google.com/mail/u/0/feed/atom';
// The same feed limited to Gmail's Important label (system label ID "^iim"). Only read when the
// "Only Important Emails" choice is on and new mail has arrived.
const IMPORTANT_FEED_URL = `${FEED_URL}/%5Eiim`;
const NOTIFY_MODES = ['all', 'important'];
const FEED_POLL_MS = 30 * 1000;
const FEED_POLL_MAX_MS = 5 * 60 * 1000;
const MESSAGE_ID = /^[A-Za-z0-9]{10,}$/;

// ---------------------------------------------------------------- sign-in
// The Gmail views run as plain Electron: nothing in this app changes the user agent, the request
// headers or anything else a page can see. Google's sign-in accepted exactly that, and refused
// every attempt to present the app as a different browser, so those options were removed.
// Keep it this way.
//
// Diagnostic for a refused sign-in: MAILDOCK_BARE=1 also drops the preload, blocker, permission
// handlers and feed polling. A sign-in made this way is kept for the next normal start.
const BARE = process.env.MAILDOCK_BARE === '1';

// This project was first called "Mailbox Web". Keep using that data folder so Gmail sign-ins carry over the rename.
app.setPath('userData', process.env.MAILDOCK_DATA_DIR || path.join(app.getPath('appData'), 'Mailbox Web'));
const APP_ID = 'com.example.maildock.web';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// ---------------------------------------------------------------- Windows app identity
// Windows takes an app's notification name and taskbar icon from the Start Menu shortcut that
// carries its app ID. An installed build gets one from the installer. Started with `npm start`,
// Electron makes its own, "Electron.lnk" with Electron's icon, so everything is labelled Electron.
// Replace that one with a "MailDock Web" shortcut, keeping the activator ID that makes the
// notification buttons work.
function registerWindowsIdentity() {
  if (process.platform !== 'win32' || app.isPackaged) return;
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const ours = path.join(programs, 'MailDock Web.lnk');
  const generic = path.join(programs, 'Electron.lnk');
  const read = (file) => {
    try {
      return shell.readShortcutLink(file);
    } catch {
      return null;
    }
  };
  try {
    // Only touch Electron.lnk if it belongs to this app; other Electron projects make their own.
    const theirs = read(generic)?.appUserModelId === APP_ID ? read(generic) : null;
    const toastActivatorClsid = theirs?.toastActivatorClsid || read(ours)?.toastActivatorClsid;
    if (!theirs && read(ours)) return;
    shell.writeShortcutLink(ours, fs.existsSync(ours) ? 'replace' : 'create', {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      cwd: app.getAppPath(),
      description: 'MailDock Web',
      icon: path.join(__dirname, 'icon.ico'),
      iconIndex: 0,
      appUserModelId: APP_ID,
      ...(toastActivatorClsid ? { toastActivatorClsid } : {}),
    });
    if (theirs) fs.unlinkSync(generic);
  } catch (err) {
    console.warn('Could not set the Windows app name and icon:', err.message);
  }
}

// ---------------------------------------------------------------- state
let win;
let tray;
let quitting = false;
let pendingMailto = null;
let accounts = []; // [{ id, name, named }]
const views = new Map(); // id -> WebContentsView
const unread = new Map(); // id -> number
const cssKeys = new Map(); // id -> key from insertCSS
const signedIn = new Set(); // ids whose view has reached Gmail itself (not a sign-in page) in this run
const domUnread = new Set(); // ids whose count comes from the Gmail page itself rather than its title
const feeds = new Map(); // id -> { entries, seen, failures, timer }
const pendingActions = new Map(); // requestId -> { resolve, timer, wc }
const liveNotifications = new Set(); // keeps notifications referenced so their click handlers survive
let activeId = null;
let inboxOpen = false; // the unified inbox is showing instead of a Gmail view
let settingsOpen = false; // the settings page is showing instead of a Gmail view

// ---------------------------------------------------------------- single instance + mailto
if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', (_e, argv) => {
  showWindow();
  const mailto = argv.find((a) => a.startsWith('mailto:'));
  if (mailto) openMailto(mailto);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('mailto:')) openMailto(url);
});

function openMailto(url) {
  const view = views.get(activeId);
  if (!win || !view) {
    pendingMailto = url;
    return;
  }
  showWindow();
  view.webContents.loadURL(`https://mail.google.com/mail/?extsrc=mailto&url=${encodeURIComponent(url)}`);
}

// ---------------------------------------------------------------- storage
const storePath = () => path.join(app.getPath('userData'), 'web-accounts.json');
const cssPath = () => path.join(app.getPath('userData'), 'custom.css');

function loadAccounts() {
  let stored = [];
  try {
    stored = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    /* first run */
  }
  accounts = (Array.isArray(stored) ? stored : []).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string');
  if (accounts.length === 0) accounts.push({ id: crypto.randomUUID(), name: 'Account 1', named: false });
}

function saveAccounts() {
  fs.writeFileSync(storePath(), JSON.stringify(accounts, null, 2));
}

// ---------------------------------------------------------------- icons
// icon.png is the MailDock mark; the generated envelope below is only a fallback if that file is missing.
function appIcon(size) {
  const image = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (image.isEmpty()) return makeIcon(size);
  return image.resize({ width: size, height: size, quality: 'best' });
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inCircle = (x - c + 0.5) ** 2 + (y - c + 0.5) ** 2 <= (c - 0.5) ** 2;
      const inEnvelope = x > size * 0.26 && x < size * 0.74 && y > size * 0.34 && y < size * 0.66;
      if (!inCircle) continue;
      const [b, g, r] = inEnvelope ? [255, 255, 255] : [0x35, 0x43, 0xea]; // BGRA
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ---------------------------------------------------------------- custom CSS (applied to Gmail)
function ensureCssFile() {
  if (!fs.existsSync(cssPath())) {
    fs.writeFileSync(
      cssPath(),
      '/* Custom CSS applied to Gmail in every account. Save this file and it reloads automatically.\n   Example: hide the Meet section in the left rail\n   .aeN .aIH { display: none !important; } */\n'
    );
  }
}

async function applyCss(id) {
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return;
  try {
    const oldKey = cssKeys.get(id);
    if (oldKey) await view.webContents.removeInsertedCSS(oldKey);
    cssKeys.set(id, await view.webContents.insertCSS(fs.readFileSync(cssPath(), 'utf8')));
  } catch {
    /* page not ready or file unreadable */
  }
}

function applyCssAll() {
  for (const id of views.keys()) applyCss(id);
}

// ---------------------------------------------------------------- Gmail views
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// A signed-out Gmail sometimes redirects to Google's product page, whose "Sign in" link opens a new window.
function isGmailPromoPage(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (hostname === 'workspace.google.com' && /\/gmail(\/|$)/.test(pathname)) || (hostname === 'www.google.com' && pathname.includes('/gmail/about'));
  } catch {
    return false;
  }
}

function isGoogleHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'google.com' || host.endsWith('.google.com') || host === 'gstatic.com' || host.endsWith('.gstatic.com');
  } catch {
    return false;
  }
}

// Links and window.open: other Google apps (Calendar, Drive, Meet…) open as in-app windows that
// share the opener's session, so they are already signed in to the same account. Everything else
// goes to the default browser.
function handleWindowOpen(wc, { url }) {
  if (url.startsWith('mailto:')) {
    openMailto(url);
    return { action: 'deny' };
  }
  // Sign-in belongs in the account's own view, not a pop-up: that is where Gmail loads afterwards,
  // and a pop-up left open on a sign-in page would be easy to lose behind the main window.
  if (hostOf(url) === 'accounts.google.com') {
    wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  }
  if (isGoogleHost(url) || url === 'about:blank') {
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: process.platform === 'darwin' ? undefined : appIcon(256) } };
  }
  if (/^https?:/i.test(url)) shell.openExternal(url);
  return { action: 'deny' };
}

function guardContents(wc) {
  wc.setWindowOpenHandler((details) => handleWindowOpen(wc, details));
  wc.on('did-create-window', (child) => guardContents(child.webContents));
  wc.on('will-navigate', (event, url) => {
    if (!isGoogleHost(url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

const GOOGLE_APPS = [
  ['Calendar', 'https://calendar.google.com/'],
  ['Drive', 'https://drive.google.com/'],
  ['Meet', 'https://meet.google.com/'],
  ['Contacts', 'https://contacts.google.com/'],
  ['Keep', 'https://keep.google.com/'],
  ['Docs', 'https://docs.google.com/'],
];

function openGoogleApp(url) {
  const view = views.get(activeId);
  if (!view) return;
  const child = new BrowserWindow({
    width: 1100,
    height: 780,
    autoHideMenuBar: true,
    icon: process.platform === 'darwin' ? undefined : appIcon(256),
    webPreferences: { session: view.webContents.session, contextIsolation: true, sandbox: true },
  });
  guardContents(child.webContents);
  child.webContents.loadURL(url).catch(() => {});
}

function tweakArguments() {
  const args = [];
  if (settings.composeInNewWindow) args.push('--maildock-compose-in-new-window');
  return args;
}

function createBareView(account) {
  const view = new WebContentsView({ webPreferences: { partition: `persist:acct-${account.id}` } });
  guardContents(view.webContents); // main-process only: keeps sign-in out of pop-ups, invisible to the page
  views.set(account.id, view);
  view.webContents.loadURL(GMAIL_URL).catch(() => {});
  return view;
}

function createView(account) {
  if (BARE) return createBareView(account);
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:acct-${account.id}`, // separate cookies per account
      preload: path.join(__dirname, 'gmail-preload.js'),
      additionalArguments: tweakArguments(),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const wc = view.webContents;
  const ses = wc.session;

  // Until an account is signed in, its view must behave like plain Electron: Google refused sign-in
  // ("This browser or app may not be secure") while more of this app's changes were active. So the
  // blocker and feed polling wait for signedIn.
  // The setting is read per request, so turning the blocker on or off needs no reload.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: settings.blocker && signedIn.has(account.id) && isBlocked(details.url) });
  });
  // Gmail's own desktop notifications are always refused: MailDock Web raises its own, so Settings >
  // Notifications > New Emails is the one switch, and off means no new-mail notifications at all.
  // A check that names no page is refused too, since it may well be Gmail's. Other Google apps
  // sharing this session (Calendar reminders, for example) keep their notifications.
  const allowed = (permission, origin) => !(permission === 'notifications' && (!origin || hostOf(origin) === 'mail.google.com'));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(permission, details?.requestingUrl || contents?.getURL() || '')));
  ses.setPermissionCheckHandler((contents, permission, origin) => allowed(permission, origin || contents?.getURL() || ''));
  guardContents(wc);
  watchAltKey(wc); // main-process only: the page cannot see it
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params)); // also main-process only
  let retries = 0;
  wc.on('did-navigate', (_e, url, httpResponseCode) => {
    if (isGmailPromoPage(url)) wc.loadURL(SIGNIN_URL).catch(() => {});
    if (hostOf(url) === 'accounts.google.com') signedIn.delete(account.id);
    // Only a page that really arrived counts. A failed load still reports Gmail's address,
    // so going by the address alone would mark a blank error page as signed in.
    if (httpResponseCode !== 200) return;
    retries = 0;
    if (url.startsWith('https://mail.google.com/mail/')) {
      if (!signedIn.has(account.id)) log(`Account ${accounts.indexOf(account) + 1} of ${accounts.length} reached Gmail (signed in).`);
      signedIn.add(account.id);
    }
  });
  // The very first request after launch is sometimes refused (ERR_NETWORK_ACCESS_DENIED) and would
  // leave the view blank, so try again a few times before giving up.
  wc.on('did-fail-load', (_e, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || retries >= 5 || !/^https:/i.test(url)) return; // -3: navigation replaced by another
    retries += 1;
    log(`Page failed to load at ${hostOf(url)} (${code} ${_description}), retry ${retries} of 5`);
    setTimeout(() => {
      if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {});
    }, 1500 * retries);
  });

  // Gmail's title looks like "Inbox (3) - you@gmail.com - Gmail". The count normally comes from the
  // page itself (gmail:unread); the title is only the fallback until the page has reported one.
  wc.on('page-title-updated', (_e, title) => {
    const count = title.match(/\((\d+)\)/);
    if (!domUnread.has(account.id)) unread.set(account.id, count ? parseInt(count[1], 10) : 0);
    const email = title.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (email && !account.named && account.name !== email[0]) {
      account.name = email[0];
      saveAccounts();
    }
    pushState();
  });
  wc.on('dom-ready', () => {
    applyCss(account.id);
    // Right after sign-in or a reload, don't wait for the next regular poll.
    if (signedIn.has(account.id)) schedulePoll(account.id, 2000);
  });

  views.set(account.id, view);
  startFeed(account.id);
  wc.loadURL(GMAIL_URL).catch(() => {});
  return view;
}

function layoutActive() {
  const view = views.get(activeId);
  if (!view || !win) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
}

function detachActive() {
  const view = views.get(activeId);
  if (view && win && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
}

function attachActive() {
  const view = views.get(activeId);
  if (!view || !win) return;
  win.contentView.addChildView(view);
  layoutActive();
  view.webContents.focus();
}

// Tweaks reach the Gmail preload as process arguments, which are fixed when a view is created.
function rebuildViews() {
  detachActive();
  for (const view of views.values()) view.webContents.close();
  views.clear();
  cssKeys.clear();
  domUnread.clear();
  signedIn.clear();
  for (const account of accounts) createView(account);
  if (!inboxOpen && !settingsOpen) attachActive();
}

function selectAccount(id) {
  if (!accounts.some((a) => a.id === id)) return;
  detachActive();
  activeId = id;
  inboxOpen = false;
  settingsOpen = false;
  if (!views.has(id)) createView(accounts.find((a) => a.id === id));
  attachActive();
  pushState();
  if (pendingMailto) {
    const url = pendingMailto;
    pendingMailto = null;
    openMailto(url);
  }
}

function cycleAccount(step) {
  const i = accounts.findIndex((a) => a.id === activeId);
  selectAccount(accounts[(i + step + accounts.length) % accounts.length].id);
}

function addAccount() {
  const account = { id: crypto.randomUUID(), name: `Account ${accounts.length + 1}`, named: false };
  accounts.push(account);
  saveAccounts();
  selectAccount(account.id);
}

// ---------------------------------------------------------------- blocker
// Ad and analytics hosts, plus a few open-tracking services. A request is blocked when its host
// is one of these or a subdomain of one.
const BLOCKED_HOSTS = new Set([
  'doubleclick.net',
  'doubleclick.com',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  '2mdn.net',
  'admob.com',
  'google-analytics.com',
  'googletagmanager.com',
  'mailtrack.io',
  'emltrk.com',
  'bananatag.com',
  'getnotify.com',
]);

function isBlocked(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  for (;;) {
    if (BLOCKED_HOSTS.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot < 0) return false;
    host = host.slice(dot + 1);
  }
}

// ---------------------------------------------------------------- new mail (Atom feed)
// Gmail's Atom feed lists the unread inbox messages. It is fetched through the account's own
// session, so it uses that account's cookies. Entries not seen before are new mail.
const xmlText = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

function xmlTag(xml, name) {
  const found = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return found ? xmlText(found[1].trim()) : '';
}

// Returns null when the response is not a feed (for example a sign-in page).
function parseFeed(xml) {
  if (!/<feed[\s>]/.test(xml)) return null;
  const entries = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const author = (entry.match(/<author>([\s\S]*?)<\/author>/) || [])[1] || '';
    const rest = entry.replace(/<(author|contributor)>[\s\S]*?<\/\1>/g, '');
    let messageId = '';
    try {
      messageId = new URL(xmlText((rest.match(/<link[^>]*\shref="([^"]*)"/) || [])[1] || '')).searchParams.get('message_id') || '';
    } catch {
      /* entry without a usable link */
    }
    const key = xmlTag(rest, 'id');
    if (!key || !MESSAGE_ID.test(messageId)) continue;
    entries.push({
      key,
      messageId,
      subject: xmlTag(rest, 'title') || '(no subject)',
      summary: xmlTag(rest, 'summary'),
      from: xmlTag(author, 'name') || xmlTag(author, 'email') || 'Unknown sender',
      receivedAt: Date.parse(xmlTag(rest, 'issued')) || Date.now(),
    });
  }
  return entries;
}

function startFeed(id) {
  if (feeds.has(id)) return;
  feeds.set(id, { entries: [], seen: null, failures: 0, timer: null });
  schedulePoll(id, 5000);
}

function stopFeed(id) {
  clearTimeout(feeds.get(id)?.timer);
  feeds.delete(id);
}

function schedulePoll(id, delay) {
  const feed = feeds.get(id);
  if (!feed) return;
  clearTimeout(feed.timer);
  feed.timer = setTimeout(async () => {
    await pollFeed(id);
    const current = feeds.get(id);
    // Back off while Gmail is unreachable, up to five minutes.
    if (current) schedulePoll(id, Math.min(FEED_POLL_MS * 2 ** current.failures, FEED_POLL_MAX_MS));
  }, delay);
}

async function pollFeed(id) {
  const feed = feeds.get(id);
  const view = views.get(id);
  // Never ask for the feed before sign-in: those requests can only fail, and they make the session look automated.
  if (!feed || !view || view.webContents.isDestroyed() || !signedIn.has(id) || !net.isOnline()) return;
  try {
    const res = await view.webContents.session.fetch(`${FEED_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    const entries = res.ok ? parseFeed(await res.text()) : null;
    if (feeds.get(id) !== feed) return; // account removed meanwhile
    if (!entries) return; // not signed in yet
    feed.failures = 0;
    // The first successful read is the baseline: what is already unread is not "new".
    const fresh = feed.seen ? entries.filter((e) => !feed.seen.has(e.key)) : [];
    feed.seen = feed.seen || new Set();
    for (const e of entries) feed.seen.add(e.key);
    feed.entries = entries;
    if (fresh.length && settings.notifications) notifyNewMail(id, await notifiable(id, view, fresh));
    pushState();
  } catch (err) {
    feed.failures += 1;
    log(`New-mail check failed (${feed.failures} in a row): ${err?.message || err}`);
  }
}

// With "Only Important Emails" chosen, keep the new messages that also appear in the Important
// feed. If that check fails, notify about all of them: a missed email is worse than an extra alert.
async function notifiable(id, view, fresh) {
  if (settings.notifyMode !== 'important') return fresh;
  try {
    const res = await view.webContents.session.fetch(`${IMPORTANT_FEED_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
    const important = res.ok ? parseFeed(await res.text()) : null;
    if (!important) throw new Error(res.ok ? 'Gmail did not return a feed' : `HTTP ${res.status}`);
    const ids = new Set(important.map((e) => e.messageId));
    return fresh.filter((e) => ids.has(e.messageId));
  } catch (err) {
    log(`Important-mail check failed, notifying about all ${fresh.length} new message(s): ${err?.message || err}`);
    return fresh;
  }
}

// ---------------------------------------------------------------- notifications + mail actions
const MAIL_ACTIONS = [
  { action: 'archive', label: 'Archive', failed: 'archive' },
  { action: 'markRead', label: 'Mark as Read', failed: 'mark as read' },
  { action: 'delete', label: 'Delete', failed: 'delete' },
  { action: 'spam', label: 'Spam', failed: 'mark as spam' },
];

function showNotification(options, onClick, onAction) {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ icon: appIcon(64), ...options });
    liveNotifications.add(n);
    const done = () => liveNotifications.delete(n);
    n.on('close', done);
    n.on('failed', done);
    n.on('click', () => {
      done();
      onClick?.();
    });
    n.on('action', (details, index) => {
      done();
      onAction?.(details?.actionIndex ?? index);
    });
    n.show();
  } catch {
    /* notifications are optional */
  }
}

function notifyNewMail(id, fresh) {
  if (!settings.notifications || !fresh.length) return;
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  const suffix = accounts.length > 1 ? ` · ${account.name}` : '';
  if (fresh.length > 3) {
    showNotification({ title: `${fresh.length} new messages${suffix}`, body: fresh.map((e) => e.from).join(', ').slice(0, 200) }, () => {
      showWindow();
      selectAccount(id);
    });
    return;
  }
  for (const entry of fresh) {
    showNotification(
      {
        title: `${entry.from}${suffix}`,
        body: [entry.subject, entry.summary].filter(Boolean).join('\n').slice(0, 300),
        actions: MAIL_ACTIONS.map((a) => ({ type: 'button', text: a.label })),
      },
      () => openMessage(id, entry.messageId),
      (index) => MAIL_ACTIONS[index] && mailAction(id, entry.messageId, MAIL_ACTIONS[index].action)
    );
  }
}

function openMessage(id, messageId) {
  if (!accounts.some((a) => a.id === id) || !MESSAGE_ID.test(messageId)) return;
  showWindow();
  selectAccount(id);
  views.get(id)?.webContents.loadURL(`${GMAIL_URL}#inbox/${messageId}`).catch(() => {});
}

// The request itself is made by the Gmail page's preload, which has the page key and cookies.
function sendMailAction(id, messageId, action) {
  const wc = views.get(id)?.webContents;
  return new Promise((resolve) => {
    if (!wc || wc.isDestroyed()) return resolve({ ok: false, error: 'That account is not open.' });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingActions.delete(requestId);
      resolve({ ok: false, error: 'Gmail did not answer in time.' });
    }, 15000);
    pendingActions.set(requestId, { resolve, timer, wc });
    wc.send('gmail:action', { requestId, messageId, action });
  });
}

async function mailAction(id, messageId, action) {
  const spec = MAIL_ACTIONS.find((a) => a.action === action);
  if (!spec || !MESSAGE_ID.test(messageId)) return;
  const result = await sendMailAction(id, messageId, action);
  log(`Mail action "${action}": ${result.ok ? 'done' : `failed: ${result.error}`}`);
  if (!result.ok) {
    showNotification({ title: `Could not ${spec.failed} the message`, body: `${result.error} Open the account in MailDock Web and do it in Gmail.` }, showWindow);
    return;
  }
  const feed = feeds.get(id);
  if (feed) feed.entries = feed.entries.filter((e) => e.messageId !== messageId);
  pushState();
  schedulePoll(id, 1500);
}

// ---------------------------------------------------------------- unified inbox
function toggleInbox(open = !inboxOpen) {
  if (!win || win.isDestroyed() || open === inboxOpen) return;
  inboxOpen = open;
  if (inboxOpen) {
    settingsOpen = false;
    detachActive();
    win.webContents.focus();
    for (const account of accounts) schedulePoll(account.id, 0);
  } else {
    attachActive();
  }
  pushState();
}

// ---------------------------------------------------------------- settings page
// Shown by the sidebar page in the space a Gmail view normally covers, like the unified inbox.
function toggleSettings(open = !settingsOpen) {
  if (!win || win.isDestroyed() || open === settingsOpen) return;
  settingsOpen = open;
  if (settingsOpen) {
    inboxOpen = false;
    detachActive();
    win.webContents.focus();
  } else {
    attachActive();
  }
  pushState();
}

// Run with `npm start`, the login item must name the app folder too, or Windows would start a bare Electron.
const LOGIN_ITEM = app.isPackaged ? {} : { path: process.execPath, args: [`"${app.getAppPath()}"`] };
let launchAtLogin = null; // read once: asking the OS on every state push would be wasteful
function getLaunchAtLogin() {
  if (launchAtLogin === null) launchAtLogin = app.getLoginItemSettings(LOGIN_ITEM).openAtLogin;
  return launchAtLogin;
}
function setLaunchAtLogin(on) {
  launchAtLogin = Boolean(on);
  app.setLoginItemSettings({ openAtLogin: launchAtLogin, ...LOGIN_ITEM });
  buildMenu();
  pushState();
}

function editCustomCss() {
  ensureCssFile();
  shell.openPath(cssPath());
}

function inboxEntries() {
  const all = [];
  for (const account of accounts) {
    for (const e of feeds.get(account.id)?.entries || []) {
      all.push({ accountId: account.id, account: account.name, messageId: e.messageId, from: e.from, subject: e.subject, summary: e.summary, receivedAt: e.receivedAt });
    }
  }
  return all.sort((a, b) => b.receivedAt - a.receivedAt);
}

// ---------------------------------------------------------------- right-click menu
// Electron shows no menu of its own when a page is right-clicked, so build one. Gmail's own
// menus (for example on a row of the inbox) cancel the event in the page, and then this one
// does not appear, so the two never compete.
const SEARCH_URL = 'https://www.google.com/search?q=';
const MAX_SEARCH_CHARS = 500;

function contextMenuTemplate(wc, params) {
  const selected = (params.selectionText || '').trim();
  if (params.isEditable) {
    // Typing areas (compose, reply, search box) get the usual editing commands.
    const can = params.editFlags || {};
    return [
      { label: 'Cut', enabled: Boolean(can.canCut), click: () => wc.cut() },
      { label: 'Copy', enabled: Boolean(can.canCopy), click: () => wc.copy() },
      { label: 'Paste', enabled: Boolean(can.canPaste), click: () => wc.paste() },
      { type: 'separator' },
      { label: 'Select All', click: () => wc.selectAll() },
    ];
  }
  if (selected) {
    return [
      {
        label: 'Search with Google',
        // Opens in the computer's default browser, not inside the app.
        click: () => shell.openExternal(SEARCH_URL + encodeURIComponent(selected.replace(/\s+/g, ' ').slice(0, MAX_SEARCH_CHARS))),
      },
      { type: 'separator' },
      { label: 'Copy', click: () => wc.copy() },
      { label: 'Select All', click: () => wc.selectAll() },
    ];
  }
  const link = /^(https?|mailto):/i.test(params.linkURL || '') ? params.linkURL : '';
  return [
    { label: 'Select All', click: () => wc.selectAll() },
    // Greyed out unless the click was on a link.
    { label: 'Copy Link Address', enabled: Boolean(link), click: () => clipboard.writeText(link) },
  ];
}

function showContextMenu(wc, params) {
  if (!win || win.isDestroyed() || wc.isDestroyed()) return;
  Menu.buildFromTemplate(contextMenuTemplate(wc, params)).popup({ window: win });
}

// ---------------------------------------------------------------- badges + state
const totalUnread = () => [...unread.values()].reduce((a, b) => a + b, 0);

// With "Show Unread Badges" off, the sidebar, taskbar and dock all get zero and so draw nothing.
const badgeCount = (count) => (settings.unreadBadges ? count : 0);

function snapshot() {
  return {
    activeId,
    inboxOpen,
    settingsOpen,
    settings: {
      launchAtLogin: getLaunchAtLogin(),
      minimizeToTray: settings.minimizeToTray,
      theme: settings.theme,
      trayIcon: settings.trayIcon,
      unreadBadges: settings.unreadBadges,
      notifications: settings.notifications,
      notifyMode: settings.notifyMode,
    },
    about: aboutInfo(),
    inbox: inboxEntries(),
    total: badgeCount(totalUnread()),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, unread: badgeCount(unread.get(a.id) || 0) })),
  };
}

function pushState() {
  const total = badgeCount(totalUnread());
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(total);
  if (process.platform === 'darwin') app.dock?.setBadge(total ? String(total) : '');
  tray?.setToolTip(total ? `MailDock Web: ${total} unread` : 'MailDock Web');
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
}

// ---------------------------------------------------------------- settings
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const settings = {
  minimizeToTray: true,
  trayHintShown: false,
  notifications: true,
  notifyMode: 'all', // all | important
  blocker: true,
  composeInNewWindow: false,
  deviceId: '', // random, made on first run (see ensureDeviceId)
  theme: 'system', // system | dark | light
  trayIcon: true,
  unreadBadges: true,
  menuBar: true, // shown until the user presses Alt, which toggles it
};
function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
    // Left over from the removed sign-in compatibility options.
    delete settings.identity;
    delete settings.browserIdentity;
    // Left over from the removed Show Sender Icons and Attachments on Top tweaks.
    delete settings.senderIcons;
    delete settings.attachmentsOnTop;
  } catch {
    /* first run: keep the defaults */
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    /* the setting just won't be remembered */
  }
}

// ---------------------------------------------------------------- logs + about
// A small plain-text log in the data folder, so a problem can be reported with Settings > Logs >
// Export Logs. It records what the app did and what failed; never message content, senders,
// subjects or email addresses.
const LOG_MAX_BYTES = 512 * 1024;
const logPath = () => path.join(app.getPath('userData'), 'maildock-web.log');

function log(message) {
  try {
    const file = logPath();
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
      // Keep the newer half, cut at a line break.
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(text.indexOf('\n', Math.floor(text.length / 2)) + 1));
    }
    // Error text can quote an address, so mask anything that looks like one.
    const line = String(message).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>').replace(/\s+/g, ' ').trim();
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}

// The device ID is a random value made on first run and kept in settings.json. It is not derived
// from hardware and is never sent anywhere; it only lets an exported log be matched to this install.
function ensureDeviceId() {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(settings.deviceId)) return;
  settings.deviceId = crypto.randomUUID();
  saveSettings();
}

const aboutInfo = () => ({
  version: app.getVersion(),
  os: `${os.version()} (${os.release()}, ${process.arch})`,
  deviceId: settings.deviceId,
});

async function exportLogs() {
  if (!win || win.isDestroyed()) return;
  const day = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Logs',
    defaultPath: path.join(app.getPath('documents'), `maildock-web-logs-${day}.txt`),
    filters: [{ name: 'Text file', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return;
  const about = aboutInfo();
  let entries = '';
  try {
    entries = fs.readFileSync(logPath(), 'utf8');
  } catch {
    /* nothing logged yet */
  }
  try {
    fs.writeFileSync(
      filePath,
      [
        `MailDock Web logs, exported ${new Date().toISOString()}`,
        `Application version: ${about.version}`,
        `Operating system: ${about.os}`,
        `Device ID: ${about.deviceId}`,
        `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`,
        '',
        entries || '(no log entries yet)',
      ].join('\n')
    );
    log('Logs exported.');
    shell.showItemInFolder(filePath);
  } catch (err) {
    dialog.showErrorBox('Could not export the logs', `${err.message}\n\nTry saving to a different folder.`);
  }
}

// Record crashes without changing how Electron handles them.
process.on('uncaughtExceptionMonitor', (err) => log(`Unhandled error: ${err?.stack || err}`));

// The first time the window goes to the tray, say so, so it doesn't look like the app closed.
function trayHint() {
  if (settings.trayHintShown) return;
  settings.trayHintShown = true;
  saveSettings();
  try {
    if (Notification.isSupported()) {
      new Notification({ title: 'MailDock Web is still running', body: 'It is in the system tray. Click the tray icon to open it, or right-click it to quit.', icon: appIcon(64) }).show();
    }
  } catch {
    /* a hint is optional */
  }
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  // With the tray icon turned off a hidden window could not be brought back, so keep it on the taskbar.
  if (!tray) return void win.minimize();
  win.hide();
  trayHint();
}

// ---------------------------------------------------------------- appearance settings
const THEMES = ['system', 'dark', 'light'];
// Sets what the app's own pages and the sign-in pages see as the preferred colour scheme.
// Gmail's inbox follows the theme chosen inside Gmail, not this.
function applyTheme() {
  nativeTheme.themeSource = THEMES.includes(settings.theme) ? settings.theme : 'system';
}
function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  settings.theme = theme;
  saveSettings();
  applyTheme();
  pushState();
}

function setTrayIcon(on) {
  settings.trayIcon = Boolean(on);
  saveSettings();
  if (settings.trayIcon && !tray) createTray();
  if (!settings.trayIcon && tray) {
    tray.destroy();
    tray = null;
    // A window that was hidden in the tray would now be unreachable.
    if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
  }
  pushState();
}

function setUnreadBadges(on) {
  settings.unreadBadges = Boolean(on);
  saveSettings();
  pushState();
}

// The menu bar is shown by default; pressing Alt on its own hides it, and pressing it again brings it back.
function setMenuBar(visible) {
  settings.menuBar = Boolean(visible);
  saveSettings();
  if (!win || win.isDestroyed()) return;
  win.setMenuBarVisibility(settings.menuBar);
  setTimeout(layoutActive, 0); // the content area changes height
}

// Alt counts only when pressed and released with no other key in between, so Alt+Tab,
// Alt+F4 and menu shortcuts do not toggle the bar.
let altAlone = false;
function watchAltKey(wc) {
  wc.on('before-input-event', (_e, input) => {
    if (input.key !== 'Alt') altAlone = false;
    else if (input.type === 'keyDown') altAlone = input.isAutoRepeat ? altAlone : !input.control && !input.shift && !input.meta;
    else if (input.type === 'keyUp' && altAlone) {
      altAlone = false;
      setMenuBar(!settings.menuBar);
    }
  });
}

function setMinimizeToTray(on) {
  settings.minimizeToTray = Boolean(on);
  saveSettings();
  buildMenu();
  buildTrayMenu();
  pushState();
}

function setSetting(key, on, rebuild) {
  settings[key] = Boolean(on);
  saveSettings();
  buildMenu();
  if (rebuild) rebuildViews();
  pushState();
}

function setNotifyMode(mode) {
  if (!NOTIFY_MODES.includes(mode)) return;
  settings.notifyMode = mode;
  saveSettings();
  buildMenu();
  pushState();
}

// ---------------------------------------------------------------- window, tray, menu
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: false, // shown or hidden by setMenuBar (Alt toggles it); shortcuts work either way
    icon: process.platform === 'darwin' ? undefined : appIcon(256),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // Without this the taskbar button shows Electron's own icon when the app is run with `npm start`.
  // An installed build already carries the icon in its exe.
  // Windows only honours the taskbar icon here when the relaunch command and name are given with it.
  if (process.platform === 'win32' && !app.isPackaged) {
    const ico = path.join(__dirname, 'icon.ico');
    win.setIcon(ico); // the .ico carries proper taskbar sizes; the resized PNG above does not
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: ico,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'MailDock Web',
    });
  }
  win.setMenuBarVisibility(settings.menuBar);
  watchAltKey(win.webContents);
  win.loadFile('shell.html');
  win.on('resize', layoutActive);
  // The X button never exits: the app keeps running in the tray. Quit from the tray menu or File > Quit.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideToTray();
    }
  });
  win.on('minimize', () => {
    if (settings.minimizeToTray && tray) hideToTray();
  });
  win.webContents.on('did-finish-load', () => {
    // Every account gets its view up front, so unread counts and mail actions work for
    // accounts that have not been opened yet in this run.
    for (const account of accounts) if (!views.has(account.id)) createView(account);
    if (!activeId) selectAccount(accounts[0].id);
    else pushState();
  });
}

function createTray() {
  tray = new Tray(appIcon(process.platform === 'darwin' ? 18 : 32));
  tray.setToolTip('MailDock Web');
  tray.on('click', () => (win && win.isVisible() && !win.isMinimized() ? win.hide() : showWindow()));
  tray.on('double-click', showWindow);
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show MailDock Web', click: showWindow },
      { label: 'Minimize to System Tray', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => setMinimizeToTray(item.checked) },
      { type: 'separator' },
      { label: 'Quit MailDock Web', click: () => app.quit() },
    ])
  );
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Account', accelerator: 'CmdOrCtrl+Shift+N', click: addAccount },
        {
          label: 'Launch at Login',
          type: 'checkbox',
          checked: getLaunchAtLogin(),
          click: (item) => setLaunchAtLogin(item.checked),
        },
        { label: 'Minimize to System Tray', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => setMinimizeToTray(item.checked) },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => toggleSettings(true) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Gmail', accelerator: 'CmdOrCtrl+R', click: () => views.get(activeId)?.webContents.reload() },
        { role: 'togglefullscreen' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        {
          label: 'Edit Custom CSS…',
          click: editCustomCss,
        },
        { label: 'Reload Custom CSS', click: applyCssAll },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => views.get(activeId)?.webContents.openDevTools({ mode: 'detach' }) },
      ],
    },
    {
      label: 'Gmail',
      submenu: [
        { label: 'New Mail Notifications', type: 'checkbox', checked: settings.notifications, click: (item) => setSetting('notifications', item.checked) },
        {
          label: 'Notify About',
          enabled: settings.notifications,
          submenu: [
            { label: 'All New Emails', type: 'radio', checked: settings.notifyMode !== 'important', click: () => setNotifyMode('all') },
            { label: 'Only Important Emails', type: 'radio', checked: settings.notifyMode === 'important', click: () => setNotifyMode('important') },
          ],
        },
        { label: 'Block Ads and Trackers', type: 'checkbox', checked: settings.blocker, click: (item) => setSetting('blocker', item.checked) },
        { type: 'separator' },
        { label: 'Compose in New Window', type: 'checkbox', checked: settings.composeInNewWindow, click: (item) => setSetting('composeInNewWindow', item.checked, true) },
        { type: 'separator' },
        { label: 'Google Apps', submenu: GOOGLE_APPS.map(([label, url]) => ({ label, click: () => openGoogleApp(url) })) },
      ],
    },
    {
      label: 'Accounts',
      submenu: [
        { label: 'All Inboxes', accelerator: 'CmdOrCtrl+Shift+A', click: () => toggleInbox() },
        { type: 'separator' },
        { label: 'Next Account', accelerator: 'Ctrl+Tab', click: () => cycleAccount(1) },
        { label: 'Previous Account', accelerator: 'Ctrl+Shift+Tab', click: () => cycleAccount(-1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Account ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => accounts[i] && selectAccount(accounts[i].id),
        })),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    require('electron-updater').autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.warn('Auto-update unavailable:', err.message);
  }
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('state:get', () => snapshot());
ipcMain.on('account:select', (_e, id) => selectAccount(id));
ipcMain.on('account:add', addAccount);
ipcMain.on('account:remove', (_e, id) => {
  if (accounts.length <= 1) return; // always keep one
  const view = views.get(id);
  if (view) {
    const ses = view.webContents.session;
    if (win.contentView.children.includes(view)) win.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(id);
    ses.clearStorageData().catch(() => {});
  }
  stopFeed(id);
  cssKeys.delete(id);
  domUnread.delete(id);
  signedIn.delete(id);
  unread.delete(id);
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts();
  if (activeId === id) {
    // Keep the unified inbox showing if that is where the account was removed from.
    const keepInbox = inboxOpen;
    const keepSettings = settingsOpen; // removing from Settings > Accounts should stay on that page
    selectAccount(accounts[0].id);
    if (keepInbox) toggleInbox(true);
    else if (keepSettings) toggleSettings(true);
  } else pushState();
});
// Unified inbox (sidebar page only: these change mail, so ignore any other sender)
const fromShell = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
ipcMain.on('inbox:toggle', (e) => fromShell(e) && toggleInbox());
ipcMain.on('settings:toggle', (e) => fromShell(e) && toggleSettings());
// Sidebar app launcher: the page sends a name, never a URL, so it can only open what the menu can.
ipcMain.on('apps:open', (e, name) => {
  if (!fromShell(e)) return;
  const found = GOOGLE_APPS.find(([label]) => label === name);
  if (found) openGoogleApp(found[1]);
});
ipcMain.on('settings:set', (e, key, value) => {
  if (!fromShell(e)) return;
  if (key === 'launchAtLogin') setLaunchAtLogin(value);
  else if (key === 'minimizeToTray') setMinimizeToTray(value);
  else if (key === 'theme') setTheme(value);
  else if (key === 'trayIcon') setTrayIcon(value);
  else if (key === 'unreadBadges') setUnreadBadges(value);
  else if (key === 'notifications') setSetting('notifications', value);
  else if (key === 'notifyMode') setNotifyMode(value);
});
ipcMain.on('settings:action', (e, action) => {
  if (!fromShell(e)) return;
  if (action === 'editCss') editCustomCss();
  else if (action === 'reloadCss') applyCssAll();
  else if (action === 'exportLogs') exportLogs();
});
ipcMain.on('inbox:open', (e, id, messageId) => fromShell(e) && openMessage(id, String(messageId)));
ipcMain.on('inbox:action', (e, id, messageId, action) => fromShell(e) && mailAction(id, String(messageId), action));
// From the Gmail views' preload
ipcMain.on('gmail:unread', (e, count) => {
  const id = [...views].find(([, view]) => view.webContents === e.sender)?.[0];
  if (!id || !Number.isInteger(count) || count < 0) return;
  domUnread.add(id);
  unread.set(id, count);
  pushState();
});
ipcMain.on('gmail:action-done', (e, result) => {
  const pending = pendingActions.get(result?.requestId);
  if (!pending || pending.wc !== e.sender) return;
  pendingActions.delete(result.requestId);
  clearTimeout(pending.timer);
  pending.resolve({ ok: result.ok === true, error: typeof result.error === 'string' ? result.error : 'Gmail refused the request.' });
});
ipcMain.on('account:rename', (_e, id, name) => {
  const account = accounts.find((a) => a.id === id);
  if (account && typeof name === 'string' && name.trim()) {
    account.name = name.trim().slice(0, 40);
    account.named = true;
    saveAccounts();
    pushState();
  }
});
// Windows taskbar overlay badge, drawn by the sidebar page
ipcMain.on('overlay:set', (_e, dataUrl, total) => {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  if (!total || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
    win.setOverlayIcon(null, '');
    return;
  }
  win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), `${total} unread`);
});

// ---------------------------------------------------------------- lifecycle
app.on('before-quit', () => {
  quitting = true;
  log('Quit.');
});

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('mailto');
  registerWindowsIdentity();
  loadAccounts();
  saveAccounts();
  ensureCssFile();
  fs.watchFile(cssPath(), { interval: 1000 }, applyCssAll);

  const initialMailto = process.argv.find((a) => a.startsWith('mailto:'));
  if (initialMailto) pendingMailto = initialMailto;

  loadSettings();
  ensureDeviceId();
  log(`Started MailDock Web ${app.getVersion()} on ${aboutInfo().os}; Electron ${process.versions.electron}; ${accounts.length} account(s)${BARE ? '; diagnostic mode' : ''}.`);
  applyTheme();
  buildMenu();
  if (settings.trayIcon) createTray();
  createWindow();
  if (BARE) console.log('MailDock Web: diagnostic mode. Gmail views run as stock Electron; new-mail checks and tweaks are off.');
  setupAutoUpdate();

  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  // Stay alive in the tray; quit via the tray menu or File menu.
});
