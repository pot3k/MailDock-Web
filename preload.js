const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailbox', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onPlaySound: (cb) => ipcRenderer.on('sound:play', (_e, file) => cb(file)),
  onSettingsSection: (cb) => ipcRenderer.on('settings:section', (_e, id) => cb(id)),
  select: (id) => ipcRenderer.send('account:select', id),
  add: () => ipcRenderer.send('account:add'),
  remove: (id) => ipcRenderer.send('account:remove', id),
  rename: (id, name) => ipcRenderer.send('account:rename', id, name),
  toggleSettings: () => ipcRenderer.send('settings:toggle'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', key, value),
  settingsAction: (action) => ipcRenderer.send('settings:action', action),
  openApp: (name) => ipcRenderer.send('apps:open', name),
  setOverlay: (dataUrl, total) => ipcRenderer.send('overlay:set', dataUrl, total),
});
