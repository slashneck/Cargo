'use strict';

const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const { Store } = require('./store');
const media = require('./media');
const ipc = require('./ipc');
const updater = require('./updater');

const isDev = !app.isPackaged || process.argv.includes('--dev');

// Keep Chromium's background services quiet; the update check is Cargo's only request.
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,OptimizationHints,Translate');
app.commandLine.appendSwitch('no-pings');

media.registerScheme();

let mainWindow = null;
let pendingOpen = [];

function projectArgs(argv) {
  return argv.filter((a) => /\.(aepx?|flp)$/i.test(a) && !a.startsWith('--'));
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Cargo',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#cccccc', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (pendingOpen.length) {
      mainWindow.webContents.send('app:open-files', pendingOpen);
      pendingOpen = [];
    }
  });

  // The window only ever shows our own page.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  if (isDev) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const files = projectArgs(argv);
    if (files.length) mainWindow.webContents.send('app:open-files', files);
  });

  // macOS: files dropped on the dock icon or opened from Finder.
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('app:open-files', [file]);
    else pendingOpen.push(file);
  });

  app.whenReady().then(() => {
    const store = new Store(app.getPath('userData'));
    const { allowedKeys } = ipc.register({ store });
    media.handleProtocol(allowedKeys);
    buildMenu();
    pendingOpen.push(...projectArgs(process.argv.slice(1)));
    createWindow();
    updater.cleanUp();
    app.on('before-quit', () => store.flush());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
