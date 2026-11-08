#!/usr/bin/env node
/**
 * **河网密度审计（只读）**——回答“多少条河算合理 / 阈值与格子尺度是怎么耦合的”。
 *
 * 用法：
 *   node scripts/tests/tools/_audit_river_density.mjs [<项目.sitian>] [key] [--spacing N]
 *
 * 做三件事：
 *   ① 把“一格的水 = 多少 flux”算出来，与默认 `minFlux = 30` 对比 ——
 *      如果一格就过闸，那阈值等于没设（本项目 2026-11-08 的实测就是这个）；
 *   ② 同一份高度图上扫 `minFlux` / `minDrainageArea` 两档，给出河数 / 覆盖格 / 每千格河数；
 *   ③ 把高度图按 `--spacing` 抽稀重采样，看“同一块地形换个格距，河数怎么变”。
 *
 * 判据口径与产品一致：`buildRiverNetwork` 是唯一实现（这里只调它，不复写逻辑）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--') || (i === 0 && !a.startsWith('--')));

function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
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
  return seen;
}

async function loadRivers() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-rivdensity-'));
  for (const [f, src] of collectDeps(['fmg/rivers.js'])) {
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return import(pathToFileURL(path.join(tmp, 'fmg', 'rivers.js')).href);
}

// 项目路径**必须由调用方给**（仓里不写用户的私人项目名 —— 隐私扫描会红）。
// 例：node scripts/tests/tools/_audit_river_density.mjs "%USERPROFILE%\Documents\SiTianProjects\<项目>.sitian"
const project = args[0] && !args[0].startsWith('--') ? args[0] : '';
if (!project || !fs.existsSync(project)) {
  console.error('用法：node scripts/tests/tools/_audit_river_density.mjs <项目.sitian> [底图 key]');
  console.error('  项目里有高度图才量得出来（真实项目最容易对上“用户此刻看到的”那份）。');
  process.exit(2);
}

const j = JSON.parse(fs.readFileSync(project, 'utf8'));
const baseMaps = (j.scenarios || {}).baseMaps || {};
// 选“陆地格最多”的那张底图（= 用户真正在看的那张）
let best = null;
for (const [key, bm] of Object.entries(baseMaps)) {
  const hm = bm && bm.heightmap;
  if (!hm || !Array.isArray(hm.h) || !hm.grid) continue;
  const n = hm.h.length;
  if (!best || n > best.n) best = { key, hm, n };
}
if (!best) { console.error('项目里没有带高度图的底图'); process.exit(2); }
console.log(`项目：${path.basename(project)}  底图：${best.key}`);

const SEA = 20;
function summarize(hm, label) {
  const n = hm.h.length;
  const land = hm.h.filter((v) => v >= SEA).length;
  return { n, land, label };
}

function report(R, hm, { minFlux, minDrainageArea, minSourceRise, label }) {
  const opts = {};
  if (Number.isFinite(minFlux)) opts.minFlux = minFlux;
  if (Number.isFinite(minDrainageArea)) opts.minDrainageArea = minDrainageArea;
  if (Number.isFinite(minSourceRise)) opts.minSourceRise = minSourceRise;
  const t0 = Date.now();
  const net = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, prec: hm.prec, lakes: hm.lakes }, opts);
  const ms = Date.now() - t0;
  const cells = new Set();
  let longest = 0;
  for (const rv of net.rivers) {
    longest = Math.max(longest, rv.cells.length);
    for (const c of rv.cells) cells.add(c);
  }
  const land = hm.h.filter((v) => v >= SEA).length;
  const per1000 = land ? (net.rivers.length / land) * 1000 : 0;
  console.log(
    `  ${label.padEnd(26)} 河 ${String(net.rivers.length).padStart(5)} 条`
    + ` | 覆盖 ${String(cells.size).padStart(6)} 格 (${(100 * cells.size / Math.max(1, land)).toFixed(0)}% 陆地)`
    + ` | 每千格 ${per1000.toFixed(1).padStart(6)}`
    + ` | 最长 ${String(longest).padStart(3)} 格`
    + ` | ${ms}ms`,
  );
  return { rivers: net.rivers.length, cells: cells.size, land, per1000, longest, ms };
}

const R = await loadRivers();
const hm = best.hm;
const n = hm.h.length;
const spacing = Number(hm.grid.spacing) || 8;
const cols = hm.grid.cellsX | 0;
const rows = hm.grid.cellsY | 0;
const landCount = hm.h.filter((v) => v >= SEA).length;
const cellModifier = Math.max(0.2, Math.pow(n / 10000, 0.25));
let meanPrec = 50;
if (Array.isArray(hm.prec) && hm.prec.length === n) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (hm.h[i] >= SEA) { sum += hm.prec[i]; cnt++; }
  if (cnt && sum / cnt > 1e-6) meanPrec = sum / cnt;
} else {
  meanPrec = 50;
}
const perCellFlux = meanPrec / cellModifier;
console.log(`\n【① 尺度】格 ${cols}×${rows} = ${n} 格 · 陆地 ${landCount} · 格距 ${spacing} · cellModifier ${cellModifier.toFixed(3)}`);
console.log(`        降水均值 ${meanPrec.toFixed(1)} → 一格的水 = ${perCellFlux.toFixed(1)} flux，默认 minFlux = 30`);
console.log(`        ${perCellFlux > 30 ? '🔴 一格就过闸 → 阈值等于没设，每一条山脊都会起一条河' : '✅ 至少要约 ' + (30 / perCellFlux).toFixed(2) + ' 格汇流才成河'}`);
const storedRivers = Array.isArray((baseMaps[best.key] || {}).rivers) ? baseMaps[best.key].rivers : [];
const storedCount = storedRivers.length;
// 落盘河覆盖了哪些格：把折线端点按格距归格（只读，纯统计）
const storedCells = new Set();
for (const rv of storedRivers) {
  for (const p of (rv.points || [])) {
    const c = Math.round(p.x / spacing), r = Math.round(p.y / spacing);
    if (c >= 0 && r >= 0 && c < cols && r < rows) storedCells.add(r * cols + c);
  }
}
const storedPct = (100 * storedCells.size) / Math.max(1, landCount);
console.log(`        落盘河数 ${storedCount} 条（每千格 ${(storedCount / landCount * 1000).toFixed(1)} · 覆盖 ${storedCells.size} 格 = ${storedPct.toFixed(0)}% 陆地）＝ 用户的参照系`);

console.log('\n【② minFlux 扫描（老口径，与格数耦合）】');
report(R, hm, { minFlux: 30, label: 'minFlux=30（默认）' });
for (const mf of [60, 120, 240, 480, 960, 1920]) {
  report(R, hm, { minFlux: mf, label: `minFlux=${mf}` });
}

console.log('\n【③ minDrainageArea 扫描（世界单位²，与格数解耦）】');
for (const area of [200, 400, 700, 900, 1100, 1300, 1800, 3000, 6000]) {
  report(R, hm, { minDrainageArea: area, label: `汇水面积≥${area}` });
}

console.log('\n【④ minSourceRise 扫描（源头海拔，配合默认阈值）】');
for (const rise of [5, 10, 20, 35, 50]) {
  report(R, hm, { minSourceRise: rise, label: `源头海拔≥${rise}` });
}

// ⑤ 同一块地形、不同格距：按整数倍抽稀（只取原格点，不插值）
const spacingArg = Number(flag('spacing', ''));
if (Number.isFinite(spacingArg) && spacingArg > 0) {
  console.log(`\n【⑤ 抽稀到格距 ${spacingArg}（stride = ${Math.max(1, Math.round(spacingArg / spacing))}）】`);
}
console.log('\n【⑤ 格距扫描：同一块地形按整数步抽稀】');
for (const stride of [2, 3, 4]) {
  const nc = Math.floor(cols / stride), nr = Math.floor(rows / stride);
  if (nc < 8 || nr < 8) continue;
  const h2 = new Array(nc * nr);
  const pts2 = new Array(nc * nr);
  for (let r2 = 0; r2 < nr; r2++) {
    for (let c2 = 0; c2 < nc; c2++) {
      const srcI = (r2 * stride) * cols + (c2 * stride);
      const i2 = r2 * nc + c2;
      h2[i2] = hm.h[srcI];
      const p = hm.grid.points[srcI];
      pts2[i2] = p ? { x: p.x, y: p.y } : { x: c2 * spacing * stride, y: r2 * spacing * stride };
    }
  }
  const hm2 = { grid: { points: pts2, cellsX: nc, cellsY: nr, spacing: spacing * stride }, h: h2 };
  const l2 = h2.filter((v) => v >= SEA).length;
  console.log(` stride ${stride} → 格 ${nc}×${nr} = ${nc * nr} 格 · 陆地 ${l2} · 格距 ${(spacing * stride).toFixed(1)}`);
  report(R, hm2, { minFlux: 30, label: '  minFlux=30（默认）' });
  report(R, hm2, { minDrainageArea: 3000, label: '  汇水面积≥3000' });
}
