#!/usr/bin/env python3
"""Generate high-res icons from the SVG using Pillow (no cairosvg needed)."""
import struct
import zlib
from PIL import Image, ImageDraw, ImageFont
import math

def create_icon_image(size):
    """Render SiTian icon to PIL Image."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Colors
    bg_dark = (13, 17, 23, 255)
    grid_blue = (88, 166, 255, 230)
    grid_purple = (163, 113, 247, 180)
    gold_light = (255, 251, 230, 255)
    gold_mid = (232, 198, 106, 255)
    gold_dark = (184, 134, 11, 255)
    node_bg = (33, 38, 45, 255)
    border = (48, 54, 61, 255)
    
    # Scale factor (svg viewBox is 512x512)
    s = size / 512
    
    # Background with rounded corners
    def rounded_rect(draw, xy, radius, fill):
        x0, y0, x1, y1 = xy
        r = radius
        draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
        draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
        draw.pieslice([x0, y0, x0 + 2*r, y0 + 2*r], 180, 270, fill=fill)
        draw.pieslice([x1 - 2*r, y0, x1, y0 + 2*r], 270, 360, fill=fill)
        draw.pieslice([x0, y1 - 2*r, x0 + 2*r, y1], 90, 180, fill=fill)
        draw.pieslice([x1 - 2*r, y1 - 2*r, x1, y1], 0, 90, fill=fill)
    
    rounded_rect(draw, (0, 0, size-1, size-1), int(96*s), bg_dark)
    
    # Grid lines
    def line(x1, y1, x2, y2, color, width):
        w = max(1, int(width * s))
        draw.line([(x1*s, y1*s), (x2*s, y2*s)], fill=color, width=w)
    
    # Horizontal
    line(60, 60, 452, 60, grid_blue, 12)
    line(60, 256, 452, 256, grid_blue, 12)
    line(60, 452, 452, 452, grid_blue, 12)
    # Vertical
    line(60, 60, 60, 452, grid_blue, 12)
    line(256, 60, 256, 452, grid_blue, 12)
    line(452, 60, 452, 452, grid_blue, 12)
    # Diagonals (dashed not easy, just solid)
    line(60, 60, 452, 452, grid_purple, 8)
    line(452, 60, 60, 452, grid_purple, 8)
    
    # Corner nodes
    def circle(cx, cy, r, fill, outline=None):
        r = int(r * s)
        draw.ellipse([cx*s - r, cy*s - r, cx*s + r, cy*s + r], fill=fill, outline=outline, width=max(1, int(2*s)))
    
    # Corner stars
    circle(60, 60, 20, node_bg, grid_blue)
    circle(452, 60, 20, node_bg, grid_blue)
    circle(452, 452, 20, node_bg, grid_blue)
    circle(60, 452, 20, node_bg, grid_blue)
    # Edge stars
    circle(256, 60, 14, node_bg, grid_blue)
    circle(452, 256, 14, node_bg, grid_blue)
    circle(256, 452, 14, node_bg, grid_blue)
    circle(60, 256, 14, node_bg, grid_blue)
    
    # Center glow
    circle(256, 256, 56, (232, 198, 106, 80))
    # Center core
    circle(256, 256, 28, gold_mid)
    circle(256, 256, 16, gold_light)
    # Specular highlight
    circle(250, 250, 10, (255, 255, 255, 200))
    
    return img

def save_ico(images, path):
    """Save multi-size ICO file."""
    # ICO header
    num = len(images)
    header = struct.pack('<HHH', 0, 1, num)
    
    # Image data
    data = b''
    offset = 6 + num * 16  # header + directory
    
    directory = b''
    for size, img in images:
        # Convert to BGRA
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        raw = img.tobytes()
        # PNG compression for each size
        import io
        png_io = io.BytesIO()
        img.save(png_io, format='PNG')
        png_data = png_io.getvalue()
        
        directory += struct.pack('<BBBBHHII', 
            size if size < 256 else 0, size if size < 256 else 0,
            0, 0, 1, 32, len(png_data), offset)
        data += png_data
        offset += len(png_data)
    
    with open(path, 'wb') as f:
        f.write(header + directory + data)

# Generate PNGs
sizes = [16, 32, 48, 64, 128, 256, 512]
for sz in sizes:
    img = create_icon_image(sz)
    img.save(f'E:/CODE/CangKu/SiTian/build/icon-{sz}.png')
    print(f'Generated icon-{sz}.png')

# Generate ICO (multi-resolution)
ico_sizes = [16, 32, 48, 64, 128, 256]
images = [(sz, create_icon_image(sz)) for sz in ico_sizes]
save_ico(images, 'E:/CODE/CangKu/SiTian/build/icon.ico')
print(f'Generated icon.ico ({len(ico_sizes)} sizes)')

# Also save a 1024 version
img = create_icon_image(1024)
img.save('E:/CODE/CangKu/SiTian/build/icon-1024.png')
print('Generated icon-1024.png')
