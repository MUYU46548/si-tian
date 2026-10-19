#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""参数扫描：把 diag_rivers.py 的多组选项一次跑完并打成一张对照表（只读）。

用法：
    python scripts/tests/tools/diag_rivers.py --grid-json X.json   # 先确认能跑
    python scripts/tests/tools/sweep_rivers.py --grid-json X.json --param sourceHeight=30,40,60,80
    python scripts/tests/tools/sweep_rivers.py --grid-json X.json --param sourceInlandCells=0,1,2,3 --param neighborFactor=1.5,2,3
    python scripts/tests/tools/sweep_rivers.py --grid-json X.json --upsample 1,2,3 --param channelInit=1,4,16

为什么单列一个工具：量尺要能"一眼看出哪个参数在起作用"。逐个手敲会漏，而且
`--opts` 里的 JSON 在 PowerShell 里引号极难写对（实测踩过）。
"""
import argparse
import itertools
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIAG = os.path.join(HERE, 'diag_rivers.py')


def run_diag(args, opts, upsample):
    cmd = [sys.executable, DIAG, '--opts', json.dumps(opts), '--upsample', str(upsample)]
    if args.grid_json:
        cmd += ['--grid-json', args.grid_json]
    else:
        cmd += ['--project', args.project]
    if args.planet:
        cmd += ['--planet', args.planet]
    if args.basemap:
        cmd += ['--basemap', args.basemap]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        return None, (r.stdout or '') + (r.stderr or '')
    try:
        return json.loads(r.stdout), None
    except Exception as e:
        return None, f'解析失败：{e}\n{r.stdout[:800]}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grid-json', dest='grid_json', default=None)
    ap.add_argument('--project', default=os.path.join(os.path.expanduser('~'), 'Documents', 'SiTianProjects', '绒花计划.sitian'))
    ap.add_argument('--planet', default=None)
    ap.add_argument('--basemap', default=None)
    ap.add_argument('--param', action='append', default=[], help='name=v1,v2,...（可重复）')
    ap.add_argument('--upsample', default=None, help='1,2,3（可多值）')
    args = ap.parse_args()

    names, values = [], []
    for spec in args.param:
        k, _, v = spec.partition('=')
        names.append(k)
        vals = []
        for x in v.split(','):
            x = x.strip()
            if not x:
                continue
            if x.lower() in ('true', 'false'):
                vals.append(x.lower() == 'true')
            elif '.' in x:
                vals.append(float(x))
            else:
                vals.append(int(x))
        values.append(vals)
    if not names:
        names, values = ['channelInit'], [[1, 2, 4, 8, 16, 32]]
    ups = [int(x) for x in args.upsample.split(',')] if args.upsample else [1]

    combos = list(itertools.product(*values))
    rows = []
    errors = []
    for up in ups:
        for combo in combos:
            opts = dict(zip(names, combo))
            if 'upsample' in opts:
                up = int(opts.pop('upsample'))
            data, err = run_diag(args, opts, up)
            if err or not data or not data.get('datasets'):
                errors.append((up, opts, (err or 'no-datasets')[:300]))
                continue
            for ds in data['datasets']:
                v = ds['variants'][0]
                rows.append({
                    'up': up, 'name': ds['name'], **opts,
                    'cells': ds['cells'], 'land': ds['landCells'], 'maxDist': ds['landDistCells']['max'],
                    'rivers': v['rivers'], 'coastSrc': v['coastSources'], 'dropped': v['dropped'],
                    'maxFlow': v['maxFlow'],
                    'lenP50': v['lenPct']['p50'], 'lenMax': v['lenPct']['max'],
                    'worldP50': v['lenWorld']['p50'], 'worldMax': v['lenWorld']['max'],
                    'mouthClusters': v['mouthClusters'], 'crowded': v['crowdedMouths'],
                    'ms': v['elapsedMs'],
                })

    headers = ['up'] + names + ['cells', 'land', 'maxDist', 'rivers', 'coastSrc', 'dropped', 'maxFlow',
                                'lenP50', 'lenMax', 'worldP50', 'worldMax', 'mouthClusters', 'crowded', 'ms']
    print(' | '.join(h.ljust(8) for h in headers))
    print('-' * (11 * len(headers)))
    for row in rows:
        print(' | '.join(str(row.get(h, '')).ljust(8) for h in headers))
    for e in errors:
        print(f'⚠️ {e}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
