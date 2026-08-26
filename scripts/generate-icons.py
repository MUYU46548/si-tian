#!/usr/bin/env python3
"""Generate SiTian icon — light background, BOLD grid filling most space."""
import struct
from PIL import Image, ImageDraw

def create_icon_image(size):
    """Render SiTian icon: light bg + bold dark grid + large nodes."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    s = size / 512
    
    # Light background fills ENTIRE icon
    bg = (238, 241, 246, 255)  # #eef1f6
    draw.rectangle([0, 0, size-1, size-1], fill=bg)
    
    # Subtle border at edge
    draw.rectangle([0, 0, size-1, size-1], outline=(58, 74, 98, 180), width=max(1, int(4*s)))
    
    # Dark grid + nodes
    grid_blue = (40, 80, 130, 180)
    grid_purple = (100, 60, 140, 130)
    gold = (232, 198, 106, 255)
    gold_light = (255, 251, 230, 255)
    dark = (42, 58, 82, 255)
    
    # Grid lines: THICK (24px) and spanning 16-496 (94% coverage)
    def line(x1, y1, x2, y2, color, width):
        w = max(1, int(width * s))
        draw.line([(x1*s, y1*s), (x2*s, y2*s)], fill=color, width=w)
    
    # Horizontal
    line(16, 16, 496, 16, grid_blue, 24)
    line(16, 256, 496, 256, grid_blue, 24)
    line(16, 496, 496, 496, grid_blue, 24)
    # Vertical
    line(16, 16, 16, 496, grid_blue, 24)
    line(256, 16, 256, 496, grid_blue, 24)
    line(496, 16, 496, 496, grid_blue, 24)
    # Diagonals
    line(16, 16, 496, 496, grid_purple, 10)
    line(496, 16, 16, 496, grid_purple, 10)
    
    # Corner nodes (LARGE — r=36 so they overlap with grid ends)
    def circle(cx, cy, r, fill):
        r = int(r * s)
        draw.ellipse([cx*s - r, cy*s - r, cx*s + r, cy*s + r], fill=fill)
    
    # Corner stars (big)
    circle(16, 16, 36, dark)
    circle(496, 16, 36, dark)
    circle(496, 496, 36, dark)
    circle(16, 496, 36, dark)
    # Edge stars (midpoints)
    circle(256, 16, 24, dark)
    circle(496, 256, 24, dark)
    circle(256, 496, 24, dark)
    circle(16, 256, 24, dark)
    
    # Center: glow + core + specular
    circle(256, 256, 50, (232, 198, 106, 90))
    circle(256, 256, 26, gold)
    circle(256, 256, 16, gold_light)
    circle(250, 250, 9, (255, 255, 255, 200))
    
    return img

def save_ico(images, path):
    num = len(images)
    header = struct.pack('<HHH', 0, 1, num)
    data = b''
    offset = 6 + num * 16
    directory = b''
    for size, img in images:
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

sizes = [16, 32, 48, 64, 128, 256, 512]
for sz in sizes:
    img = create_icon_image(sz)
    img.save(f'E:/CODE/CangKu/SiTian/build/icon-{sz}.png')
    print(f'icon-{sz}.png')

ico_sizes = [16, 32, 48, 64, 128, 256]
images = [(sz, create_icon_image(sz)) for sz in ico_sizes]
save_ico(images, 'E:/CODE/CangKu/SiTian/build/icon.ico')
print('icon.ico')

img = create_icon_image(1024)
img.save('E:/CODE/CangKu/SiTian/build/icon-1024.png')
print('icon-1024.png')
