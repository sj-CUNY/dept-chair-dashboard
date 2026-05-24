# Desktop Packaging — Dept Chair Dashboard

Packages the Django dashboard as a native Mac `.dmg` or Windows `.exe` installer.  
No Docker, no Python install, no command line required for end users.

---

## Architecture

```
Electron tray app
  └── spawns bundled Python 3.11 (python-build-standalone)
        └── runs serve.py → Django + Waitress on http://127.0.0.1:4552
```

- User data stored in `~/Library/Application Support/DeptChairDashboard/` (Mac)  
  or `%APPDATA%\DeptChairDashboard\` (Windows)
- LibreOffice is checked on first launch and installed silently if missing

---

## Prerequisites (developer machine only)

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org |
| npm | 10+ | bundled with Node |

---

## Build Steps

### 1. Install Node dependencies

```bash
cd desktop
npm install
```

### 2. Bundle Python + pip install requirements

This downloads python-build-standalone (~30 MB compressed) for the current
platform, extracts it, and pip-installs all `requirements.txt` packages into it.

```bash
npm run bundle-python
```

Output: `desktop/python-dist/` (~200–250 MB)

### 3. Build installer

**macOS (produces `dist/Dept Chair Dashboard-1.0.0.dmg`):**
```bash
npm run dist:mac
```

**Windows (produces `dist/Dept Chair Dashboard Setup 1.0.0.exe`):**
```bash
npm run dist:win
```

> Cross-compiling (building a Windows installer on a Mac) requires Wine and is
> not recommended. Build each platform on its native OS.

---

## Icons

Place icon files in `desktop/build/` before building:

| File | Used for |
|------|---------|
| `build/icon.icns` | macOS app icon |
| `build/icon.ico`  | Windows app icon |
| `build/tray-icon.png` | Menu bar / system tray icon (16×16 or 22×22) |

If `tray-icon.png` or `icon.icns` are missing, electron-builder will warn but
still produce a working build using Electron's default icon.

### Quick icon creation from PNG

```bash
# macOS — create .icns from a 1024×1024 PNG
mkdir icon.iconset
sips -z 16 16     icon-1024.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon-1024.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon-1024.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon-1024.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon-1024.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon-1024.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon-1024.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon-1024.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon-1024.png --out icon.iconset/icon_512x512.png
cp   icon-1024.png icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o build/icon.icns
```

---

## What Happens on End-User Install

### macOS
1. User opens the `.dmg` and drags app to `/Applications/`
2. Double-click to launch

### Windows
1. User runs the `.exe` installer (one-click, no admin needed)
2. App installs to `%LOCALAPPDATA%\Programs\Dept Chair Dashboard\`
3. Desktop shortcut created automatically

### First launch (any platform)
1. Setup window appears showing progress
2. LibreOffice is detected — if missing, ~350 MB installer is downloaded and
   installed silently (no user interaction needed)
3. Django server starts on `http://127.0.0.1:4552`
4. Default browser opens to the dashboard
5. Tray / menu bar icon appears — the app stays running in the background

### Subsequent launches
- Server starts in ~3–5 seconds; browser opens directly (no setup window)

---

## Data Persistence

All data survives app updates and reinstalls:

| Path (Mac) | Contents |
|-----------|---------|
| `~/Library/Application Support/DeptChairDashboard/data/uploads/` | Uploaded PDFs |
| `~/Library/Application Support/DeptChairDashboard/data/signed/` | Signed PDFs |
| `~/Library/Application Support/DeptChairDashboard/data/signatures/` | Signature image |
| `~/Library/Application Support/DeptChairDashboard/data/reports/` | Generated reports |

---

## Development (run without building installer)

```bash
cd desktop
npm install
npm run bundle-python   # only needed once / after requirements.txt changes
npm start               # launches Electron in dev mode
```

---

## Troubleshooting

**`python-dist/` is missing or incomplete**  
→ Re-run `npm run bundle-python`

**LibreOffice install fails on macOS with permissions error**  
→ The user needs write access to `/Applications`. On managed machines, ask IT
  to pre-install LibreOffice.

**Port 4552 already in use**  
→ Set `DASHBOARD_PORT` environment variable before launching, or terminate the
  existing process.

**App won't start on macOS: "unidentified developer"**  
→ Right-click the app → Open → Open. Or sign and notarize the build for
  distribution outside IT-managed channels.
