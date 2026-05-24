"""
Generate all icon assets for the Dept Chair Dashboard app.

Produces:
  icon-1024.png   — master source
  icon.ico        — Windows multi-size (16 32 48 64 128 256)
  tray-icon.png   — 22×22 menu-bar / tray
  icon.icns       — macOS (via iconutil, macOS-only)
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).parent   # desktop/build/

# ── Palette ───────────────────────────────────────────────────────────────────
BG_TOP    = (30,  68, 120)   # navy blue
BG_BOT    = (18,  48,  90)   # darker navy
WHITE     = (255, 255, 255)
CLIP_BG   = (242, 247, 255)  # near-white clipboard face
LINE_DARK = (190, 210, 235)  # muted blue-grey rule lines
LINE_MED  = (210, 228, 248)
ACCENT    = (82,  160, 220)  # sky-blue (clip, header cells)
ACCENT_DK = (55,  120, 180)  # darker accent for clip outline

# ── Helpers ───────────────────────────────────────────────────────────────────

def rounded_rect(draw, xy, radius, fill, outline=None, width=0):
    draw.rounded_rectangle(xy, radius=radius, fill=fill,
                           outline=outline, width=width)

# ── Master icon ───────────────────────────────────────────────────────────────

def make_master(S=1024):
    img  = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── 1. Background rounded square (gradient faked via two rects) ───────
    r_bg = int(S * 0.22)
    # Full rounded square in darker colour
    draw.rounded_rectangle([(0,0),(S-1,S-1)], radius=r_bg, fill=BG_BOT)
    # Top-half lighter tint — clip to the same rounded rect via a mask layer
    top_layer = Image.new('RGBA', (S, S), (0,0,0,0))
    td = ImageDraw.Draw(top_layer)
    # Draw lighter colour only over the top half, still inside the rounded rect
    td.rounded_rectangle([(0,0),(S-1,S-1)], radius=r_bg, fill=BG_TOP+(255,))
    # Erase the bottom half of the top_layer
    td.rectangle([(0, S//2),(S-1,S-1)], fill=(0,0,0,0))
    img = Image.alpha_composite(img, top_layer)
    draw = ImageDraw.Draw(img)

    # ── 2. Subtle top-edge highlight ──────────────────────────────────────
    glow_h = int(S * 0.05)
    for dy in range(glow_h):
        alpha = int(45 * (1 - dy / glow_h))
        x0 = int(r_bg * 0.4)
        draw.line([(x0, int(S*0.04)+dy), (S-x0, int(S*0.04)+dy)],
                  fill=(255,255,255,alpha))

    # ── 3. Clipboard body ─────────────────────────────────────────────────
    cx   = S // 2
    cy   = int(S * 0.535)
    cw   = int(S * 0.56)
    ch   = int(S * 0.64)
    cb_r = int(S * 0.028)
    cx0, cy0 = cx - cw//2, cy - ch//2
    cx1, cy1 = cx + cw//2, cy + ch//2

    # Drop shadow (draw a blurred dark rect beneath)
    sh_off = int(S * 0.015)
    sh_layer = Image.new('RGBA', (S,S), (0,0,0,0))
    sh_draw  = ImageDraw.Draw(sh_layer)
    sh_draw.rounded_rectangle(
        [(cx0+sh_off, cy0+sh_off), (cx1+sh_off, cy1+sh_off)],
        radius=cb_r+2, fill=(0,0,0,80)
    )
    sh_layer = sh_layer.filter(ImageFilter.GaussianBlur(int(S*0.012)))
    img  = Image.alpha_composite(img, sh_layer)
    draw = ImageDraw.Draw(img)

    # Clipboard face
    draw.rounded_rectangle([(cx0, cy0),(cx1, cy1)], radius=cb_r, fill=CLIP_BG)

    # Thin border
    draw.rounded_rectangle([(cx0, cy0),(cx1, cy1)], radius=cb_r,
                            fill=None, outline=(200,218,240), width=int(S*0.003))

    # ── 4. Clipboard clip (top centre) ────────────────────────────────────
    clip_w  = int(cw * 0.34)
    clip_h  = int(S * 0.064)
    clip_r  = int(S * 0.024)
    clip_x0 = cx - clip_w//2
    clip_x1 = cx + clip_w//2
    clip_y0 = cy0 - clip_h//2
    clip_y1 = cy0 + clip_h//2

    # Clip body
    draw.rounded_rectangle([(clip_x0, clip_y0),(clip_x1, clip_y1)],
                            radius=clip_r, fill=ACCENT)
    draw.rounded_rectangle([(clip_x0, clip_y0),(clip_x1, clip_y1)],
                            radius=clip_r, fill=None,
                            outline=ACCENT_DK, width=int(S*0.004))

    # Inner hole
    hw = int(clip_w * 0.42)
    hh = int(clip_h * 0.44)
    hr = hh//2
    draw.rounded_rectangle(
        [(cx-hw//2, cy0-hh//2),(cx+hw//2, cy0+hh//2)],
        radius=hr, fill=BG_TOP
    )

    # ── 5. Rule lines (schedule rows) ────────────────────────────────────
    pad_x   = int(cw * 0.09)
    lx0     = cx0 + pad_x
    lx1     = cx1 - pad_x
    line_top = cy0 + int(ch * 0.14)
    line_bot = cy1 - int(ch * 0.08)
    n_lines  = 5
    gap      = (line_bot - line_top) / (n_lines - 1)
    lh       = int(S * 0.019)
    lr       = lh // 2

    for i in range(n_lines):
        ly    = int(line_top + i * gap)
        short = (i % 2 == 1)
        x0_i  = lx0 + (int(cw*0.05) if short else 0)
        x1_i  = lx1 - (int(cw*0.12) if short else 0)
        col   = LINE_MED if short else LINE_DARK
        draw.rounded_rectangle(
            [(x0_i, ly-lh//2),(x1_i, ly+lh//2)],
            radius=lr, fill=col
        )

    # ── 6. Calendar accent grid (bottom-right corner of clipboard) ────────
    cell  = int(S * 0.033)
    gp    = int(S * 0.009)
    stride= cell + gp
    cols  = 3
    rows  = 2
    gx0   = cx1 - pad_x - cols*stride + gp
    gy0   = cy1 - int(ch * 0.28)

    for row in range(rows):
        for col in range(cols):
            gx = gx0 + col * stride
            gy = gy0 + row * stride
            fill = ACCENT if row == 0 else LINE_DARK
            draw.rounded_rectangle(
                [(gx, gy),(gx+cell, gy+cell)],
                radius=int(cell*0.3), fill=fill
            )

    return img

# ── Tray icon ─────────────────────────────────────────────────────────────────

def make_tray(master):
    return master.resize((22, 22), Image.LANCZOS)

# ── ICO ───────────────────────────────────────────────────────────────────────

def make_ico(master):
    # electron-builder requires the ICO to contain a 256×256 frame.
    # Pillow's ICO saver: pass the largest image as the base and let
    # the sizes= parameter handle the downscaled entries.
    img_256 = master.resize((256, 256), Image.LANCZOS)
    ico_path = OUT / 'icon.ico'
    img_256.save(
        ico_path, format='ICO',
        sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)],
    )
    return ico_path

# ── ICNS (macOS only) ─────────────────────────────────────────────────────────

def make_icns(master_path):
    iconset = OUT / 'icon.iconset'
    iconset.mkdir(exist_ok=True)
    master = Image.open(master_path)
    spec = [
        ('icon_16x16.png',       16),
        ('icon_16x16@2x.png',    32),
        ('icon_32x32.png',       32),
        ('icon_32x32@2x.png',    64),
        ('icon_128x128.png',    128),
        ('icon_128x128@2x.png', 256),
        ('icon_256x256.png',    256),
        ('icon_256x256@2x.png', 512),
        ('icon_512x512.png',    512),
        ('icon_512x512@2x.png',1024),
    ]
    for name, size in spec:
        master.resize((size, size), Image.LANCZOS).save(iconset / name, 'PNG')

    icns_path = OUT / 'icon.icns'
    res = subprocess.run(
        ['iconutil', '-c', 'icns', str(iconset), '-o', str(icns_path)],
        capture_output=True
    )
    shutil.rmtree(iconset, ignore_errors=True)
    if res.returncode != 0:
        print(f'[iconutil] {res.stderr.decode()}', file=sys.stderr)
        return None
    return icns_path

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print('[icon] Rendering…')
    master = make_master(1024)

    p = OUT / 'icon-1024.png'
    master.save(p, 'PNG')
    print(f'[icon] {p}')

    tray = OUT / 'tray-icon.png'
    make_tray(master).save(tray, 'PNG')
    print(f'[icon] {tray}')

    ico = make_ico(master)
    print(f'[icon] {ico}')

    if sys.platform == 'darwin':
        icns = make_icns(p)
        if icns:
            print(f'[icon] {icns}')
    else:
        print('[icon] Skipping .icns (not on macOS)')

    print('[icon] Done.')

if __name__ == '__main__':
    main()
