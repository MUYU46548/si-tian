#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动河流的**选项矩阵对照**（只读；2026-10-14）

为什么单列一个脚本：`--opts` 里的 JSON 在 PowerShell 里引号极难写对（实测踩过多次），
而"哪个开关真的改变了观感"必须**同输入、同口径**地比。这里把候选组合一次跑完并打表。

用法：
    python scripts/tests/tools/compare_river_opts.py --grid-json %TEMP%/desite.grid.json
    python scripts/tests/tools/compare_river_opts.py --project <file.sitian>
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from sweep_rivers import run_diag  # noqa: E402


class Args:
    def __init__(self, **kw):
        self.__dict__.update(kw)


MATRIX = [
    ('旧口径（逐个源头画到海）', {'coalesce': False}),
    ('合并（默认闸门）', {'coalesce': True}),
    ('合并 + 闸门 0', {'coalesce': True, 'cutoffQuantile': 0}),
    ('合并 + 闸门 0.5', {'coalesce': True, 'cutoffQuantile': 0.5}),
    ('合并 + 源头离海 ≥3 格', {'coalesce': True, 'sourceInlandCells': 3}),
    ('合并 + 源头高度 >70', {'coalesce': True, 'sourceHeight': 70}),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grid-json', dest='grid_json', default=None)
    ap.add_argument('--project', default=os.path.join(os.path.expanduser('~'), 'Documents', 'SiTianProjects', '绒花计划.sitian'))
    ap.add_argument('--planet', default=None)
    ap.add_argument('--basemap', default=None)
    ap.add_argument('--upsample', type=int, default=1)
    args = ap.parse_args()
    a = Args(grid_json=args.grid_json, project=args.project, planet=args.planet, basemap=args.basemap)

    headers = ['方案', '河数', '丢弃', '贴岸源头', 'maxFlow', '中位长', '最长', '最长(世界)', '河口簇', '挤一起', 'ms']
    print(' | '.join(h.ljust(12) for h in headers))
    print('-' * (15 * len(headers)))
    for label, opts in MATRIX:
        data, err = run_diag(a, opts, args.upsample)
        if err or not data or not data.get('datasets'):
            print(f'{label} | ⚠️ {(err or "no-data")[:160]}')
            continue
        for ds in data['datasets']:
            v = ds['variants'][0]
            row = [label, v['rivers'], v['dropped'], v['coastSources'], v['maxFlow'],
                   v['lenPct']['p50'], v['lenPct']['max'], v['lenWorld']['max'],
                   v['mouthClusters'], v['crowdedMouths'], v['elapsedMs']]
            print(' | '.join(str(x).ljust(12) for x in row))
    return 0


if __name__ == '__main__':
    sys.exit(main())
