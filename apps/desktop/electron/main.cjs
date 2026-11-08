const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Codewarp',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open project',
    filters: [{ name: 'Scratch 3 project', extensions: ['sb3'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const data = await fs.readFile(filePath);
  return { name: path.basename(filePath), data };
});

ipcMain.handle('project:save', async (_event, { suggestedName, data }) => {
  const result = await dialog.showSaveDialog({
    title: 'Save project',
    defaultPath: suggestedName || 'project.sb3',
    filters: [{ name: 'Scratch 3 project', extensions: ['sb3'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, Buffer.from(data));
  return result.filePath;
});

app.whenReady().then(() => {
  // Let the sound recorder use the microphone (Electron denies it by default).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'audioCapture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission),
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
