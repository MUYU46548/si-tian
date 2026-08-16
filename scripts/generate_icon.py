#!/usr/bin/env python3
"""
司天 SiTian 图标生成脚本
V2-A2 · 超极限版 — 围棋星位 × 银河航道
输出: SVG 源文件 + PNG 全规格 + Windows ICO + macOS ICNS
"""
from PIL import Image, ImageDraw
import struct, json, io
from pathlib import Path

OUT_DIR = Path("E:/CODE/CangKu/SiTian/build")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ===== 设计参数 (512x512 viewBox) =====
SCALE = 512

# 颜色定义
BG_FILL = (238, 241, 246)        # #eef1f6
STROKE_OUTER = (58, 74, 98)      # #3a4a62
STROKE_OUTER_W = 6
STROKE_INNER_COLOR = (58, 74, 98, 64)
STROKE_INNER_W = 1.5

LANE_COLOR = (40, 80, 130, 204)       # rgba(40,80,130,0.8)
LANE_W = 10
DIAG_COLOR = (100, 60, 140, 153)      # rgba(100,60,140,0.6)
DIAG_W = 7

STAR_CORNER = (42, 58, 82)            # #2a3a52
STAR_CORNER_R = 18
STAR_EDGE_C = (42, 58, 82, 242)      # rgba(42,58,82,0.95)
STAR_EDGE_R = 13

GLOW_COLOR = (232, 198, 106, 40)
GLOW_R = 50
CORE_B = (232, 198, 106)              # #e8c66a (外圈)
CORE_INNER_B = (255, 251, 230)        # #fffbe6 (内亮)
CORE_INNER_R = 24
CORE_INNER_SMALL_R = 15
HL_COLOR = (255, 255, 255, 179)      # 高光
HL_R = 9

CORNER_R = 100
PAD = 16


