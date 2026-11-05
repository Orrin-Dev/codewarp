const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codewarp', {
  openProject: () => ipcRenderer.invoke('project:open'),
  saveProject: (suggestedName, data) =>
    ipcRenderer.invoke('project:save', { suggestedName, data }),
});
