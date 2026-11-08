#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""像素基线两张 PNG 的**量的**差分（不是回归用例，别拿它当判据）。

为什么单独一个脚本：`drill_scenario_pixels.py --compare` 只回答"哈希一不一样"，
而"改了渲染的批处理之后到底变了什么"需要三个数：
  · 变了多少像素 / 最大通道差是多少（区分"抗锯齿噪声"与"真改了观感"）
  · 差异是不是**只落在描边/河线上**（按差异像素的颜色差分布看）
  · 一张放大 4 倍的差异热图（人眼复核用）

⚠️ 纪律（AGENTS.md，2026-11-08 踩过两次）：PNG 的像素口径按 IHDR 的 `colorType` 取
（CDP 截图 = 2/RGB 3 字节，`canvas.toDataURL` = 6/RGBA 4 字节）。这里交给 Pillow，
它读 IHDR 自己判 —— 不要再手写 `reshape`。

用法：
  <python> scripts/tests/tools/diff_pixel_baseline.py build/pixel-baseline/v20261108k.png build/pixel-baseline/v20261108l.png
产物：控制台读数 + build/pixel-baseline/diff-<a>-<b>.png（差异热图，放大 4 倍）
"""
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def head(src):
    return Image.open(src)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    a_path, b_path = sys.argv[1], sys.argv[2]
    ia, ib = head(a_path), head(b_path)
    print('A: %s  %s %s mode=%s' % (os.path.basename(a_path), ia.size, ia.format, ia.mode))
    print('B: %s  %s %s mode=%s' % (os.path.basename(b_path), ib.size, ib.format, ib.mode))
    if ia.size != ib.size:
        print('🔴 尺寸不一致，先查机位/画布大小')
        return 1
    a = np.asarray(ia.convert('RGB'), dtype=np.int16)
    b = np.asarray(ib.convert('RGB'), dtype=np.int16)
    d = np.abs(a - b)
    ch = d.max(axis=2)
    changed = int((ch > 0).sum())
    total = ch.size
    out = {
        'changedPixels': changed,
        'canvasPixels': int(total),
        'ratioPct': round(100.0 * changed / total, 4),
        'meanChannelDiff': round(float(d.mean()), 3),
        'maxChannelDiff': int(ch.max()),
        'p50ChannelDiff': int(np.percentile(ch, 50)),
        'p99ChannelDiff': int(np.percentile(ch, 99)),
        'pixelsDiffGt8': int((ch > 8).sum()),
        'pixelsDiffGt32': int((ch > 32).sum()),
    }
    print(out)
    if changed:
        ys, xs = np.where(ch > 0)
        print('bbox =', [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())])
    # 差异热图：把 B 压暗，差异处标红，再放大 4 倍（人眼能看到"是不是整片变了"）
    heat = (b * 0.25).astype(np.uint8)
    heat[ch > 0] = [255, 40, 40]
    im = Image.fromarray(heat).resize((ia.size[0] * 4, ia.size[1] * 4), Image.NEAREST)
    outp = os.path.join(ROOT, 'build', 'pixel-baseline',
                        'diff-%s-%s.png' % (os.path.basename(a_path)[:-4], os.path.basename(b_path)[:-4]))
    im.save(outp)
    print('热图 →', os.path.relpath(outp, ROOT))
    # 非 0 = 有差异（这是"量的答案"，不是"过没过"；过没过看 drill 的 --compare）
    return 0


if __name__ == '__main__':
    sys.exit(main())
