#!/usr/bin/env node
/**
 * 生成**规模压测用的合成项目**（只写 build/，不碰仓库里的示例与真实项目）。
 *
 * 用 `sample/示例世界.sitian` 当模板（公开示例、仓内），只换三样：
 *   · `terrain`：铺 N 个省（确定性网格 + 抖动，面积随 N 缩小 —— 就是“几千个省”的形状）；
 *   · `heightmap.h`：可选按最近邻重采样到目标边长格网（“图更大”）；
 *   · `scenarios.scenarios`：补两代 ownership（让政治水洗真的画出来，否则渲染压测没意义）。
 *
 * 用法：
 *   node scripts/tests/tools/make_bench_project.mjs --provinces 3000 --grid 512
 *   → build/eu4-scale/bench-p3000-g512.sitian
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const N = Math.max(16, Math.floor(Number(arg('provinces', '1500'))));
const GRID = Math.max(0, Math.floor(Number(arg('grid', '0'))));   // 0 = 沿用模板格网
const SEED = Math.floor(Number(arg('seed', '7')));

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

const src = path.join(ROOT, 'sample', '示例世界.sitian');
const j = JSON.parse(fs.readFileSync(src, 'utf8'));
const bmKey = Object.keys(j.scenarios.baseMaps)[0];
const bm = j.scenarios.baseMaps[bmKey];
const old = bm.terrain || [];
if (!old.length) throw new Error('模板底图没有省份，无法取包围盒');

// 模板陆地的包围盒（= 世界范围），新省份铺满它
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const p of old) for (const q of p.points || []) {
  if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
  if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
}

const rnd = mulberry32(SEED);
const cols = Math.ceil(Math.sqrt(N * 1.5));
const rows = Math.ceil(N / cols);
const cw = (x1 - x0) / cols;
const ch = (y1 - y0) / rows;
const ptsPer = 40;
const terrain = [];
for (let i = 0; i < N; i++) {
  const c = i % cols, r = Math.floor(i / cols);
  const cx = x0 + (c + 0.5) * cw;
  const cy = y0 + (r + 0.5) * ch;
  const rad = Math.min(cw, ch) * 0.46;
  const points = [];
  for (let k = 0; k < ptsPer; k++) {
    const a = (k / ptsPer) * Math.PI * 2;
    const jitter = 0.85 + rnd() * 0.25;
    points.push({
      x: +(cx + Math.cos(a) * rad * jitter).toFixed(2),
      y: +(cy + Math.sin(a) * rad * jitter * 0.92).toFixed(2),
    });
  }
  terrain.push({
    id: `bench_p${i}`, name: `省 ${i}`, kind: 'land', color: '#9ec9a8',
    biome: '', culture: '', coast: false, points,
  });
}
bm.terrain = terrain;

// ── 高度图：可选放大（最近邻），格网跟着变大 ────────────────────────────────
let hmCells = 0;
if (GRID > 0 && bm.heightmap && Array.isArray(bm.heightmap.h)) {
  const oldH = bm.heightmap;
  const oc = oldH.grid.cellsX, or = oldH.grid.cellsY;
  const cols2 = GRID, rows2 = Math.max(8, Math.round(GRID * (or / oc)));
  const h = new Array(cols2 * rows2);
  for (let rr = 0; rr < rows2; rr++) {
    for (let cc = 0; cc < cols2; cc++) {
      const sc = Math.min(oc - 1, Math.floor((cc / cols2) * oc));
      const sr = Math.min(or - 1, Math.floor((rr / rows2) * or));
      h[rr * cols2 + cc] = oldH.h[sr * oc + sc];
    }
  }
  const sp = (oldH.grid.spacing || 9) * (oc / cols2);
  // 格点世界坐标按新格网线性铺开（与旧图同包围盒）
  const points = new Array(cols2 * rows2);
  for (let rr = 0; rr < rows2; rr++) {
    for (let cc = 0; cc < cols2; cc++) points[rr * cols2 + cc] = [x0 + cc * sp, y0 + rr * sp];
  }
  bm.heightmap = { ...oldH, h, grid: { points, cellsX: cols2, cellsY: rows2, spacing: sp }, cellCount: cols2 * rows2 };
  hmCells = cols2 * rows2;
} else if (bm.heightmap) {
  hmCells = (bm.heightmap.grid.cellsX | 0) * (bm.heightmap.grid.cellsY | 0);
}

// ── 两代剧本：让政治水洗真的有归属可画 ─────────────────────────────────────
const owners = ['f_a', 'f_b', 'f_c', 'f_d'];
const mkScenario = (i) => {
  const ownership = {};
  terrain.forEach((p, k) => { ownership[p.id] = owners[(k + i) % owners.length]; });
  return {
    id: `bench_sc${i}`, name: `第 ${i + 1} 代`, start: 1300 + i * 60, end: 1360 + i * 60,
    lineageness: undefined, ownership, changeEvents: [],
  };
};
// ⚠️ `scenarios.scenarios` 是**字典**（按 id 键），不是数组 —— 真机上写数组会让
//    “当前底图/剧本”全空，画布只剩一句“这个项目里还没有底图”（2026-11-08 压测第一跑就是栽在这）
j.scenarios.scenarios = { bench_sc0: mkScenario(0), bench_sc1: mkScenario(1) };
j.scenarios.groups = j.scenarios.groups || {};

const outDir = path.join(ROOT, 'build', 'eu4-scale');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `bench-p${N}-g${GRID || 'base'}.sitian`);
fs.writeFileSync(out, JSON.stringify(j), 'utf8');
const mb = (fs.statSync(out).size / 1048576).toFixed(2);
console.log(`写出 ${out}`);
console.log(`  ${N} 个省 × ${ptsPer} 点 · 高度图 ${hmCells ? hmCells + ' 格' : '沿用模板'} · ${mb} MB`);
console.log(`  顶点总数 ${(N * ptsPer).toLocaleString()}`);
