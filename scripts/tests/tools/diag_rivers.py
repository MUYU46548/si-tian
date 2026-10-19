#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""河流/地形**实测诊断**（只读；2026-10-14）

用途：把「河流长得自不自然」「高度图分辨率够不够」这类**观感问题**换成可比较的数字。
不跑 CDP、不开 Electron —— 直接读高度图，用**产品同一份纯函数**算一遍。

用法：
    # 真实项目文件（行星 / 底图）
    python scripts/tests/tools/diag_rivers.py [--project <file.sitian>] [--planet 名] [--basemap 名]

    # 从 FMG .map 抽出来的网格（先跑 extract_map_grid.mjs）
    python scripts/tests/tools/diag_rivers.py --grid-json %TEMP%/desite.grid.json

    # 只量"分辨率提高后会怎样"：先把高度图重采样再量
    python scripts/tests/tools/diag_rivers.py --grid-json X.json --upsample 2 --compare

    # 扫一遍河源闸门（看条数/长度随阈值怎么变）
    python scripts/tests/tools/diag_rivers.py --grid-json X.json --sweep channelInit=1,2,3,5

    # 任意 traceRivers 选项
    python scripts/tests/tools/diag_rivers.py --grid-json X.json --opts '{"sourceHeight":40}'

为什么不放 CDP 用例里：本工具是**量尺**，不是守卫。守卫要的是"不许退化"（test_103 /
test_river_coastline.js），量尺要的是"现在到底是多少、改完差多少"。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SRC_UTILS = os.path.join(ROOT, 'src', 'renderer', 'src', 'utils')
DEFAULT_PROJECT = os.path.join(os.path.expanduser('~'), 'Documents', 'SiTianProjects', '绒花计划.sitian')
PURE_FILES = ('riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js')


def build_esm_tmp():
    """把纯函数层拷到临时 ESM 目录（与 Node 单测同一套做法：仓内 import 不带扩展名）"""
    tmp = tempfile.mkdtemp(prefix='sitian-diag-')
    for f in PURE_FILES:
        src = os.path.join(SRC_UTILS, f)
        if not os.path.exists(src):
            continue
        code = re.sub(r"from '\./([A-Za-z0-9_-]+)'", r"from './\1.js'", open(src, encoding='utf-8').read())
        with open(os.path.join(tmp, f), 'w', encoding='utf-8') as fh:
            fh.write(code)
    with open(os.path.join(tmp, 'package.json'), 'w', encoding='utf-8') as fh:
        fh.write('{"type":"module"}')
    return tmp


