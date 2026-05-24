'use strict';

/**
 * Dept Chair Dashboard — Electron main process
 *
 * Flow:
 *   1. Show setup window (progress UI)
 *   2. Check / install LibreOffice
 *   3. Start Django/Waitress server (bundled Python)
 *   4. Open dashboard URL in the default browser
 *   5. Hide setup window; show tray icon
 *
 * Tray menu:
 *   Open Dashboard | ──── | Quit
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain,
} = require('electron');

const path = require('path');
const fs   = require('fs');

const libreoffice = require('./scripts/libreoffice');
const server      = require('./scripts/server');

// ── Globals ──────────────────────────────────────────────────────────────────

let setupWindow = null;
let tray        = null;
let serverReady = false;

// ── App lifecycle ────────────────────────────────────────────────────────────

// Prevent second instances
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (serverReady) openDashboard();
});

app.whenReady().then(main).catch((err) => {
  dialog.showErrorBox('Startup Error', String(err));
  app.quit();
});

app.on('window-all-closed', (e) => {
  // Keep running as tray app — do NOT quit when the setup window closes
  e.preventDefault();
});

app.on('before-quit', () => {
  server.stop();
});

// ── Main startup sequence ────────────────────────────────────────────────────

async function main() {
  createSetupWindow();

  try {
    // ── Step 1: LibreOffice ──────────────────────────────────────────────
    sendProgress({ step: 'libreoffice-check', msg: 'Checking for LibreOffice…' });

    if (libreoffice.isLibreOfficeInstalled()) {
      sendProgress({ step: 'libreoffice-ok', msg: 'LibreOffice is installed' });
    } else {
      sendProgress({ step: 'libreoffice-dl', pct: 0, msg: 'LibreOffice not found — downloading installer…' });

      await libreoffice.installLibreOffice((step, msgOrPct) => {
        if (step === 'download') {
          sendProgress({ step: 'libreoffice-dl', pct: msgOrPct, msg: `Downloading LibreOffice… ${msgOrPct}%` });
        } else if (step === 'install') {
          sendProgress({ step: 'libreoffice-inst', msg: String(msgOrPct) });
        } else if (step === 'done') {
          sendProgress({ step: 'libreoffice-done', msg: String(msgOrPct) });
        } else if (step === 'error') {
          throw new Error(String(msgOrPct));
        }
      });

      sendProgress({ step: 'libreoffice-done', msg: 'LibreOffice installed successfully' });
    }

    // ── Step 2: Start server ─────────────────────────────────────────────
    sendProgress({ step: 'server-start', msg: 'Starting dashboard server…' });

    await server.start(
      process.resourcesPath,
      app.getPath('userData'),
      (line) => { /* log lines from Python process — could forward to renderer */ },
    );

    serverReady = true;
    sendProgress({ step: 'server-ready', msg: 'Server is running' });

    // ── Step 3: Open browser ─────────────────────────────────────────────
    sendProgress({ step: 'opening', msg: 'Opening dashboard…' });
    await openDashboard();
    sendProgress({ step: 'done' });

    // ── Step 4: Create tray, hide setup window ───────────────────────────
    createTray();
    setTimeout(() => closeSetupWindow(), 800);

  } catch (err) {
    sendError(String(err));
    // Keep setup window open so user can read the error
  }
}

// ── Setup window ──────────────────────────────────────────────────────────────

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width:  520,
    height: 420,
    resizable: false,
    center: true,
    show: true,
    frame: true,
    title: 'Dept Chair Dashboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));

  setupWindow.on('closed', () => { setupWindow = null; });
}

function closeSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
    setupWindow = null;
  }
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

function sendProgress(data) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('setup:progress', data);
  }
}

function sendError(msg) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('setup:error', msg);
  }
}

// ── Tray icon ─────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = trayIconPath();
  const icon     = nativeImage.createFromPath(iconPath);
  tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 16, height: 16 }) : icon);

  tray.setToolTip('Dept Chair Dashboard');
  tray.setContextMenu(buildMenu());

  // Single click on macOS opens dashboard
  if (process.platform === 'darwin') {
    tray.on('click', openDashboard);
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: openDashboard,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        server.stop();
        app.exit(0);
      },
    },
  ]);
}

function trayIconPath() {
  // Use a small PNG bundled with the app
  const candidates = [
    path.join(__dirname, 'build', 'tray-icon.png'),
    path.join(__dirname, 'build', 'icon.png'),
    // Fallback: use icon from static assets inside the app bundle
    path.join(process.resourcesPath, 'app', 'static', 'img', 'icon-16.png'),
    path.join(process.resourcesPath, 'app', 'static', 'img', 'icon-32.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Return empty string — Electron will use a default tray icon
  return '';
}

// ── Open browser ──────────────────────────────────────────────────────────────

async function openDashboard() {
  return shell.openExternal(server.url());
}
