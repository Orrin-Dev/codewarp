const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codewarp', {
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (suggestedName, data) =>
    ipcRenderer.invoke('project:save', { suggestedName, data }),
  pickFile: (title, extensions) => ipcRenderer.invoke('file:pick', { title, extensions }),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  setAutoUpdate: (enabled) => ipcRenderer.send('update:auto', Boolean(enabled)),
  setUpdateChannel: (channel) => ipcRenderer.send('update:channel', channel),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateEvent: (listener) => ipcRenderer.on('update:event', (_event, payload) => listener(payload)),
  onUpdateStatus: (listener) => ipcRenderer.on('update:status', (_event, message) => listener(message)),
});
