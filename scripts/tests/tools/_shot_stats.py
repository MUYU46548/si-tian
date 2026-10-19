#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时件：把出图的**像素事实**打出来（本会话模型看不到图，只能用读数代替眼睛）。

用法：py -3 scripts/tests/tools/_shot_stats.py [目录]
默认扫两个故事线目录。判据只回答三件事：
  · 图里有没有东西（非背景像素占比 / 颜色数）—— 空白页/报错页一眼能看出来
  · 左侧导航树所在的列是否被盖住（卡片墙：方差极低 = 干净背景）
  · 卡片墙中下部有没有进度胶囊（亮像素数）
"""
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DIRS = [os.path.join(ROOT, 'docs', 'assets', 'story-20261017'),
        os.path.join(ROOT, 'docs', 'assets', 'story-20261017-real')]


def _var(vals):
    n = len(vals) or 1
    m = sum(vals) / n
    return sum((v - m) ** 2 for v in vals) / n


def stats(path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    small = im.resize((w // 2, h // 2))
    px = list(small.getdata())
    lum = [(r * 299 + g * 587 + b * 114) // 1000 for (r, g, b) in px]
    # 背景色 = 出现最多的量化色；非背景占比 = "图里到底有没有内容"
    buckets = {}
    for (r, g, b) in px:
        k = (r >> 4, g >> 4, b >> 4)
        buckets[k] = buckets.get(k, 0) + 1
    bg = max(buckets.items(), key=lambda kv: kv[1])
    non_bg = 1.0 - bg[1] / max(1, len(px))
    left = im.crop((0, 51, 200, h - 20))
    lp = list(left.getdata())
    llum = [(r * 299 + g * 587 + b * 114) // 1000 for (r, g, b) in lp]
    band = im.crop((max(0, w // 2 - 160), int(h * 0.84), min(w, w // 2 + 160), int(h * 0.90)))
    blum = [(r * 299 + g * 587 + b * 114) // 1000 for (r, g, b) in list(band.getdata())]
    return {
        'size': (w, h),
        'colors': len(set(px)),
        'nonBg': round(non_bg * 100, 1),
        'meanLum': round(sum(lum) / len(lum), 1),
        'leftVar': round(_var(llum), 1),
        'leftColors': len(set(lp)),
        'capsuleBright': sum(1 for v in blum if v > 90),
    }


def main():
    dirs = sys.argv[1:] or DIRS
    for d in dirs:
        if not os.path.isdir(d):
            print('（缺目录）', d)
            continue
        print('目录：', os.path.relpath(d, ROOT))
        for n in sorted(os.listdir(d)):
            if not n.endswith('.png'):
                continue
            s = stats(os.path.join(d, n))
            print(f"  {n:30s} {s['size']} 颜色{s['colors']:6d} 非背景{s['nonBg']:5.1f}% "
                  f"平均亮{s['meanLum']:6.1f} 左列方差{s['leftVar']:8.1f}/色{s['leftColors']:5d} "
                  f"胶囊亮像素{s['capsuleBright']:5d}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
