const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.setName('Codewarp'); // the launcher matches the window to its icon by this name

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.warn('Auto update unavailable:', error.message);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Codewarp',
    icon: path.join(__dirname, 'icon.png'),
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

// A native file picker for uploads (costumes, sounds). It is the same dialog "Open project" uses, which
// works everywhere; a hidden <input type=file> in the page did not on some Linux setups.
ipcMain.handle('file:pick', async (_event, { title, extensions }) => {
  const exts = Array.isArray(extensions) ? extensions.filter((e) => /^[a-z0-9]+$/i.test(e)) : [];
  const result = await dialog.showOpenDialog({
    title: String(title || 'Choose a file'),
    filters: exts.length ? [{ name: 'Supported files', extensions: exts }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), data: await fs.readFile(filePath) };
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

// ---- auto update -------------------------------------------------------------------------------
// The update address is baked into each build (resources/app-update.yml): a dev build looks at the
// rolling "dev" release, a production build at the latest production release. AppImage, deb, rpm and
// the Windows installer update themselves; the portable .exe and a source checkout do not.

const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000;
let autoCheck = true;
let updateTimer = null;
let updateBusy = false;

function updatesSupported() {
  return Boolean(autoUpdater) && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && !process.env.CODEWARP_NO_UPDATE;
}

function tell(message) {
  console.log('[update]', message);
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status', message);
}

// What the update is doing, so a window opened later can show the right thing.
let updateState = { phase: 'idle', version: '', percent: 0 };
let downloadedFile = '';
let installing = false;

function sendEvent(event) {
  updateState = { ...updateState, ...event, phase: event.type };
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:event', event);
}

/** 'rpm' or 'deb' for a package install (electron-builder writes this file), otherwise null. */
function packageType() {
  try {
    const type = require('node:fs').readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    return type === 'rpm' || type === 'deb' ? type : null;
  } catch {
    return null;
  }
}

/**
 * Install a downloaded .rpm/.deb with the system's password prompt (pkexec). electron-updater does this
 * with a blocking call that freezes the window and then replaces the app's files under it, which crashed
 * the app. Here the install runs on the side, the window stays alive and shows what is happening, and
 * we only relaunch once it has finished.
 */
function runPrivileged(type, file) {
  const { spawn } = require('node:child_process');
  const args = type === 'rpm' ? ['rpm', '-U', '--replacepkgs', '--nosignature', file] : ['dpkg', '-i', file];
  return new Promise((resolve, reject) => {
    const child = spawn('pkexec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? 'pkexec (polkit) is not installed, so the update cannot ask for permission.' : error.message)));
    child.on('close', (code) => {
      console.log('[update] install output:', output.trim());
      if (code === 0) return resolve();
      if (code === 126 || code === 127) return reject(new Error('The password prompt was cancelled or not allowed, so nothing was installed.'));
      reject(new Error(`The installer failed (exit ${code}). ${output.trim().split('\n').slice(-3).join(' ')}`.trim()));
    });
  });
}

async function performInstall() {
  if (installing) return;
  installing = true;
  sendEvent({ type: 'installing' });
  try {
    const type = packageType();
    if (type && downloadedFile && require('node:fs').existsSync(downloadedFile)) {
      await runPrivileged(type, downloadedFile);
      sendEvent({ type: 'installed' });
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 800);
    } else {
      // AppImage and the Windows installer: electron-updater replaces the file safely.
      app.removeAllListeners('window-all-closed');
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (error) {
          console.warn('[update] quitAndInstall failed:', error);
          installing = false;
          sendEvent({ type: 'install-failed', message: String(error.message || error) });
        }
      });
      setTimeout(() => app.exit(0), 15000); // a safety net if the app is somehow still here
    }
  } catch (error) {
    installing = false;
    console.warn('[update] install failed:', error);
    sendEvent({ type: 'install-failed', message: String(error.message || error) });
  }
}

function setupAutoUpdate() {
  if (!updatesSupported()) return;
  autoUpdater.channel = 'latest';
  autoUpdater.autoDownload = true;
  // For .rpm/.deb the install asks for a password, so it only happens when the person presses Restart.
  autoUpdater.autoInstallOnAppQuit = !packageType();
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => tell('Checking for updates…'));
  autoUpdater.on('update-available', (info) => {
    tell(`Downloading version ${info.version}…`);
    sendEvent({ type: 'available', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (p) => {
    sendEvent({ type: 'progress', percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on('update-not-available', () => {
    tell('Codewarp is up to date.');
    sendEvent({ type: 'idle' });
  });
  autoUpdater.on('error', (error) => {
    updateBusy = false;
    const text = error == null ? 'unknown error' : String(error.message);
    // The raw error is a wall of HTTP headers. Say what it means, keep the first line, and log the rest.
    console.warn('[update] error:', text);
    if (/404|Cannot find channel/.test(text)) {
      tell('No release has been published on that branch yet, so there is nothing to update to.');
    } else {
      tell(`Could not check for updates: ${text.split('\n')[0].slice(0, 200)}`);
    }
    sendEvent({ type: 'idle' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateBusy = false;
    downloadedFile = info.downloadedFile || '';
    tell(`Version ${info.version} is ready to install.`);
    sendEvent({ type: 'ready', version: info.version, percent: 100 });
  });

  const run = () => {
    if (!autoCheck || updateBusy) return;
    updateBusy = true;
    autoUpdater.checkForUpdates().then(() => (updateBusy = false), () => (updateBusy = false));
  };
  setTimeout(run, 8000);
  updateTimer = setInterval(run, UPDATE_EVERY_MS);
}

ipcMain.handle('update:install', () => performInstall());
ipcMain.handle('update:state', () => updateState);

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  if (!updatesSupported()) {
    return app.isPackaged
      ? 'This copy cannot update itself (the portable .exe has no installer). Download the newest version from the Releases page.'
      : 'Updates only work in an installed copy of Codewarp.';
  }
  if (updateBusy) return 'Already checking…';
  updateBusy = true;
  try {
    await autoUpdater.checkForUpdates();
    return ''; // the result arrives as update:status messages
  } catch (error) {
    return ''; // the 'error' event has already told the window
  } finally {
    updateBusy = false;
  }
});

const FEEDS = {
  production: 'https://github.com/Orrin-Dev/codewarp/releases/latest/download',
  dev: 'https://github.com/Orrin-Dev/codewarp/releases/download/dev',
};

// The person can follow a different branch than the one they downloaded. Moving between them can mean
// going to a lower version number (production 0.2.0 -> dev 0.2.0-dev.7), so downgrades are allowed then.
ipcMain.on('update:channel', (_event, channel) => {
  if (!updatesSupported() || !FEEDS[channel]) return;
  const builtFor = /-dev\./.test(app.getVersion()) ? 'dev' : 'production';
  autoUpdater.setFeedURL({ provider: 'generic', url: FEEDS[channel], channel: 'latest' });
  autoUpdater.allowDowngrade = channel !== builtFor;
});

ipcMain.on('update:auto', (_event, enabled) => {
  autoCheck = enabled;
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
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