def draw_icon(size):
    """Draw icon at given pixel size."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    sc = size / SCALE  # scale factor
    def s(v): return int(v * sc)
    
    # 背景
    x0, y0, x1, y1 = s(PAD), s(PAD), size-s(PAD), size-s(PAD)
    r = s(CORNER_R)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=BG_FILL)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, outline=STROKE_OUTER, width=max(1, s(STROKE_OUTER_W)))
    
    # 内描边
    ix0, iy0, ix1, iy1 = s(28), s(28), size-s(28), size-s(28)
    draw.rounded_rectangle([ix0, iy0, ix1, iy1], radius=s(88), outline=STROKE_INNER_COLOR, width=max(1, s(STROKE_INNER_W)))
    
    # 航道坐标
    c1, c2, c3 = s(110), s(256), s(402)
    lw = max(1, s(LANE_W))
    dw = max(1, s(DIAG_W))
    
    # 横竖航道
    for p in [c1, c2, c3]:
        draw.line([(c1, p), (c3, p)], fill=LANE_COLOR, width=lw)
        draw.line([(p, c1), (p, c3)], fill=LANE_COLOR, width=lw)
    
    # 斜航道
    draw.line([(c1, c1), (c3, c3)], fill=DIAG_COLOR, width=dw)
    draw.line([(c3, c1), (c1, c3)], fill=DIAG_COLOR, width=dw)
    
    # 四角星
    sr = s(STAR_CORNER_R)
    for cx, cy in [(c1,c1),(c3,c1),(c3,c3),(c1,c3)]:
        draw.ellipse([cx-sr, cy-sr, cx+sr, cy+sr], fill=STAR_CORNER)
    
    # 四边星
    ser = s(STAR_EDGE_R)
    for cx, cy in [(c2,c1),(c3,c2),(c2,c3),(c1,c2)]:
        draw.ellipse([cx-ser, cy-ser, cx+ser, cy+ser], fill=STAR_EDGE_C)
    
    # 天元
    cx, cy = s(256), s(256)
    draw.ellipse([cx-s(GLOW_R), cy-s(GLOW_R), cx+s(GLOW_R), cy+s(GLOW_R)], fill=GLOW_COLOR)
    draw.ellipse([cx-s(CORE_INNER_R), cy-s(CORE_INNER_R), cx+s(CORE_INNER_R), cy+s(CORE_INNER_R)], fill=CORE_B)
    draw.ellipse([cx-s(CORE_INNER_SMALL_R), cy-s(CORE_INNER_SMALL_R), cx+s(CORE_INNER_SMALL_R), cy+s(CORE_INNER_SMALL_R)], fill=CORE_INNER_B)
    
    # 高光
    hx, hy = s(250), s(250)
    draw.ellipse([hx-s(HL_R), hy-s(HL_R), hx+s(HL_R), hy+s(HL_R)], fill=HL_COLOR)
    
    return img


def make_ico(images, sizes):
    """Build ICO file from [(image, size), ...]."""
    png_data = []
    for img, sz in images:
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        png_data.append(buf.getvalue())
    
    header = struct.pack('<HHH', 0, 1, len(sizes))
    directory = []
    offset = 6 + len(sizes) * 16
    
    for i, sz in enumerate(sizes):
        data = png_data[i]
        w = 0 if sz >= 256 else sz
        h = 0 if sz >= 256 else sz
        directory.append(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    
    return header + b''.join(directory) + b''.join(png_data)


def make_icns(images_dict):
    """Build ICNS file from {OSType: image} dict."""
    entries = []
    for ostype, img in images_dict.items():
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        png_bytes = buf.getvalue()
        entry = ostype.encode('ascii') + struct.pack('>I', 8 + len(png_bytes)) + png_bytes
        entries.append(entry)
    
    body = b''.join(entries)
    return b'icns' + struct.pack('>I', 8 + len(body)) + body


def main():
    print("=" * 50)
    print("司天 SiTian 图标生成 — V2-A2 超极限版")
    print("=" * 50)
    
    # 1. SVG 源文件
    svg = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#e8c66a" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#e8c66a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core" cx="50%" cy="50%">
      <stop offset="0%" stop-color="#fffbe6"/>
      <stop offset="40%" stop-color="#e8c66a"/>
      <stop offset="100%" stop-color="#b8860b"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="100" ry="100" fill="#eef1f6"/>
  <rect x="16" y="16" width="480" height="480" rx="100" ry="100" fill="none" stroke="#3a4a62" stroke-width="6"/>
  <rect x="28" y="28" width="456" height="456" rx="88" ry="88" fill="none" stroke="rgba(58,74,98,0.25)" stroke-width="1.5"/>
  <line x1="110" y1="110" x2="402" y2="110" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="110" y1="256" x2="402" y2="256" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="110" y1="402" x2="402" y2="402" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="110" y1="110" x2="110" y2="402" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="256" y1="110" x2="256" y2="402" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="402" y1="110" x2="402" y2="402" stroke="rgba(40,80,130,0.8)" stroke-width="10" stroke-linecap="round"/>
  <line x1="110" y1="110" x2="402" y2="402" stroke="rgba(100,60,140,0.6)" stroke-width="7" stroke-dasharray="12 8" stroke-linecap="round"/>
  <line x1="402" y1="110" x2="110" y2="402" stroke="rgba(100,60,140,0.6)" stroke-width="7" stroke-dasharray="12 8" stroke-linecap="round"/>
  <circle cx="256" cy="256" r="50" fill="url(#glow)"/>
  <circle cx="256" cy="256" r="24" fill="url(#core)"/>
  <circle cx="250" cy="250" r="9" fill="rgba(255,255,255,0.7)"/>
  <circle cx="110" cy="110" r="18" fill="#2a3a52"/>
  <circle cx="402" cy="110" r="18" fill="#2a3a52"/>
  <circle cx="402" cy="402" r="18" fill="#2a3a52"/>
  <circle cx="110" cy="402" r="18" fill="#2a3a52"/>
  <circle cx="256" cy="110" r="13" fill="rgba(42,58,82,0.95)"/>
  <circle cx="402" cy="256" r="13" fill="rgba(42,58,82,0.95)"/>
  <circle cx="256" cy="402" r="13" fill="rgba(42,58,82,0.95)"/>
  <circle cx="110" cy="256" r="13" fill="rgba(42,58,82,0.95)"/>
</svg>'''
    
    svg_path = OUT_DIR / "icon.svg"
    svg_path.write_text(svg, encoding='utf-8')
    print(f"[1/4] SVG 源文件 → {svg_path}")
    
    # 2. PNG 全规格
    sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    for sz in sizes:
        img = draw_icon(sz)
        path = OUT_DIR / f"icon-{sz}.png"
        img.save(str(path), format='PNG', optimize=True)
        print(f"      PNG {sz}x{sz} → {path.name}")
    print(f"[2/4] PNG 全规格 ({len(sizes)} 尺寸)")
    
    # 3. Windows ICO
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_images = [(draw_icon(sz), sz) for sz in ico_sizes]
    ico_path = OUT_DIR / "icon.ico"
    ico_path.write_bytes(make_ico(ico_images, ico_sizes))
    print(f"[3/4] Windows ICO → {ico_path}")
    
    # 4. macOS ICNS
    icns_map = {'is32': 16, 'il32': 32, 'ih32': 48, 'it32': 128, 'ic08': 256, 'ic09': 512, 'ic10': 1024}
    icns_images = {k: draw_icon(v) for k, v in icns_map.items()}
    icns_path = OUT_DIR / "icon.icns"
    icns_path.write_bytes(make_icns(icns_images))
    print(f"[4/4] macOS ICNS → {icns_path}")
    
    # 5. 清单
    manifest = {
        "name": "司天 SiTian",
        "version": "V2-A2",
        "design": "围棋星位 × 银河航道",
        "files": {
            "svg": str(svg_path),
            "ico": str(ico_path),
            "icns": str(icns_path),
            "png": {str(sz): str(OUT_DIR / f"icon-{sz}.png") for sz in sizes}
        },
        "colors": {
            "background": "#eef1f6",
            "stroke": "#3a4a62",
            "lane": "rgba(40,80,130,0.8)",
            "diagonal": "rgba(100,60,140,0.6)",
            "star": "#2a3a52",
            "core": "#e8c66a"
        }
    }
    manifest_path = OUT_DIR / "icon-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"\n清单 → {manifest_path}")
    print("=" * 50)
    print("全部完成!")
    print("=" * 50)


if __name__ == "__main__":
    main()
