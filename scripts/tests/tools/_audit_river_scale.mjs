#!/usr/bin/env node
/**
 * 河网尺度审计（只读）——复现“自建地形推演出 2457 条河”那张图，回答三件事：
 *   1) 2457 条是因为这块地特别密，还是因为它格数多？
 *   2) 同一块地换个格数（96 / 144 / 193 / 256），河数怎么变？判据：不该“格数翻倍、河数翻 4 倍”。
 *   3) 哪个门槛能让它落回真实 415 省项目那一档（78 条 / 千格陆地、覆盖 35% 陆地）。
 *
 * 走产品同一条工序（`terrainPipeline.synthesizeTerrain` + `fmg/rivers.buildRiverNetwork`），
 * 轮廓与 `test_109` 的 `mkRing` 逐字一致。
 *
 * 用法：
 *   node scripts/tests/tools/_audit_river_scale.mjs [--cells 192] [--seed 7] [--minflux 120] [--raw 0] [--shoot 1]
 *   --raw 1  不吃产品参数（不加排水骨架 / 丘陵），退回裸推演
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const SEED = Number(arg('seed', '7'));
const CELLS = Number(arg('cells', '192'));
const MIN_FLUX = Number(arg('minflux', '120'));
const SHOOT = arg('shoot', '1') === '1';
const RAW = arg('raw', '0') === '1';
const SEA = 20;

let CRC = null;
function crc32(buf) {
  if (!CRC) {
    CRC = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function loadModuleViaTmp(entry) {
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
  try { fs.rmdirSync(tmpRoot); } catch { /* 别的副本还在用 */ }
  return mod;
}

const mkRing = (cx, cy, r, n, wobble, seed) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
    pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
  }
  return pts;
};
const RING = [
  { id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) },
  { id: 'p2', name: 'B', kind: 'land', color: '#a8b98a', points: mkRing(600, 380, 330, 50, 0.2, 2.7) },
];

function stats(net, hm) {
  const land = hm.h.filter((v) => v >= SEA).length;
  const cells = new Set();
  let longest = 0;
  for (const rv of net.rivers) {
    longest = Math.max(longest, rv.cells.length);
    for (const c of rv.cells) cells.add(c);
  }
  return {
    n: hm.h.length, land, rivers: net.rivers.length, riverCells: cells.size,
    coverPct: +(100 * cells.size / Math.max(1, land)).toFixed(0),
    per1k: +(1000 * net.rivers.length / Math.max(1, land)).toFixed(0),
    longest,
  };
}

function render(hm, net, W = 760) {
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY, sp = hm.grid.spacing;
  const h = hm.h;
  // 高度图的 grid.points 是 [x, y] 数组（不是 {x,y} 对象）—— 两个都认
  const gx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const gy = (p) => (Array.isArray(p) ? p[1] : p.y);
  const xs = hm.grid.points.map(gx), ys = hm.grid.points.map(gy);
  const x0 = Math.min(...xs) - sp, y0 = Math.min(...ys) - sp;
  const x1 = Math.max(...xs) + sp, y1 = Math.max(...ys) + sp;
  const scale = W / (x1 - x0);
  const H = Math.max(40, Math.round((y1 - y0) * scale));
  const px = new Uint8Array(W * H * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const disc = (cx, cy, rad, r, g, b) => {
    const r2 = rad * rad;
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) set(x, y, r, g, b);
      }
    }
  };
  let landMax = 0;
  for (const v of h) if (v > SEA && v > landMax) landMax = v;
  const ox = gx(hm.grid.points[0]), oy = gy(hm.grid.points[0]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = x0 + x / scale, wy = y0 + y / scale;
      const fx = (wx - ox) / sp, fy = (wy - oy) / sp;
      const i0 = Math.max(0, Math.min(cols - 1, Math.round(fx)));
      const j0 = Math.max(0, Math.min(rows - 1, Math.round(fy)));
      const v = h[j0 * cols + i0];
      if (v >= SEA) {
        const t = Math.min(1, Math.max(0, (v - SEA) / Math.max(1, landMax - SEA)));
        set(x, y, 150 + 90 * t, 160 + 70 * t, 110 + 60 * t);
      } else {
        const d = Math.min(1, Math.max(0, (SEA - v) / 14));
        set(x, y, 90 - 40 * d, 140 - 50 * d, 185 - 40 * d);
      }
    }
  }
  for (const rv of net.rivers) {
    const pts = rv.points.map((p) => ({ x: (p.x - x0) * scale, y: (p.y - y0) * scale }));
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        disc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0.9, 40, 96, 150);
      }
    }
  }
  return { png: encodePNG(W, H, px), W, H, px };
}

