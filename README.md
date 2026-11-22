# MailDock Web: Gmail's own interface in a desktop app

Electron app that loads the real Gmail website in its own window, with a sidebar for multiple accounts. Its data lives in `%APPDATA%\Mailbox Web` (the project's original name).

## Run it

```
npm install
npm start
```

Needs Node.js 22.12 or newer: Electron 45 cannot download itself on older versions, and `npm start` then fails with "Electron failed to install correctly".

Sign in to Gmail inside the app. Each account is isolated in its own session, so logins persist across restarts.

## Build an installer

```
npm run dist
```

This makes `dist\MailDock Web Setup <version>.exe`, a per-user Windows installer that needs no admin rights. The version comes from `package.json`. The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time; click More info, then Run anyway. The installed app keeps its data in the same `%APPDATA%\Mailbox Web` folder as `npm start`, so it opens with the same accounts and settings.

## If Google says "This browser or app may not be secure"

Google actively blocks embedded browsers, and its checks change over time. There is no guarantee that Google accepts this app.

The app runs Gmail as plain Electron: it does not change its user agent or pretend to be another browser. Until an account is signed in, it also holds back its ad blocker and new-mail checks for that account. If sign-in is still refused:

1. Sign in once in diagnostic mode, which also switches off the rest of the app's additions for that run: quit the app, run `$env:MAILDOCK_BARE='1'; npm start`, sign in, quit, then run `Remove-Item Env:MAILDOCK_BARE` and start normally. The sign-in is kept.
2. Close the app fully (tray icon > Quit), delete `%APPDATA%\Mailbox Web`, and try again.
3. Sign in to the same account in your normal browser first, then retry.
4. Fall back to a Chrome app window (Chrome menu > Cast, save and share > Install page as app).

## Features

- Multiple accounts in one window. Rename or remove them in Settings > Accounts (double-clicking a sidebar icon opens the rename box, right-clicking removes; removing also signs that account out). Accounts name themselves from the Gmail page title.
- Unread badge per account, plus totals on the dock (macOS), launcher (Linux) and taskbar overlay (Windows). Each has its own switch: Settings > Appearance > Show Unread Badges for the account buttons, Settings > General > Show Unread Badge on Taskbar Icon for the total.
- New-mail notifications for every account, with Archive, Mark as Read, Delete (moves to Trash) and Spam buttons. Clicking a notification opens the message. Settings > Notifications turns them on or off (New Emails) and chooses whether to be told about All New Emails or Only Important Emails, meaning mail Gmail has marked Important; the Gmail menu has the same options. Under Notification Times, Only at Set Times limits notifications to chosen days and a From–To time (a period that ends earlier than it starts runs past midnight); mail outside those times is still counted and listed, just not announced. Test Notification shows a sample notification to check that Windows lets them through. Gmail's own desktop notifications are always blocked inside the app, so with New Emails off there are no new-mail notifications at all. Other Google apps opened from the app, such as Calendar, can still show theirs.
- Notification sound: Settings > Notifications > Sound chooses what plays when MailDock Web shows a notification: Windows Default (the sound set in Windows), No Sound, or one of ten sounds that come with the app. Clicking a sound chooses it and plays it once; Play listens without choosing. Windows can only attach its own sounds to a notification, so with one of the app's sounds chosen the notification is shown silent and the app plays the sound itself. That means it may still play when Windows Do Not Disturb holds the notification back; choose Windows Default if you rely on Do Not Disturb. When several notifications arrive together, the sound plays once. Calendar and other Google apps keep the Windows sound.
- All Inboxes: the envelope button in the sidebar (Ctrl/Cmd+Shift+A) lists unread inbox mail from every signed-in account, with the same four actions. Click a row to open the message in its account.
- Compose in New Window (Gmail menu, off by default): the Compose button opens a separate compose window. Changing it reloads Gmail in every account.
- Ad and tracker blocker (Gmail > Block Ads and Trackers, on by default; it starts working for an account once that account is signed in).
- Other Google apps open in their own in-app windows, signed in to the same account: the grid button above the gear in the sidebar shows or hides icons for Calendar, Drive, Meet, Contacts, Keep and Docs, and Gmail > Google Apps in the menu bar lists the same six. Any Google link clicked in Gmail opens the same way. The sidebar icons are MailDock's own drawings, not Google's logos.
- Settings page: the gear button at the bottom of the sidebar (Ctrl/Cmd+,). General has Launch at Login, Minimize to System Tray, Show Unread Badge on Taskbar Icon and Default Mail Client (Windows); Accounts lists every account with Edit (rename) and Remove, plus Add Account; Notifications has New Emails, Notify (All New Emails or Only Important Emails), Notification Times (days of the week and a From–To time), Sound (the notification sound) and Test Notification; Appearance has Theme (System, Dark or Light), Enable System Tray Icon, Show Unread Badges, Edit Custom CSS and Reload Custom CSS; About shows the application version, operating system and device ID; Logs has Export Logs. The theme applies to MailDock Web's own pages; Gmail keeps the theme chosen in its own settings. With the tray icon off, closing the window minimizes it to the taskbar instead of hiding it.
- Logs: the app keeps a small log (`maildock-web.log` in the data folder, capped at about 500 KB) of what it did and what failed. It never records message content, senders, subjects or email addresses. Export Logs saves it as a text file with the About details at the top. The device ID is a random value made on first run; it is stored only on this computer and is not sent anywhere.
- The menu bar is shown by default. Press Alt on its own to hide it, and again to bring it back; the choice is remembered. Shortcuts work either way: Ctrl/Cmd+1..9 switch account, Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl/Cmd+Shift+N add account.
- Tray icon; closing the window hides it to the tray (quit from the tray menu or File > Quit).
- Launch at login (File menu).
- Custom CSS: View > Edit Custom CSS… opens `custom.css`; saving applies it to Gmail live.
- `mailto:` links open a Gmail compose window once MailDock Web is your default email app. On Windows, Settings > General > Default Mail Client registers MailDock Web as an email app for your Windows user (no admin rights needed) and opens Windows Settings > Default apps at MailDock Web's page; click MAILTO there and choose MailDock Web. Windows only lets you make that choice yourself. On other systems, choose the default email app in the system settings.
- Links to non-Google sites open in your default browser.
- Right-click menu in Gmail: on text or a link, Select All and Copy Link Address (greyed out when not on a link); with text selected, Search with Google (opens your default browser), Copy and Select All; in a typing area such as Compose, Cut, Copy, Paste and Select All. Gmail's own right-click menus, for example on an inbox row, still appear where Gmail provides them.
- Auto-update via `electron-updater` in installed builds: on start, the app checks the GitHub releases of `pot3k/MailDock-Web` for a newer version. To publish one, raise `version` in `package.json`, set `GH_TOKEN` to a GitHub token, and run `npm run release`.

## Inside the code

Four files do the work.

| File | Runs in | Job |
|---|---|---|
| `main.js` | Electron's main process | Windows, accounts, settings, tray, menus, new-mail checks, notifications, blocker, logs |
| `shell.html` + `preload.js` | The app's own page | Sidebar, All Inboxes, Settings |
| `gmail-preload.js` | Alongside each Gmail page | Unread count, mail actions, Compose in New Window |

How the pieces fit together:

1. **Layout.** There is one window. `shell.html` fills it, and the selected account's Gmail is a separate view laid over everything to the right of the 68-pixel sidebar. All Inboxes and Settings are drawn by `shell.html` in that same space, so the app lifts the Gmail view away while they are open.
2. **Accounts.** Each account is given its own storage partition, named after a random ID. Cookies, sign-ins and cached data are separate per account, which is why two accounts can both be "user 0" of Gmail at the same time.
3. **Knowing about new mail.** For each signed-in account, `main.js` asks Gmail for its unread-inbox feed twice a minute, using that account's cookies. It remembers which entries it has seen. The first answer only sets the starting point; anything new after that becomes a row in All Inboxes, and a notification. With Only Important Emails chosen, the app first asks Gmail's Important feed which of the new messages are marked Important and notifies only about those; if that check fails, it notifies about all of them rather than risk a missed email. If Gmail cannot be reached, the checks slow down to once every five minutes until it can.
4. **Unread badge.** The number is read from the Gmail page itself, next to the Inbox link, each time the page changes. Before the page has reported one, the count in the window title is used.
5. **Acting on a message.** Archive, Mark as Read, Delete and Spam are carried out inside the Gmail page, by sending the same request Gmail's own buttons send. `main.js` asks, the page does it and reports back, and the feed is checked again.
6. **Compose in New Window.** This optional tweak is switched on by a start-up argument passed to `gmail-preload.js`, so changing it reloads Gmail. It takes over the Compose button and opens Gmail's full-window compose page.
7. **Links and other Google apps.** Links to Google pages open in a new window inside the app, on the same account. Sign-in pages open in the account's own view. Everything else goes to your default browser.
8. **Blocker.** Once an account is signed in, requests to a short list of advertising and tracking hosts are cancelled.

Points 3 to 6 rely on parts of Gmail that Google does not document and can change without notice. If the unread count, a notification button or Compose in New Window stops working, that is the likely cause; the rest of the app is unaffected.

## Notes

- Icons: `icon.png` (window, tray, sidebar mark) and `icon.ico` (Windows installer) are the MailDock mark cut from the logo. Replace those two files to change the icon.
- Sounds: the notification sounds are `sounds/Sound_1.wav` to `sounds/Sound_10.wav`. The list in Settings > Notifications > Sound comes from `SOUNDS` in `main.js`; to add one, put the file in `sounds/` and add it there.
- Third-party app, not affiliated with Google.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 pot3k.
