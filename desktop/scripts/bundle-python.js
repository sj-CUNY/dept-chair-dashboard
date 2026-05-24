#!/usr/bin/env node
/**
 * bundle-python.js — Build-time script
 *
 * Downloads a self-contained Python 3.11 from python-build-standalone,
 * extracts it to desktop/python-dist/, and pip-installs all requirements
 * from the Django app.
 *
 * Run via:   npm run bundle-python
 *            (also called automatically by npm run dist:mac / dist:win)
 *
 * Platform notes:
 *   macOS  — downloads .tar.gz, extracts with system tar
 *   Windows — downloads .zip (more reliable than .tar.gz on Windows),
 *             extracts with PowerShell Expand-Archive
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync, spawnSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const PYTHON_VERSION = '3.11.9';
const PBS_RELEASE    = '20240814';
const DEST_DIR       = path.join(__dirname, '..', 'python-dist');
const APP_DIR        = path.join(__dirname, '..', '..');
const REQUIREMENTS   = path.join(APP_DIR, 'requirements.txt');

const PBS_BASE = `https://github.com/indygreg/python-build-standalone/releases/download/${PBS_RELEASE}/`;

// All platforms use .tar.gz.
// Mac/Linux: extracted with system tar.
// Windows: extracted with Python's tarfile module (system tar is unreliable).
const ASSETS = {
  'darwin-x64':   `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`,
  'darwin-arm64': `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`,
  'win32-x64':    `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`,
};

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const key = `${process.platform}-${process.arch}`;
  const assetFile = ASSETS[key];
  if (!assetFile) {
    console.error(`[bundle-python] Unsupported platform/arch: ${key}`);
    console.error('Supported:', Object.keys(ASSETS).join(', '));
    process.exit(1);
  }

  const url     = PBS_BASE + assetFile;
  const tmpFile = path.join(os.tmpdir(), assetFile);

  // ── 1. Download ───────────────────────────────────────────────────────────
  downloadWithCurl(url, tmpFile);

  // ── 2. Extract ────────────────────────────────────────────────────────────
  if (fs.existsSync(DEST_DIR)) {
    console.log('[bundle-python] Removing old python-dist/…');
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log('[bundle-python] Extracting…');
  if (process.platform === 'win32') {
    extractTarWithPython(tmpFile, DEST_DIR);
  } else {
    execSync(`tar -xzf "${tmpFile}" -C "${DEST_DIR}" --strip-components=1`,
             { stdio: 'inherit' });
  }
  console.log('[bundle-python] Extraction complete.');

  // ── 3. Pip install requirements ───────────────────────────────────────────
  // Use "python -m pip" rather than pip.exe — the latter can have a stale
  // internal shebang path in python-build-standalone bundles.
  const python = process.platform === 'win32'
    ? path.join(DEST_DIR, 'python.exe')
    : path.join(DEST_DIR, 'bin', 'python3');

  console.log('[bundle-python] Upgrading pip…');
  spawnSync(python, ['-m', 'pip', 'install', '--upgrade', 'pip'],
            { stdio: 'inherit', cwd: APP_DIR });

  console.log('[bundle-python] Installing Python dependencies…');
  const result = spawnSync(python,
    ['-m', 'pip', 'install', '-r', REQUIREMENTS, '--no-warn-script-location'],
    { stdio: 'inherit', cwd: APP_DIR });
  if (result.status !== 0) {
    console.error('[bundle-python] pip install failed — see output above for details.');
    process.exit(1);
  }

  console.log('[bundle-python] Done! python-dist/ is ready.');
}

// ── Extraction ────────────────────────────────────────────────────────────────

function extractTarWithPython(tarPath, destDir) {
  // Windows's built-in tar truncates large .tar.gz files unreliably.
  // Python's tarfile module handles them correctly and is available on the
  // CI runner via actions/setup-python, and on any developer machine with Python.
  const script = `
import tarfile, os, sys
src, dest = sys.argv[1], sys.argv[2]
os.makedirs(dest, exist_ok=True)
with tarfile.open(src, 'r:gz') as tf:
    for m in tf.getmembers():
        parts = m.name.split('/', 1)
        if len(parts) < 2 or not parts[1]:
            continue
        m.name = parts[1]
        tf.extract(m, dest, set_attrs=False)
print('Extracted to', dest)
`.trim();

  const result = spawnSync('python', ['-c', script, tarPath, destDir],
                           { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('Python tarfile extraction failed');
  }
}

// ── Download via curl ─────────────────────────────────────────────────────────
// curl is pre-installed on macOS, Windows Server 2019+ and Ubuntu runners.
// It handles redirects, retries, and large files correctly out of the box.

function downloadWithCurl(url, dest) {
  console.log(`[bundle-python] Downloading…`);
  console.log(`               ${url}`);

  const result = spawnSync('curl', [
    '--location',           // follow redirects (GitHub releases redirect to CDN)
    '--fail',               // treat HTTP errors as failures
    '--retry', '5',         // retry up to 5 times on transient errors
    '--retry-delay', '5',   // wait 5 s between retries
    '--retry-max-time', '300',
    '--connect-timeout', '30',
    '--max-time', '600',    // 10-minute hard cap
    '--progress-bar',       // show a simple progress bar
    '--output', dest,
    url,
  ], { stdio: 'inherit' });

  if (result.status !== 0) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    throw new Error(`curl exited with code ${result.status}`);
  }

  const size = fs.statSync(dest).size;
  if (size < 5 * 1024 * 1024) {  // < 5 MB is certainly wrong for these archives
    fs.unlinkSync(dest);
    throw new Error(`Downloaded file is too small (${(size/1024/1024).toFixed(1)} MB) — likely truncated`);
  }

  console.log(`[bundle-python] Download complete (${(size/1024/1024).toFixed(1)} MB).`);
}

try { main(); } catch (err) { console.error('[bundle-python]', err.message); process.exit(1); }