JS = r'''
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const [tmpDir, cfgPath] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const R = await import(pathToFileURL(path.join(tmpDir, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmpDir, 'coastline.js')).href);
const A = await import(pathToFileURL(path.join(tmpDir, 'heightmapAccess.js')).href);

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const hist = (arr, edges) => {
  const out = edges.map((e) => ({ le: e, n: 0 }));
  for (const v of arr) { const i = edges.findIndex((e) => v <= e); out[i < 0 ? out.length - 1 : i].n++; }
  return out;
};

/** 双线性重采样（诊断用；与将来产品化的口径要对齐） */
function resample(hm, factor) {
  if (!(factor > 1)) return hm;
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY, sp = hm.grid.spacing || 14.4;
  const p0 = hm.grid.points[0];
  const x0 = Array.isArray(p0) ? p0[0] : p0.x, y0 = Array.isArray(p0) ? p0[1] : p0.y;
  const nc = (cols - 1) * factor + 1, nr = (rows - 1) * factor + 1;
  const nsp = sp / factor;
  const points = new Array(nc * nr);
  const h = new Float64Array(nc * nr);
  const chans = {};
  for (const k of ['temp', 'prec']) if (hm[k]) chans[k] = new Float64Array(nc * nr);
  if (hm.biome) chans.biome = new Uint8Array(nc * nr);
  const sample = (arr, fx, fy) => {
    const x = Math.min(cols - 1 - 1e-9, Math.max(0, fx)), y = Math.min(rows - 1 - 1e-9, Math.max(0, fy));
    const i = Math.floor(x), j = Math.floor(y), tx = x - i, ty = y - j;
    const a = arr[j * cols + i], b = arr[j * cols + i + 1], c = arr[(j + 1) * cols + i], d = arr[(j + 1) * cols + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      const i = r * nc + c;
      points[i] = [x0 + c * nsp, y0 + r * nsp];
      h[i] = sample(hm.h, c / factor, r / factor);
      for (const k of Object.keys(chans)) {
        chanSample: {
          if (k === 'biome') { // 最近邻（分类量不能插值）
            const fx = Math.round(c / factor), fy = Math.round(r / factor);
            chans.biome[i] = hm.biome[Math.min(rows - 1, fy) * cols + Math.min(cols - 1, fx)];
            break chanSample;
          }
          chans[k][i] = sample(hm[k], c / factor, r / factor);
        }
      }
    }
  }
  return { h, grid: { points, spacing: nsp, cellsX: nc, cellsY: nr, count: nc * nr }, ...chans };
}

const loadDatasets = () => {
  if (cfg.gridJson) {
    const g = JSON.parse(fs.readFileSync(cfg.gridJson, 'utf8'));
    return [{ kind: 'map', name: g.source || path.basename(cfg.gridJson), hm: { h: g.h, grid: g.grid }, terrain: g.landFeatures || [] }];
  }
  const proj = JSON.parse(fs.readFileSync(cfg.project, 'utf8'));
  const maps = proj.maps || {};
  const md = maps.mapData || {};
  const bms = maps.baseMaps || (maps.editor && maps.editor.baseMaps) || {};
  const out = [];
  for (const [k, v] of Object.entries(md)) {
    if (v && v.heightmap && v.heightmap.grid) out.push({ kind: 'planet', name: k, hm: v.heightmap, terrain: v.terrain || [] });
  }
  for (const [k, v] of Object.entries(bms)) {
    if (!v) continue;
    let hm = v.heightmap;
    if (!hm && v.planetId && md[v.planetId]) hm = md[v.planetId].heightmap;
    if (hm && hm.grid) out.push({ kind: 'basemap', name: k, hm, terrain: v.terrain || [] });
  }
  return out;
};

/** 离海距离场（BFS，按陆地掩膜；没有掩膜时按高度阈值） */
function seaDist(h, grid, isLand) {
  const n = h.length, cols = grid.cellsX, rows = grid.cellsY;
  const sp = grid.spacing || 14.4;
  const p0 = grid.points[0];
  const x0 = Array.isArray(p0) ? p0[0] : p0.x, y0 = Array.isArray(p0) ? p0[1] : p0.y;
  const d = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = grid.points[i];
    const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y;
    land[i] = isLand ? (isLand(x, y) ? 1 : 0) : (h[i] >= 20 ? 1 : 0);
    if (!land[i]) { d[i] = 0; q[qt++] = i; }
  }
  const step = Math.max(1, Math.round(sp / sp));
  while (qh < qt) {
    const i = q[qh++];
    const ci = i % cols, cj = (i - ci) / cols;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dx, dy] of nb) {
      const a = ci + dx, b = cj + dy;
      if (a < 0 || a >= cols || b < 0 || b >= rows) continue;
      const j = b * cols + a;
      if (d[j] !== -1) continue;
      d[j] = d[i] + 1;
      q[qt++] = j;
    }
  }
  return { d, land, x0, y0, sp, cols, rows };
}

const out = { mode: cfg.gridJson ? 'grid-json' : 'project', datasets: [] };
for (const ds of loadDatasets()) {
  if (cfg.planet && ds.kind === 'planet' && ds.name !== cfg.planet) continue;
  if (cfg.basemap && ds.kind === 'basemap' && ds.name !== cfg.basemap) continue;

  const hm0 = resample(ds.hm, cfg.upsample || 1);
  const mask = (ds.terrain && ds.terrain.length) ? C.buildLandMask(ds.terrain) : null;
  const sd = seaDist(hm0.h, hm0.grid, mask ? mask.lookup : null);
  const landIdx = [];
  for (let i = 0; i < sd.land.length; i++) if (sd.land[i]) landIdx.push(i);
  const dists = landIdx.map((i) => sd.d[i]);

  const rec = {
    kind: ds.kind, name: ds.name,
    cells: hm0.h.length, cellsX: hm0.grid.cellsX, cellsY: hm0.grid.cellsY, spacing: hm0.grid.spacing,
    upsample: cfg.upsample || 1,
    landCells: landIdx.length, seaCells: hm0.h.length - landIdx.length,
    maskRings: mask ? mask.ringCount : 0,
    landDistCells: { p50: pct(dists, 0.5), p90: pct(dists, 0.9), p99: pct(dists, 0.99), max: Math.max(0, ...dists) },
    landDistWorld: { p50: Math.round(pct(dists, 0.5) * hm0.grid.spacing), p90: Math.round(pct(dists, 0.9) * hm0.grid.spacing),
                     p99: Math.round(pct(dists, 0.99) * hm0.grid.spacing), max: Math.round(Math.max(0, ...dists) * hm0.grid.spacing) },
    landDistHist: hist(dists, [0, 1, 2, 3, 5, 10, 20, 50, 1e9]),
  };

  const variants = cfg.sweep ? cfg.sweep : [{}];
  rec.variants = [];
  for (const extra of variants) {
    const opts = Object.assign({}, cfg.opts || {}, extra, mask ? { isLand: mask.lookup } : {});
    const t = R.traceRivers(hm0, opts);
    const lens = t.rivers.map((x) => x.points.length);
    const flows = t.rivers.map((x) => x.flow);
    const wl = t.rivers.map((rr) => {
      let s = 0;
      for (let i = 0; i + 1 < rr.points.length; i++) s += Math.hypot(rr.points[i + 1].x - rr.points[i].x, rr.points[i + 1].y - rr.points[i].y);
      return s;
    });
    const mouths = t.rivers.map((x) => x.points[x.points.length - 1]);
    const bkt = new Map();
    for (const m of mouths) {
      const k = Math.round(m.x / (hm0.grid.spacing * 6)) + ',' + Math.round(m.y / (hm0.grid.spacing * 6));
      bkt.set(k, (bkt.get(k) || 0) + 1);
    }
    let crowded = 0;
    for (const v of bkt.values()) if (v > 1) crowded += v - 1;
    rec.variants.push({
      label: JSON.stringify(extra),
      rivers: t.rivers.length, sources: t.sources, dropped: t.dropped, coastSources: t.coastSources,
      maxFlow: t.maxFlow, truncated: t.truncated, elapsedMs: Math.round(t.elapsedMs),
      lenPct: { p50: pct(lens, 0.5), p90: pct(lens, 0.9), max: Math.max(0, ...lens) },
      flowPct: { p50: pct(flows, 0.5), p90: pct(flows, 0.9), max: Math.max(0, ...flows) },
      lenWorld: { p50: Math.round(pct(wl, 0.5)), p90: Math.round(pct(wl, 0.9)), max: Math.round(Math.max(0, ...wl)) },
      lenHist: hist(lens, [2, 3, 5, 10, 20, 50, 100, 1e9]),
      mouthClusters: bkt.size, crowdedMouths: crowded,
    });
  }
  out.datasets.push(rec);
}
console.log(JSON.stringify(out));
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default=DEFAULT_PROJECT)
    ap.add_argument('--grid-json', dest='grid_json', default=None)
    ap.add_argument('--planet', default=None)
    ap.add_argument('--basemap', default=None)
    ap.add_argument('--opts', default=None, help='traceRivers 额外选项（JSON）')
    ap.add_argument('--upsample', type=int, default=1, help='先把高度图双线性重采样 N 倍再量（只影响本次诊断）')
    ap.add_argument('--sweep', default=None, help='扫参数：channelInit=1,2,3,5')
    args = ap.parse_args()

    if not args.grid_json and not os.path.exists(args.project):
        print(f'找不到项目文件：{args.project}', file=sys.stderr)
        return 2

    variants = [{}]
    if args.sweep:
        key, _, vals = args.sweep.partition('=')
        variants = [{key: float(v) if '.' in v else int(v)} for v in vals.split(',') if v.strip()]

    cfg = {
        'project': args.project, 'gridJson': args.grid_json,
        'planet': args.planet, 'basemap': args.basemap,
        'opts': json.loads(args.opts) if args.opts else {},
        'upsample': args.upsample, 'sweep': variants,
    }
    tmp = build_esm_tmp()
    js_path = os.path.join(tmp, 'diag.mjs')
    with open(js_path, 'w', encoding='utf-8') as fh:
        fh.write(JS)
    cfg_path = os.path.join(tmp, 'cfg.json')
    with open(cfg_path, 'w', encoding='utf-8') as fh:
        json.dump(cfg, fh)
    r = subprocess.run(['node', js_path, tmp, cfg_path], capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        return r.returncode
    # 中文名在 Windows 控制台可能不是 UTF-8：全部转义成 ASCII 再输出（内容一字不差）
    try:
        data = json.loads(r.stdout)
        print(json.dumps(data, ensure_ascii=True, indent=2))
    except Exception:
        print(r.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
