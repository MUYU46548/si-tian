#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S0 截图差分（不是回归用例）：把「这一笔画了多大一块」量出来。

用途：`_probe_brush_matrix.py` 为每个工具留了 `<id>-before.png` / `<id>.png`。
本脚本用 Pillow/numpy 比较两张图，输出：
  · 变化像素数 / 占画布比例
  · 变化区域包围盒（左上/右下）
  · 变化区域的平均颜色（判断是不是“涂上了色”而不是只闪了一下光标）

运行（必须用带 Pillow/numpy 的运行时）：
    <bundled python> scripts/tests/tools/_diff_shots.py [目录]
默认目录：docs/assets/s0-brush-20261019
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
DEFAULT_DIR = os.path.join(ROOT, 'docs', 'assets', 's0-brush-20261019')


def diff_pair(before_path, after_path, threshold=24):
    a = np.asarray(Image.open(before_path).convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(after_path).convert('RGB'), dtype=np.int16)
    if a.shape != b.shape:
        return {'error': '尺寸不一致：%s vs %s' % (a.shape, b.shape)}
    d = np.abs(a - b).sum(axis=2)
    mask = d > threshold
    n = int(mask.sum())
    h, w = mask.shape
    out = {'changedPixels': n, 'canvasPixels': h * w, 'ratio': round(n / (h * w), 5)}
    if n:
        ys, xs = np.where(mask)
        out['bbox'] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        out['meanColorAfter'] = [int(v) for v in b[mask].mean(axis=0).round()]
        out['meanColorBefore'] = [int(v) for v in a[mask].mean(axis=0).round()]
        out['delta'] = [int(x) for x in (b[mask].mean(axis=0) - a[mask].mean(axis=0)).round()]
    return out


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    if not os.path.isdir(d):
        raise SystemExit('目录不存在：%s' % d)
    out = {}
    for name in sorted(os.listdir(d)):
        if not name.endswith('.png') or name.endswith('-before.png') or name.startswith('00-'):
            continue
        tid = name[:-4]
        before = os.path.join(d, tid + '-before.png')
        if not os.path.exists(before):
            continue
        out[tid] = diff_pair(before, os.path.join(d, name))
    print(json.dumps(out, ensure_ascii=False, indent=1))
    with open(os.path.join(d, 'diff.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
