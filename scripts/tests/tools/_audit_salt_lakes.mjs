#!/usr/bin/env node
/**
 * 盐湖审计（只读）——回答“盐湖到底能不能在**真实地形**里出现”（此前只有合成对照验过）。
 *
 * 做两件事：
 *   1) 拿真实 415 省项目**已经落盘**的高度图 + 湖，按产品同一条气候派生（`buildClimateInputs`
 *      → `heightMath.deriveLayers`）算温度/降水，再跑 `classifyLakesByClimate`：数出盐湖 / 淡水 / 被降级；
 *   2) 自建一块地形（`synthesizeTerrain`，纬度跨度 180 / 120），同样跑一遍 ——
 *      180° 一定横穿干旱带；盐湖要是还出不来，就是气候口径的问题，不是数据的问题。
 *
 * 只读：项目文件不写；产物落 `build/salt-lakes/`。
 *
 * 用法：node scripts/tests/tools/_audit_salt_lakes.mjs [--project <x.sitian>] [--key desite] [--cells 192]
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
// 项目路径由调用方给（仓里不写用户的私人项目名 —— 隐私扫描会红）。不给就只跑自建地形那两档。
const PROJECT = arg('project', '');
const KEY = arg('key', 'desite');
const CELLS = Number(arg('cells', '192'));
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

/** 按产品口径派生气候。不 import deriveClient：它 `import ...?worker`，Node 解析不了 Vite 后缀 */
function climateFor(MOD, hm, latSpan, arid) {
  const inputs = MOD.heightMath.buildClimateInputs(hm.h, hm.grid, { latitudeSpanDeg: latSpan });
  const n = hm.h.length;
  const layers = MOD.heightMath.deriveLayers(
    hm.h,
    (inputs.lat || inputs.ocean) ? { length: n } : null,
    inputs.lat ? (_pt, i) => inputs.lat[i] : null,
    inputs.ocean ? (_pt, i) => inputs.ocean[i] : null,
  );
  let prec = layers.precipitation;
  let biome = layers.biome;
  // ── 提案（只在本审计里试，不改产品）：给降水补一条“纬度干旱轴” ─────────────────
  // 现实口径：副热带高压（|lat| ≈ 20–35°）是下沉气流带 = 沙漠带；赤道与中纬是湿带。
  // 产品现在完全没有这一条（`precipitationAtIndex` 只有“暖 60 / 冷 20 + 近海加分”）。
  if (arid) {
    prec = new Float32Array(n);
    biome = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const lat = inputs.lat ? inputs.lat[i] : 0;
      const f = 1 - 0.62 * Math.exp(-Math.pow((Math.abs(lat) - 27) / 11, 2));
      prec[i] = Math.max(5, Math.min(100, layers.precipitation[i] * f));
      biome[i] = MOD.heightMath.biomeIndex(hm.h[i], layers.temperature[i], prec[i]);
    }
  }
  return { latSpan, temp: layers.temperature, prec, biome, inputs };
}

function render(hm, prec, lakes, out, W = 860) {
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY, sp = hm.grid.spacing;
  const gx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const gy = (p) => (Array.isArray(p) ? p[1] : p.y);
  const pts = hm.grid.points;
  const xs = pts.map(gx), ys = pts.map(gy);
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
  const ox = gx(pts[0]), oy = gy(pts[0]);
  // 陆地按干湿上色：蓝绿 = 湿，赭黄 = 干。干旱带要看得见，否则看不出盐湖为什么在那儿
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = x0 + x / scale, wy = y0 + y / scale;
      const c = Math.max(0, Math.min(cols - 1, Math.round((wx - ox) / sp)));
      const rr = Math.max(0, Math.min(rows - 1, Math.round((wy - oy) / sp)));
      const i = rr * cols + c;
      const v = hm.h[i];
      if (v >= SEA) {
        const p = Math.max(0, Math.min(100, prec ? prec[i] : 50));
        const dry = 1 - p / 100;
        set(x, y, 96 + 150 * dry, 150 - 10 * dry, 96 - 40 * dry);
      } else {
        const d = Math.min(1, Math.max(0, (SEA - v) / 14));
        set(x, y, 90 - 40 * d, 140 - 50 * d, 185 - 40 * d);
      }
    }
  }
  // 湖：淡水 = 蓝，盐湖 = 亮洋红（一眼分得开）
  for (const lk of (lakes || [])) {
    const isSalt = !!(lk && lk.saline);
    for (const cell of (lk && lk.cells) || []) {
      const c = cell % cols, rr = (cell - c) / cols;
      const wx = ox + c * sp, wy = oy + rr * sp;
      disc((wx - x0) * scale, (wy - y0) * scale, Math.max(1.4, sp * scale * 0.75),
        isSalt ? 235 : 70, isSalt ? 60 : 130, isSalt ? 170 : 225);
    }
  }
  fs.writeFileSync(out, encodePNG(W, H, px));
  return { W, H, px };
}

