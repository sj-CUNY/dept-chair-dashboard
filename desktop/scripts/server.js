/**
 * Python/Django server lifecycle management.
 *
 * Usage:
 *   const server = require('./server');
 *   await server.start(resourcesPath, userDataPath);
 *   server.stop();
 */

'use strict';

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');
const http       = require('http');

const PORT = 4552;
let serverProcess = null;

// ── Python executable ────────────────────────────────────────────────────────

function pythonExe(resourcesPath) {
  if (process.platform === 'win32') {
    return path.join(resourcesPath, 'python', 'python.exe');
  }
  // macOS / Linux — python-build-standalone layout
  return path.join(resourcesPath, 'python', 'bin', 'python3');
}

// ── Start server ─────────────────────────────────────────────────────────────

/**
 * Start the Django/Waitress server.
 * @param {string} resourcesPath  Electron's process.resourcesPath
 * @param {string} userDataPath   Path for data storage (app.getPath('userData'))
 * @param {function} onLog        Called with each log line from stdout/stderr
 * @returns {Promise<void>}       Resolves when the server is accepting connections
 */
function start(resourcesPath, userDataPath, onLog) {
  return new Promise((resolve, reject) => {
    if (serverProcess) { resolve(); return; }

    const python   = pythonExe(resourcesPath);
    const appDir   = path.join(resourcesPath, 'app');
    const serveScript = path.join(appDir, 'serve.py');
    const dataDir  = path.join(userDataPath, 'data');

    // Ensure directories exist
    fs.mkdirSync(dataDir, { recursive: true });

    // Seed bundled template PDFs into the user data dir on first launch
    const bundledData = path.join(appDir, 'data');
    const templates = ['check_request_template.pdf', 'etravel_voucher_template.pdf'];
    for (const tpl of templates) {
      const src = path.join(bundledData, tpl);
      const dst = path.join(dataDir, tpl);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch {}
      }
    }

    if (!fs.existsSync(python)) {
      return reject(new Error(`Bundled Python not found at:\n${python}`));
    }
    if (!fs.existsSync(serveScript)) {
      return reject(new Error(`serve.py not found at:\n${serveScript}`));
    }

    const env = {
      ...process.env,
      DJANGO_SETTINGS_MODULE: 'config.settings',
      DASHBOARD_DATA_DIR: dataDir,
      DASHBOARD_PORT: String(PORT),
      PYTHONPATH: appDir,
      PYTHONUNBUFFERED: '1',
    };

    serverProcess = spawn(python, [serveScript], {
      cwd: appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (d) => {
      const line = d.toString().trim();
      onLog?.(line);
    });
    serverProcess.stderr.on('data', (d) => {
      const line = d.toString().trim();
      onLog?.(line);
    });

    serverProcess.on('error', (err) => {
      serverProcess = null;
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      serverProcess = null;
      if (code !== 0 && code !== null) {
        onLog?.(`[server] exited with code ${code}`);
      }
    });

    // Poll until the server responds on PORT
    waitForServer(PORT, 60_000)
      .then(resolve)
      .catch((err) => {
        stop();
        reject(err);
      });
  });
}

// ── Stop server ───────────────────────────────────────────────────────────────

function stop() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function check() {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) {
          return reject(new Error(`Server did not start within ${timeoutMs / 1000}s`));
        }
        setTimeout(check, 500);
      });
    }
    check();
  });
}

function isRunning() { return serverProcess !== null; }
function url()       { return `http://127.0.0.1:${PORT}`; }

module.exports = { start, stop, isRunning, url };
