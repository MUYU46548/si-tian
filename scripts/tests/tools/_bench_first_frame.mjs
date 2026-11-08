#!/usr/bin/env node
/**
 * 首帧代价归因（只读）——回答“开一张大图为什么会卡十几秒，卡在哪一段”。
 *
 * 只量四个**产品里真实存在的纯函数**：
 *   ① `heightMath.buildClimateInputs`（离岸距离 BFS）+ `deriveLayers`（温度/降水/群系）；
 *   ② `heightmapRaster.buildHeightmapRaster`（把格网栅格化成画布底色）；
 *   ③ `coastline.buildLandMask`（按省份多边形建陆地掩膜）；
 *   ④ `provinceHitIndex`（命中索引）。
 *
 * 用法：node scripts/tests/tools/_bench_first_frame.mjs [--cells 512]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CELLS = Number(arg('cells', '512'));

async function loadViaTmp(entry) {
  const seen = new Map();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  const tmpRoot = path.join(ROOT, 'build', '.tmp-modules');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  for (const [f, src] of seen) {
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`));
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixed);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, entry)).href);
  fs.rmSync(tmp, { recursive: true, force: true });
  return mod;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ms = (fn) => { const t0 = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

async function main() {
  const HM = await loadViaTmp('heightMath.js');
  const HR = await loadViaTmp('heightmapRaster.js');
  const C = await loadViaTmp('coastline.js');
  const PHI = await loadViaTmp('provinceHitIndex.js');
  const P = await loadViaTmp('terrainParams.js');
  const PIPE = await loadViaTmp('terrainPipeline.js');

  const mkRing = (r, n = 90) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + 1.2) * 0.16 + Math.sin(a * 7 + 2.4) * 0.08;
      pts.push({ x: Math.cos(a) * r * w, y: Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };

  console.log(`首帧归因：cellsAcross=${CELLS}（产品真实函数，不另写实现）`);
  console.log('  段 | 读数');
  const cellsList = [192, 512, 768];
  for (const cells of cellsList) {
    const land = [{ id: 'p1', kind: 'land', points: mkRing(900) }];
    const mask = C.buildLandMask(land);
    const opts = { ...P.toSynthesisOptions(P.normalizeTerrainParams({ seed: 7 }).params, { isLand: mask.lookup }), cellsAcross: cells };
    const syn = PIPE.synthesizeTerrain(land, opts);
    const n = syn.h.length;
    const inputs = ms(() => HM.buildClimateInputs(syn.h, syn.grid, { latitudeSpanDeg: 120 }));
    const layers = ms(() => HM.deriveLayers(syn.h, syn.grid.points, (_p, i) => inputs.r.lat[i], (_p, i) => inputs.r.ocean[i]));
    // ⚠️ `buildHeightmapRaster` 要用 `document.createElement('canvas')`（画布底色是 drawImage 出来的），
    //    Node 里量不了 —— 这一段的读数只能在真机拿（见 `_bench_*` 上面对 shot_real_project 的用法）。
    console.log(`  ${String(cells).padStart(3)} | ${n} 格 | 气候输入 ${inputs.ms.toFixed(0)}ms | 气候派生 ${layers.ms.toFixed(0)}ms | 合计 ${(inputs.ms + layers.ms).toFixed(0)}ms`);
  }

  // 省份侧：3000 / 6000 省的掩膜与命中索引
  for (const count of [3000, 6000]) {
    const rnd = mulberry32(11);
    const cols = Math.ceil(Math.sqrt(count));
    const cell = 4000 / cols;
    const provs = [];
    for (let i = 0; i < count; i++) {
      const cx = (i % cols + 0.5) * cell, cy = (Math.floor(i / cols) + 0.5) * cell;
      const pts = [];
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * Math.PI * 2;
        const j = 0.85 + rnd() * 0.25;
        pts.push({ x: cx + Math.cos(a) * cell * 0.46 * j, y: cy + Math.sin(a) * cell * 0.46 * j });
      }
      provs.push({ id: `p${i}`, kind: 'land', points: pts });
    }
    const maskB = ms(() => C.buildLandMask(provs));
    const idxB = ms(() => PHI.buildProvinceHitIndex(provs));
    console.log(`  省份 ${count} | 陆地掩膜 ${maskB.ms.toFixed(0)}ms | 命中索引 ${idxB.ms.toFixed(0)}ms`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