/** 并排（同机位同尺度）：左 = 产品现状，右 = 补了纬度干旱轴之后 */
function sideBySide(a, b, out, gap = 8) {
  const W = a.W + gap + b.W, H = Math.max(a.H, b.H);
  const px = new Uint8Array(W * H * 3).fill(20);
  const buf = Buffer.from(px.buffer);
  for (let y = 0; y < a.H; y++) Buffer.from(a.px.buffer, a.px.byteOffset + y * a.W * 3, a.W * 3).copy(buf, y * W * 3);
  for (let y = 0; y < b.H; y++) Buffer.from(b.px.buffer, b.px.byteOffset + y * b.W * 3, b.W * 3).copy(buf, y * W * 3 + (a.W + gap) * 3);
  fs.writeFileSync(out, encodePNG(W, H, px));
}

function report(label, hm, climate, LK, lakeList, biomeKey) {
  const res = LK.classifyLakesByClimate(lakeList, climate.prec, { temp: climate.temp });
  const saline = res.lakes.filter((l) => l && l.saline);
  const land = hm.h.filter((v) => v >= SEA).length;
  let dryLand = 0, hotDry = 0;
  for (let i = 0; i < hm.h.length; i++) {
    if (hm.h[i] < SEA || !climate.prec) continue;
    if (climate.prec[i] < 40) {
      dryLand++;
      if (climate.temp && climate.temp[i] > 5) hotDry++;
    }
  }
  console.log(`\n【${label}】格 ${hm.grid.cellsX}×${hm.grid.cellsY} · 陆地 ${land} · 纬度跨度 ${climate.latSpan}°`);
  console.log(`   降水<40 的陆地 ${dryLand} 格（其中又热又干 ${hotDry} 格 = ${(100 * hotDry / Math.max(1, land)).toFixed(0)}% 陆地）`);
  console.log(`   湖 ${lakeList.length} 条 → 盐湖 ${res.saline} · 淡水 ${res.fresh} · 降级 ${res.dropped} · 冷区豁免 ${res.coldKept}`);
  // 群系分布：干旱类群系（hot_desert / grassland / savanna / cold_desert）能不能出现，
  // 直接反映气候模型有没有“干旱轴”——这比湖更早暴露问题。
  if (climate.biome) {
    const hist = {};
    for (let i = 0; i < hm.h.length; i++) {
      if (hm.h[i] < SEA) continue;
      const b = climate.biome[i] || '(空)';
      hist[b] = (hist[b] || 0) + 1;
    }
    const parts = Object.entries(hist).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${biomeKey ? biomeKey(Number(k)) : k} ${v}`);
    console.log(`   群系分布：${parts.join(' / ')}`);
  }
  for (const l of saline.slice(0, 8)) {
    const mp = LK.lakeMeanPrecipitation(l, climate.prec);
    const mt = LK.lakeMeanTemperature(l, climate.temp);
    console.log(`     · 盐湖 ${l.cells.length} 格  h=${Math.round(l.level)}  降水 ${mp === null ? '-' : mp.toFixed(1)}  温度 ${mt === null ? '-' : mt.toFixed(1)}`);
  }
  return { res, saline };
}

async function main() {
  const heightMath = await loadModuleViaTmp('heightMath.js');
  const LK = await loadModuleViaTmp('lakes.js');
  const PIPE = await loadModuleViaTmp('terrainPipeline.js');
  const P = await loadModuleViaTmp('terrainParams.js');
  const C = await loadModuleViaTmp('coastline.js');
  const MOD = { heightMath };
  fs.mkdirSync(path.join(ROOT, 'build', 'salt-lakes'), { recursive: true });

  // 1) 真实项目：已落盘的高度图 + 湖
  if (fs.existsSync(PROJECT)) {
    const j = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
    const bm = ((j.scenarios || {}).baseMaps || {})[KEY];
    const hmRaw = bm && bm.heightmap;
    if (hmRaw && hmRaw.h && hmRaw.grid) {
      const h = Array.isArray(hmRaw.h) ? hmRaw.h : Array.from(hmRaw.h);
      const g = hmRaw.grid;
      const hm = { h, grid: { points: g.points, cellsX: g.cellsX, cellsY: g.cellsY, spacing: g.spacing } };
      const latSpan = (bm.climateSpec && bm.climateSpec.latitudeSpanDeg) || 120;
      const climate = climateFor(MOD, hm, latSpan);
      const lakes = Array.isArray(hmRaw.lakes) ? hmRaw.lakes : [];
      const r = report(`真实项目 ${path.basename(PROJECT)} / ${KEY}`, hm, climate, LK, lakes, heightMath.biomeKeyFromIndex);
      render(hm, climate.prec, r.res.lakes, path.join(ROOT, 'build', 'salt-lakes', 'real-project.png'));
      console.log('   -> build/salt-lakes/real-project.png（赭黄 = 干，蓝绿 = 湿；湖：蓝 = 淡水，洋红 = 盐湖）');
    } else {
      console.log(`【跳过】${path.basename(PROJECT)} / ${KEY} 没有高度图`);
    }
  } else {
    console.log(`【跳过】找不到项目 ${PROJECT}`);
  }

  // 2) 自建地形（纬度跨度 180 = 横穿干旱带；120 = 产品默认）
  const mkRing = (cx, cy, r, n, wobble, seed) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const w = 1 + Math.sin(a * 3 + seed) * wobble + Math.sin(a * 7 + seed * 2) * wobble * 0.5;
      pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
    }
    return pts;
  };
  const terrain = [{ id: 'p1', name: 'A', kind: 'land', color: '#c9a06a', points: mkRing(0, 0, 900, 90, 0.16, 1.2) }];
  const mask = C.buildLandMask(terrain);
  const shots = {};
  for (const latSpan of [180, 120]) {
    const params = P.normalizeTerrainParams({ cellsAcross: CELLS, seed: 7, latitudeSpanDeg: latSpan }).params;
    const syn = PIPE.synthesizeTerrain(terrain, P.toSynthesisOptions(params, { isLand: mask.lookup }));
    const hm = { h: Array.from(syn.h), grid: syn.grid };
    const lakes = Array.isArray(syn.lakes) ? syn.lakes : [];
    const clima = climateFor(MOD, hm, latSpan);
    const r = report(`自建地形 纬度跨度 ${latSpan}°（产品现状）`, hm, clima, LK, lakes, heightMath.biomeKeyFromIndex);
    const file = path.join(ROOT, 'build', 'salt-lakes', `self-${latSpan}.png`);
    const shot = render(hm, clima.prec, r.res.lakes, file);
    console.log(`   -> build/salt-lakes/self-${latSpan}.png`);

    // 3) 提案对照：同一条地形，只给降水补“副热带干旱带”，看盐湖 / 荒漠能不能出来
    const clima2 = climateFor(MOD, hm, latSpan, true);
    const r2 = report(`自建地形 纬度跨度 ${latSpan}°（提案：补纬度干旱轴）`, hm, clima2, LK, lakes, heightMath.biomeKeyFromIndex);
    const file2 = path.join(ROOT, 'build', 'salt-lakes', `self-${latSpan}-arid.png`);
    const shot2 = render(hm, clima2.prec, r2.res.lakes, file2);
    console.log(`   -> build/salt-lakes/self-${latSpan}-arid.png`);
    sideBySide(shot, shot2, path.join(ROOT, 'build', 'salt-lakes', `compare-${latSpan}.png`));
    console.log(`   -> build/salt-lakes/compare-${latSpan}.png（左 现状 / 右 提案）`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
