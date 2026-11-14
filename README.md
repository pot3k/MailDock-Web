# MailDock Web: Gmail's own interface in a desktop app

Electron app that loads the real Gmail website in its own window (like Meru), with a sidebar for multiple accounts. This is a separate project from the Gmail-API client in the parent folder. Its data lives in its own folder (`%APPDATA%\Mailbox Web`, the project's original name), so the two don't interfere.

## Run it

```
cd D:\MyDev\GApp2\web-wrapper
npm install
npm start
```

Needs Node.js 22.12 or newer: Electron 45 cannot download itself on older versions, and `npm start` then fails with "Electron failed to install correctly".

Sign in to Gmail inside the app. Each account is isolated in its own session, so logins persist across restarts.

## If Google says "This browser or app may not be secure"

Google actively blocks embedded browsers, and its checks change over time. There is no guarantee that Google accepts this app. If sign-in is refused:

1. Try another identity under Gmail > Sign-in Compatibility (in the menu bar; press Alt if you have hidden it). Changing it reloads every account.
   - **Standard (unmodified)**, the default: Electron exactly as it is. This is the one Google accepted when the others were refused (November 2026). Until an account is signed in, the app also holds back its blocker and new-mail checks for it.
   - **Clean Chromium User Agent**: the Electron and app names removed from the user agent.
   - **Present as Chrome**: also claims the Google Chrome brand (Client Hints, `navigator.userAgentData`, `window.chrome`) in every frame.
   - **Present as Firefox**: sends a Firefox user agent. Gmail may look slightly different, and the Gmail tweaks may not all work.
2. Sign in once in diagnostic mode, which runs Gmail as stock Electron with none of this app's changes: quit the app, run `$env:MAILDOCK_BARE='1'; npm start` (or `'2'` for the same with a cleaned-up user agent), sign in, quit, then run `Remove-Item Env:MAILDOCK_BARE` and start normally. The sign-in is kept.
3. Close the app fully (tray icon > Quit), delete `%APPDATA%\Mailbox Web`, and try again.
4. Sign in to the same account in your normal Chrome first, then retry.
5. Turn off Gmail > Block Ads and Trackers and try again, in case the blocker is in the way.
6. Fall back to a Chrome app window (Chrome menu > Cast, save and share > Install page as app), or use the Gmail-API client in the parent folder, which signs in through your regular browser and can't be blocked.

## Features

- Multiple accounts in one window. Rename or remove them in Settings > Accounts (double-clicking a sidebar icon opens the rename box, right-clicking removes; removing also signs that account out). Accounts name themselves from the Gmail page title.
- Unread badge per account, plus totals on the dock (macOS), launcher (Linux) and taskbar overlay (Windows).
- New-mail notifications for every account, with Archive, Mark as Read, Delete (moves to Trash) and Spam buttons. Clicking a notification opens the message. Turn them off under Gmail > New Mail Notifications; Gmail's own notifications then work again.
- All Inboxes: the envelope button in the sidebar (Ctrl/Cmd+Shift+A) lists unread inbox mail from every signed-in account, with the same four actions. Click a row to open the message in its account.
- Gmail tweaks (Gmail menu, off by default): Show Sender Icons, Attachments on Top, Compose in New Window. Changing one reloads Gmail in every account.
- Ad and tracker blocker (Gmail > Block Ads and Trackers, on by default).
- Other Google apps open in their own in-app windows, signed in to the same account: the grid button above the gear in the sidebar shows or hides icons for Calendar, Drive, Meet, Contacts, Keep and Docs, and Gmail > Google Apps in the menu bar lists the same six. Any Google link clicked in Gmail opens the same way. The sidebar icons are MailDock's own drawings, not Google's logos.
- Settings page: the gear button at the bottom of the sidebar (Ctrl/Cmd+,). General has Launch at Login and Minimize to System Tray; Accounts lists every account with Edit (rename) and Remove, plus Add Account; Appearance has Theme (System, Dark or Light), Enable System Tray Icon, Show Unread Badges, Edit Custom CSS and Reload Custom CSS; About shows the application version, operating system and device ID; Logs has Export Logs. The theme applies to MailDock Web's own pages; Gmail keeps the theme chosen in its own settings. With the tray icon off, closing the window minimizes it to the taskbar instead of hiding it.
- Logs: the app keeps a small log (`maildock-web.log` in the data folder, capped at about 500 KB) of what it did and what failed. It never records message content, senders, subjects or email addresses. Export Logs saves it as a text file with the About details at the top. The device ID is a random value made on first run; it is stored only on this computer and is not sent anywhere.
- The menu bar is shown by default. Press Alt on its own to hide it, and again to bring it back; the choice is remembered. Shortcuts work either way: Ctrl/Cmd+1..9 switch account, Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl/Cmd+Shift+N add account.
- Tray icon; closing the window hides it to the tray (quit from the tray menu or File > Quit).
- Launch at login (File menu).
- Custom CSS: View > Edit Custom CSS… opens `custom.css`; saving applies it to Gmail live.
- `mailto:` links open a Gmail compose window (choose this app as your default email app in OS settings).
- Links to non-Google sites open in your default browser.
- Auto-update via `electron-updater` in packaged builds (set `build.publish` in `package.json`, then set `GH_TOKEN` and run `npm run release`).

## How it works

- **One window, layered views.** A single window hosts the sidebar page (`shell.html`), and each account's Gmail is a `WebContentsView` placed over it. Closing the window only hides it.
- **Account isolation.** Each account has its own session partition (`persist:acct-<id>`), so cookies and logins never mix. Every account loads `mail.google.com/mail/u/0` in its own partition.
- **New-mail detection.** The main process fetches Gmail's Atom feed (`/feed/atom`) every 30 seconds with the account's session cookies and compares entry IDs with the ones already seen. The first read is the baseline; later new entries raise notifications and fill All Inboxes.
- **Unread count.** `gmail-preload.js` reads the number beside the Inbox link (class `.bsU`) whenever the page changes and sends it to the main process. The page title is the fallback.
- **Mail actions.** Archive, mark as read, delete and spam replay Gmail's own private request: the preload reads `GM_ID_KEY` from the page and the `GMAIL_AT` cookie, then POSTs to `/s/?v=or` with action codes 1, 3, 9 and 7.
- **Gmail tweaks.** Settings reach the preload as `--maildock-*` process arguments. Sender icons, attachments on top and compose in a new window are DOM patches against Gmail's obfuscated class names.
- **Other Google apps.** `window.open` is intercepted; Google pages open as in-app windows in the same account session, everything else in the default browser.
- **Blocker.** A host list is matched in `webRequest.onBeforeRequest` for each session.

The feed address, the private request, and the class names are undocumented and Google can change them at any time. If a tweak, the unread count or a notification button stops working, that is the likely reason; the rest of the app keeps working.

## Notes

- Icons: `icon.png` (window, tray, sidebar mark) and `icon.ico` (Windows installer) are the MailDock mark cut from the logo. Replace those two files to change the icon.
- Third-party app, not affiliated with Google.
