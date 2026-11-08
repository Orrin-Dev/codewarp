const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codewarp', {
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (suggestedName, data) =>
    ipcRenderer.invoke('project:save', { suggestedName, data }),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  setAutoUpdate: (enabled) => ipcRenderer.send('update:auto', Boolean(enabled)),
  onUpdateStatus: (listener) => ipcRenderer.on('update:status', (_event, message) => listener(message)),
});
