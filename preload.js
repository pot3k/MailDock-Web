const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailbox', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  select: (id) => ipcRenderer.send('account:select', id),
  add: () => ipcRenderer.send('account:add'),
  remove: (id) => ipcRenderer.send('account:remove', id),
  rename: (id, name) => ipcRenderer.send('account:rename', id, name),
  toggleInbox: () => ipcRenderer.send('inbox:toggle'),
  openMessage: (id, messageId) => ipcRenderer.send('inbox:open', id, messageId),
  mailAction: (id, messageId, action) => ipcRenderer.send('inbox:action', id, messageId, action),
  toggleSettings: () => ipcRenderer.send('settings:toggle'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', key, value),
  settingsAction: (action) => ipcRenderer.send('settings:action', action),
  setOverlay: (dataUrl, total) => ipcRenderer.send('overlay:set', dataUrl, total),
});