function sideBySide(a, b, gap = 8) {
  const W = a.W + gap + b.W, H = Math.max(a.H, b.H);
  const px = new Uint8Array(W * H * 3).fill(20);
  for (let y = 0; y < a.H; y++) Buffer.from(a.px.buffer, a.px.byteOffset + y * a.W * 3, a.W * 3).copy(Buffer.from(px.buffer), y * W * 3);
  for (let y = 0; y < b.H; y++) Buffer.from(b.px.buffer, b.px.byteOffset + y * b.W * 3, b.W * 3).copy(Buffer.from(px.buffer), y * W * 3 + (a.W + gap) * 3);
  return encodePNG(W, H, px);
}

async function main() {
  const R = await loadModuleViaTmp('fmg/rivers.js');
  const PIPE = await loadModuleViaTmp('terrainPipeline.js');
  const P = await loadModuleViaTmp('terrainParams.js');
  const C = await loadModuleViaTmp('coastline.js');
  const mask = C.buildLandMask(RING);
  // 产品路径 = 面板参数 → toSynthesisOptions（含 8 河口排水骨架 + 260 丘陵）→ terrainPipeline。
  // 量它才是量产品；--raw 1 才退回“只推演、不加骨架/丘陵”的裸管线。
  const makeHm = (cells) => (RAW
    ? PIPE.synthesizeTerrain(RING, { cellsAcross: cells, seed: SEED, isLand: mask.lookup })
    : PIPE.synthesizeTerrain(RING, P.toSynthesisOptions(
      P.normalizeTerrainParams({ cellsAcross: cells, seed: SEED }).params, { isLand: mask.lookup })));

  console.log(`轮廓 = test_109 的 mkRing（900 @90 点 + 330 @50 点）/ 种子 ${SEED} / 管线 ${RAW ? '裸推演' : '产品参数（8 河口 + 260 丘陵）'}\n`);

  console.log('【1】格距扫描（同一块地，只改 cellsAcross）—— 产品口径 minFlux=120');
  console.log('  cellsAcross |   格网   |  陆地  |  河数  | 覆盖%陆地 | 每千格陆地 | 最长 | 生成ms');
  for (const cells of [96, 144, 192, 256]) {
    const t = Date.now();
    const hm = makeHm(cells);
    const ms = Date.now() - t;
    const net = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, { minFlux: MIN_FLUX });
    const st = stats(net, hm);
    console.log(`  ${String(cells).padStart(10)} | ${String(hm.grid.cellsX + 'x' + hm.grid.cellsY).padStart(8)} | ${String(st.land).padStart(6)} | ${String(st.rivers).padStart(6)} | ${String(st.coverPct).padStart(8)}% | ${String(st.per1k).padStart(10)} | ${String(st.longest).padStart(4)} | ${ms}`);
  }

  console.log(`\n【2】门槛标定 —— cellsAcross=${CELLS}（对照真实 415 省项目落盘：78 条/千格陆地、覆盖 35% 陆地）`);
  const hm = makeHm(CELLS);
  const show = (label, opts) => {
    const net = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, opts);
    const st = stats(net, hm);
    console.log(`  ${label.padEnd(24)} 河 ${String(st.rivers).padStart(5)} | 覆盖 ${String(st.coverPct).padStart(3)}% | 每千格 ${String(st.per1k).padStart(4)} | 最长 ${st.longest}`);
    return { net, st };
  };
  show('minFlux=120（产品现状）', { minFlux: MIN_FLUX });
  show('minFlux=30（引擎缺省）', { minFlux: 30 });
  for (const mf of [240, 480, 960, 1920]) show(`minFlux=${mf}`, { minFlux: mf });
  const areaTried = [];
  for (const area of [200, 400, 700, 1200, 2000, 3000]) {
    areaTried.push({ area, ...show(`汇水面积>=${area}`, { minDrainageArea: area }) });
  }

  // ── 【3】那些“梳齿”是什么：长度分布 + 短棍闸门（minCells）扫描 ─────────────
  {
    const net = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, { minFlux: MIN_FLUX });
    const bucket = (n) => (n <= 3 ? '3' : n <= 4 ? '4' : n <= 6 ? '5-6' : n <= 10 ? '7-10' : n <= 20 ? '11-20' : '21+');
    const hist = {};
    for (const rv of net.rivers) hist[bucket(rv.cells.length)] = (hist[bucket(rv.cells.length)] || 0) + 1;
    const total = net.rivers.length;
    console.log('\n【3】河长分布（现状 minFlux=120）—— “梳齿”就是 3~4 格那种短棍');
    for (const k of ['3', '4', '5-6', '7-10', '11-20', '21+']) {
      const c = hist[k] || 0;
      console.log(`   ${k.padStart(5)} 格 | ${String(c).padStart(5)} 条 | ${(100 * c / Math.max(1, total)).toFixed(0).padStart(3)}%`);
    }
    const short4 = net.rivers.filter((rv) => rv.cells.length <= 4).length;
    console.log(`   合计 ${total} 条，其中 ≤4 格 ${short4} 条 = ${(100 * short4 / Math.max(1, total)).toFixed(0)}%`);
    console.log('\n   短棍闸门扫描（minCells，产品缺省 3）：');
    for (const mc of [3, 4, 5, 6, 8, 10]) {
      const n2 = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, { minFlux: MIN_FLUX, minCells: mc });
      const s2 = stats(n2, hm);
      console.log(`     minCells=${String(mc).padStart(2)} → 河 ${String(s2.rivers).padStart(5)} | 覆盖 ${String(s2.coverPct).padStart(3)}% | 每千格 ${String(s2.per1k).padStart(3)} | 最长 ${s2.longest}`);
    }
  }

  if (SHOOT) {    const outDir = path.join(ROOT, 'build', 'river-density');
    fs.mkdirSync(outDir, { recursive: true });
    const optsOf = (label) => {
      if (label === 'current') return { minFlux: MIN_FLUX };
      const area = Number(label.replace('area', ''));
      return { minDrainageArea: area };
    };
    const shots = {};
    for (const label of ['current', 'area700', 'area1200']) {
      const net = R.buildRiverNetwork({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, optsOf(label));
      shots[label] = { img: render(hm, net), st: stats(net, hm) };
      fs.writeFileSync(path.join(outDir, label + '.png'), shots[label].img.png);
    }
    // 三联：现状 | 汇水面积>=700 | >=1200（同机位同尺度，一眼比疏密）
    const a = shots.current.img, b = shots.area700.img, c = shots.area1200.img;
    const gap = 8;
    const W = a.W + gap + b.W + gap + c.W, H = Math.max(a.H, b.H, c.H);
    const px = new Uint8Array(W * H * 3).fill(20);
    const put = (img, x0) => {
      for (let y = 0; y < img.H; y++) {
        Buffer.from(img.px.buffer, img.px.byteOffset + y * img.W * 3, img.W * 3)
          .copy(Buffer.from(px.buffer), y * W * 3 + x0 * 3);
      }
    };
    put(a, 0); put(b, a.W + gap); put(c, a.W + gap + b.W + gap);
    fs.writeFileSync(path.join(outDir, 'compare.png'), encodePNG(W, H, px));
    console.log(`\n图：build/river-density/{current,area700,area1200,compare}.png`);
    for (const k of Object.keys(shots)) {
      const s = shots[k].st;
      console.log(`  ${k.padEnd(9)} 河 ${String(s.rivers).padStart(5)} / 覆盖 ${s.coverPct}% / 每千格 ${s.per1k}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
