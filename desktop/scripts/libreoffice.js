/**
 * LibreOffice detection and silent installation.
 *
 * Exported functions:
 *   isLibreOfficeInstalled()  → boolean
 *   installLibreOffice(onProgress)  → Promise<void>
 *
 * onProgress(step, message) is called with updates during installation.
 * step: 'download' | 'install' | 'done' | 'error'
 */

'use strict';

const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const execAsync    = promisify(exec);
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ── Detection ────────────────────────────────────────────────────────────────

const MAC_SOFFICE   = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
const WIN_SOFFICE   = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const WIN_SOFFICE86 = 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe';

function isLibreOfficeInstalled() {
  if (process.platform === 'darwin') {
    return fs.existsSync(MAC_SOFFICE);
  }
  if (process.platform === 'win32') {
    return fs.existsSync(WIN_SOFFICE) || fs.existsSync(WIN_SOFFICE86);
  }
  // Linux — check PATH
  try {
    require('child_process').execSync('which soffice', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── Download helper ──────────────────────────────────────────────────────────

/**
 * Download a URL to a local file with progress callback.
 * Follows up to 5 redirects automatically.
 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let redirects = 0;

    function get(currentUrl) {
      const lib = currentUrl.startsWith('https') ? https : http;
      lib.get(currentUrl, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (++redirects > 5) return reject(new Error('Too many redirects'));
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          received += chunk.length;
          out.write(chunk);
          if (total > 0 && onProgress) {
            onProgress('download', Math.round((received / total) * 100));
          }
        });

        res.on('end', () => { out.end(); resolve(); });
        res.on('error', reject);
        out.on('error', reject);
      }).on('error', reject);
    }

    get(url);
  });
}

// ── Installation ─────────────────────────────────────────────────────────────

// Latest stable LibreOffice installer URLs.
// Pin to a specific version for reproducibility.
const LO_VERSION = '25.8.7';
const LO_BASE    = `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/`;

const MAC_DMG_URL = `${LO_BASE}mac/x86_64/LibreOffice_${LO_VERSION}_MacOS_x86_64.dmg`;
const MAC_ARM_URL = `${LO_BASE}mac/aarch64/LibreOffice_${LO_VERSION}_MacOS_aarch64.dmg`;
const WIN_MSI_URL = `${LO_BASE}win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`;

async function installLibreOffice(onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-install-'));

  try {
    if (process.platform === 'darwin') {
      await installMac(tmpDir, onProgress);
    } else if (process.platform === 'win32') {
      await installWin(tmpDir, onProgress);
    } else {
      throw new Error('Automatic LibreOffice installation is only supported on macOS and Windows.\nPlease install LibreOffice manually from https://www.libreoffice.org/download/');
    }
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function installMac(tmpDir, onProgress) {
  const arch    = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const dmgUrl  = arch === 'arm64' ? MAC_ARM_URL : MAC_DMG_URL;
  const dmgPath = path.join(tmpDir, 'LibreOffice.dmg');

  onProgress?.('download', 0);
  await download(dmgUrl, dmgPath, (step, pct) => onProgress?.(step, pct));

  onProgress?.('install', 'Mounting disk image…');
  const { stdout: mountOut } = await execAsync(`hdiutil attach -nobrowse -quiet "${dmgPath}" && hdiutil info | grep -A1 LibreOffice | grep /Volumes | head -1 | awk '{print $NF}'`);
  const mountPoint = mountOut.trim() || `/Volumes/LibreOffice ${LO_VERSION}`;

  onProgress?.('install', 'Copying LibreOffice.app to /Applications…');
  await execAsync(`cp -R "${mountPoint}/LibreOffice.app" /Applications/`);

  onProgress?.('install', 'Unmounting disk image…');
  try { await execAsync(`hdiutil detach "${mountPoint}" -quiet`); } catch {}

  onProgress?.('done', 'LibreOffice installed successfully.');
}

async function installWin(tmpDir, onProgress) {
  const msiPath = path.join(tmpDir, 'LibreOffice.msi');

  onProgress?.('download', 0);
  await download(WIN_MSI_URL, msiPath, (step, pct) => onProgress?.(step, pct));

  onProgress?.('install', 'Running installer (this may take a few minutes)…');
  await execFileAsync('msiexec', ['/i', msiPath, '/quiet', '/norestart']);

  onProgress?.('done', 'LibreOffice installed successfully.');
}

module.exports = { isLibreOfficeInstalled, installLibreOffice };
