// P2 地形侵蚀对照实验（只读；2026-11-04）
//
// 问题（P1 的三条结论）：96/192/256 三档重生成里，河道中位长度都只有 4~5 格、≤4 格占比 48~81%，
// 画面上是**扇状平行条纹**。根因是 `terrainSynthesis` 的“离岸距离 = 海拔”把大陆做成一座圆顶，
// 水只能沿径向平行下流 —— 不是河参数的问题，是地形**没有谷**。
//
// 本工具只做一件事：在同一份轮廓、同一 seed 下，量“侵蚀前 / 侵蚀后”五项判据，并出同机位对照图。
//   ① 扇状度：8×8 格窗口内河道方向向量的合成长度 / 条数（1 = 完全平行）—— 必须显著下降；
//   ② 分叉点 / 万格 —— 目标 ≥ 2× 基线；
//   ③ 最长“源头 → 海”完整路径（穿 parent 链）—— 基线 ≤220 世界单位，目标 ≥400；
//   ④ 同 seed 确定性 + 陆地格守恒 + 生成耗时（256 格 ≤500ms）；
//   ⑤ 并排截图。
//
// ⚠️ 只读：项目文件只读；产物全部落 `build/terrain-erosion/`。
//
// 用法：
//   node scripts/tests/tools/_audit_erosion.mjs [--cells 256] [--seed 7] [--iters 30] [--strength 0.35]
//        [--erode grid|existing|none] [--project <x.sitian>] [--key desite]
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const PROJECT = arg('project', '<用户目录>/Documents/SiTianProjects/示例项目.sitian');
const KEY = arg('key', 'desite');
const SEED = Number(arg('seed', '7'));
const CELLS = Number(arg('cells', '256'));
const ITERS = Number(arg('iters', '30'));
const STRENGTH = Number(arg('strength', '0.35'));
const MODE = arg('erode', 'grid');          // grid = 坡面侵蚀迭代核；existing = 造陆那条 erodeTerrain；none = 不侵蚀
const BASINS = Number(arg('basins', '0'));  // >0 = 开排水盆地骨架（先给水少数出口）
const HILLS = Number(arg('hills', '0'));    // >0 = 撒多尺度丘陵（8 格尺度上的方向变化只能来自它）
const TREE = Number(arg('tree', '0'));      // >0 = 递归分级河网骨架（河口数）
const DEPTH = Number(arg('depth', '3'));    // 分级层数
const BRANCH = Number(arg('branching', '2')); // 每层挂几条支流
const FMG_REF = arg('fmg', '0') === '1';    // 1 = 追加一个 FMG 模板地形样本（判据校准用）
const SMOOTH = Number(arg('smooth', '2'));  // 河线平滑遍数（0 = 看“电路板”原样）
const SRCRISE = Number(arg('srcrise', '0'));  // 河源海拔门槛（0 = 关）
const STORED = arg('stored', '0') === '1';  // 1 = 直接渲染项目文件里**已落盘**的高度图（不重推演）
const PROD = arg('prod', '0') === '1';   // 1 = 追加一次“产品参数路径”的样本（terrainParams.toSynthesisOptions）
const ZOOM = Number(arg('zoom', '0'));      // >1 = 额外出“放大 N 倍裁一块”的图（看近处像不像梳子）
const MIN_FLUX = Number(arg('minflux', '120'));

// ── PNG（zlib + CRC，无依赖；与 _audit_scale 同一套）───────────────────────────
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

let RAMP = null;   // 产品色带（heightmapRaster 的 RELIEF_LAND_STOPS / OCEAN_DEPTH_STOPS），由 main() 注入
function landColor(t) {
  const stops = [[0, 150, 170, 120], [0.3, 175, 182, 124], [0.55, 190, 180, 132],
    [0.75, 178, 145, 118], [0.9, 200, 190, 185], [1, 245, 245, 245]];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, r0, g0, b0] = stops[i], [b, r1, g1, b1] = stops[i + 1];
    if (t <= b) { const u = b > a ? (t - a) / (b - a) : 0; return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u]; }
  }
  return [245, 245, 245];
}

/** 到最近“种子格”的 chamfer 距离（3-4 距离，近似欧氏；不过滤介质） */
function chamferAll(seed, cols, rows) {
  const n = cols * rows;
  const INF = 1e18;
  const d = new Float64Array(n).fill(INF);
  for (let i = 0; i < n; i++) if (seed[i]) d[i] = 0;
  const A = 1, B = Math.SQRT2;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      let v = d[idx];
      if (i > 0) v = Math.min(v, d[idx - 1] + A);
      if (j > 0) v = Math.min(v, d[idx - cols] + A);
      if (i > 0 && j > 0) v = Math.min(v, d[idx - cols - 1] + B);
      if (i < cols - 1 && j > 0) v = Math.min(v, d[idx - cols + 1] + B);
      d[idx] = v;
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const idx = j * cols + i;
      let v = d[idx];
      if (i < cols - 1) v = Math.min(v, d[idx + 1] + A);
      if (j < rows - 1) v = Math.min(v, d[idx + cols] + A);
      if (i < cols - 1 && j < rows - 1) v = Math.min(v, d[idx + cols + 1] + B);
      if (i > 0 && j < rows - 1) v = Math.min(v, d[idx + cols - 1] + B);
      d[idx] = v;
    }
  }
  return d;
}

/** 渲染 + 阴影（hillshade）：地形本身（谷有没有被切出来）要能一眼看出，不能只看得见河 */
function render(hm, out, W = 1200) {
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY, sp = hm.grid.spacing;
  const pts = hm.grid.points, h = hm.h;
  // 格心原点（第 0 列/行的世界坐标）；x0/y0 是图像左上角（外扩半格）
  const ox0 = pts[0][0], oy0 = pts[0][1];
  const x0 = ox0 - sp / 2, y0 = oy0 - sp / 2;
  // 光照方向：左上（与常见 hillshade 同向）
  const lx = -0.66, ly = -0.66, lz = 0.36;
  const worldW = cols * sp, worldH = rows * sp;
  const scale = W / worldW;
  const H = Math.max(60, Math.round(worldH * scale));
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
  for (let i = 0; i < h.length; i++) if (h[i] > 20 && h[i] > landMax) landMax = h[i];
  // 双线性放大高度场（**与产品同口径**）：产品侧 `RASTER_SMOOTH` 是把格级栅格
  // 平滑放大成渐变（`heightmapRaster` + `drawImage` 插值）；这里若按格画方块，4 倍近景
  // 就是“我的世界模组”（2026-11-04 暮雨原话）—— 那是量尺的错，不是产品的错。
  // 显示用：① 陆地掩膜的有符号距离（海岸线不再按格切台阶）；② 高度轻模糊（去掉填洼留下的平台边）
  const landMask = new Uint8Array(h.length);
  const seaMask = new Uint8Array(h.length);
  for (let i = 0; i < h.length; i++) { landMask[i] = h[i] > 20 ? 1 : 0; seaMask[i] = landMask[i] ? 0 : 1; }
  const dSeaFromLand = chamferAll(landMask, cols, rows);
  const dLandFromSea = chamferAll(seaMask, cols, rows);
  const sdf = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) sdf[i] = landMask[i] ? dLandFromSea[i] : -dSeaFromLand[i];
  const hBlur = new Float64Array(h.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0, cnt = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          sum += h[nj * cols + ni]; cnt++;
        }
      }
      hBlur[j * cols + i] = cnt ? sum / cnt : h[j * cols + i];
    }
  }
  const bilinear = (arr, fx, fy) => {
    const i0 = Math.min(cols - 1, Math.max(0, Math.floor(fx)));
    const i1 = Math.min(cols - 1, i0 + 1);
    const j0 = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
    const j1 = Math.min(rows - 1, j0 + 1);
    const tx = Math.min(1, Math.max(0, fx - Math.floor(fx)));
    const ty = Math.min(1, Math.max(0, fy - Math.floor(fy)));
    const a = arr[j0 * cols + i0], b = arr[j0 * cols + i1];
    const c2 = arr[j1 * cols + i0], d2 = arr[j1 * cols + i1];
    return (a + (b - a) * tx) * (1 - ty) + (c2 + (d2 - c2) * tx) * ty;
  };
  const hf = new Float32Array(W * H);
  const sf = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const wx = x0 + (x + 0.5) / scale;
      const wy = y0 + (y + 0.5) / scale;
      const fx = (wx - ox0) / sp - 0.5;
      const fy = (wy - oy0) / sp - 0.5;
      hf[y * W + x] = bilinear(hBlur, fx, fy);
      sf[y * W + x] = bilinear(sdf, fx, fy);
    }
  }
  const worldPerPx = 1 / scale;
  const blendBand = Math.max(1.2, sp * 1.1);       // 海岸过渡带（世界单位）
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const hh = hf[y * W + x];
      const sd = sf[y * W + x];                      // >0 陆地，<0 海里
      const landA = Math.min(1, Math.max(0, 0.5 + (sd * sp) / blendBand));
      const water = (() => {
        const d = Math.min(1, Math.max(0, (20 - hh) / 14));
        if (RAMP) return RAMP.sample(RAMP.ocean, 0.10 + 0.55 * (1 - d));
        return [120 - 60 * d, 175 - 60 * d, 210 - 50 * d];
      })();
      const land = (() => {
        const t0 = Math.min(1, Math.max(0, (hh - 20) / Math.max(1, landMax - 20)));
        const base = RAMP ? RAMP.sample(RAMP.land, t0) : landColor(t0);
        const xa = Math.max(0, x - 1), xb = Math.min(W - 1, x + 1);
        const ya = Math.max(0, y - 1), yb = Math.min(H - 1, y + 1);
        const dzdx = (hf[y * W + xb] - hf[y * W + xa]) / (worldPerPx * (xb - xa || 1));
        const dzdy = (hf[yb * W + x] - hf[ya * W + x]) / (worldPerPx * (yb - ya || 1));
        const nx = -dzdx, ny = -dzdy, nz = 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        const d = (nx * lx + ny * ly + nz * lz) / len;
        const s = Math.max(0.72, Math.min(1.2, 0.95 + d * 0.38));
        return [base[0] * s, base[1] * s, base[2] * s];
      })();
      set(x, y,
        Math.min(255, (water[0] + (land[0] - water[0]) * landA) | 0),
        Math.min(255, (water[1] + (land[1] - water[1]) * landA) | 0),
        Math.min(255, (water[2] + (land[2] - water[2]) * landA) | 0));
    }
  }
  const R = out.R;
  const fluxMax = out.stats.maxFlux || 1;
  for (const rv of out.rivers) {
    const pts2 = rv.points.map((p, k) => {
      const off = R.getOffset({ flux: p.flux || 0, pointIndex: k, widthFactor: rv.widthFactor, startingWidth: rv.sourceWidth, fluxMax });
      return { x: (p.x - x0) * scale, y: (p.y - y0) * scale, w: R.widthFromOffset(off) };
    });
    let wmax = 1;
    for (const p of pts2) if (p.w > wmax) wmax = p.w;
    for (let k = 1; k < pts2.length; k++) {
      const rad = Math.max(0.5, Math.min(1.6, 1.6 * Math.sqrt(pts2[k].w / wmax)) * Math.max(0.55, scale));
      const a = pts2[k - 1], b = pts2[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        disc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, rad, 40, 96, 140);
      }
    }
  }
  return { png: encodePNG(W, H, px), W, H, px };
}

/** 并排（同机位、同尺度）：左 = 前，右 = 后 */
function sideBySide(a, b, gap = 8) {
  const W = a.W + gap + b.W, H = Math.max(a.H, b.H);
  const px = new Uint8Array(W * H * 3).fill(24);
  for (let y = 0; y < a.H; y++) {
    Buffer.from(a.px.buffer, a.px.byteOffset + y * a.W * 3, a.W * 3).copy(Buffer.from(px.buffer), y * W * 3);
  }
  for (let y = 0; y < b.H; y++) {
    Buffer.from(b.px.buffer, b.px.byteOffset + y * b.W * 3, b.W * 3)
      .copy(Buffer.from(px.buffer), y * W * 3 + (a.W + gap) * 3);
  }
  return encodePNG(W, H, px);
}

/**
 * 五项判据里的四项数值（河相关）。`fan` 是本卡新增的“扇状度”：
 * 把每条河**相邻格**的方向向量按 8×8 格窗口汇总，窗口合成长度 / 条数 ∈ [0,1]。
 * 1 = 窗口内全平行；树枝状水系里支流从不同方向汇入 → 明显小于 1。
 */
function measure(out, hm, label, msGen) {
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY;
  const pts = hm.grid.points;
  const lens = out.rivers.map((r) => r.cells.length).sort((a, b) => a - b);
  const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] : 0);
  const L = out.rivers.map((r) => r.length).sort((a, b) => a - b);
  const qL = (p) => (L.length ? L[Math.min(L.length - 1, Math.floor(L.length * p))] : 0);
  const kids = new Map();
  for (const r of out.rivers) if (r.parent) kids.set(r.parent, (kids.get(r.parent) || 0) + 1);
  const branch = [...kids.values()].filter((n) => n >= 2).length;
  const shortShare = out.rivers.length ? out.rivers.filter((r) => r.cells.length <= 4).length / out.rivers.length : 0;

  // ── 扇状度：8×8 格窗口 ────────────────────────────────────────────────────
  const win = 8;
  const wx = Math.ceil(cols / win), wy = Math.ceil(rows / win);
  const sumX = new Float64Array(wx * wy), sumY = new Float64Array(wx * wy), cnt = new Int32Array(wx * wy);
  for (const r of out.rivers) {
    const cs = r.cells;
    for (let k = 1; k < cs.length; k++) {
      const a = pts[cs[k - 1]], b = pts[cs[k]];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-9)) continue;
      const c = cs[k] % cols, rr = (cs[k] - c) / cols;
      const w = Math.floor(rr / win) * wx + Math.floor(c / win);
      sumX[w] += dx / len; sumY[w] += dy / len; cnt[w] += 1;
    }
  }
  const fans = [];
  for (let w = 0; w < wx * wy; w++) {
    if (cnt[w] < 4) continue;                 // 少于 4 段没有统计意义
    fans.push(Math.hypot(sumX[w], sumY[w]) / cnt[w]);
  }
  fans.sort((a, b) => a - b);
  const fq = (p) => (fans.length ? fans[Math.min(fans.length - 1, Math.floor(fans.length * p))] : 1);
  const fanMean = fans.length ? fans.reduce((s, v) => s + v, 0) / fans.length : 1;

  // ── 最长完整路径（源头 → 海，穿 parent 链）──────────────────────────────────
  const byId = new Map(out.rivers.map((r) => [r.id, r]));
  let longest = 0;
  for (const r of out.rivers) {
    let len = r.length, cur = r, guard = 0;
    while (cur && cur.parent && guard++ < 64) {
      const p = byId.get(cur.parent);
      if (!p || p === cur) break;
      len += p.length;
      cur = p;
    }
    if (len > longest) longest = len;
  }
  return {
    label, cols, rows, spacing: +Number(hm.grid.spacing).toFixed(2),
    cells: hm.h.length, land: out.stats.land,
    rivers: out.rivers.length, cellsP50: q(0.5), cellsP90: q(0.9),
    lenP50: Math.round(qL(0.5)), lenP90: Math.round(qL(0.9)), lenMax: Math.round(qL(1)),
    longestPath: Math.round(longest),
    branch, branchPer10k: +(branch / (hm.h.length / 10000)).toFixed(1),
    shortShare: +(shortShare * 100).toFixed(1),
    endInSea: out.stats.endInSea, endInLake: out.stats.endInLake, maxOrder: out.stats.maxOrder,
    fan: +fanMean.toFixed(3), fanP10: +fq(0.1).toFixed(3), fanP90: +fq(0.9).toFixed(3),
    fanWindows: fans.length, msGen,
  };
}

function hashH(h) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < h.length; i++) {
    x ^= Math.round(Number(h[i]) * 100) | 0;
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x >>> 0;
}

async function main() {
  const R = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
  const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);
  const C = await import(pathToFileURL(path.join(UTILS, 'coastline.js')).href);
  // 用**产品自己的色带**渲染（heightmapRaster 的浮雕/海深色阶）—— 量尺的观感要与产品一致，
  // 不能再自造一套高对比配色（那是“像我的世界模组”的一半原因）。
  const HR = await loadModuleViaTmp('heightmapRaster.js');
  RAMP = { land: HR.RELIEF_LAND_STOPS, ocean: HR.OCEAN_DEPTH_STOPS, sample: HR.sampleStops };
  const j = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
  const bm = j.scenarios.baseMaps[KEY];
  if (!bm) throw new Error(`项目里没有底图 ${KEY}`);
  const terrain = (bm.terrain || []).filter((t) => t && t.kind !== 'sea' && Array.isArray(t.points) && t.points.length >= 3);
  console.log(`轮廓 ${terrain.length} 省 / 种子 ${SEED} / 格数 ${CELLS} / 模式 ${MODE} / 轮数 ${ITERS} / 强度 ${STRENGTH}`);

  const outDir = path.join(ROOT, 'build', 'terrain-erosion');
  fs.mkdirSync(outDir, { recursive: true });

  const mask = C.buildLandMask(terrain);
  // 走**产品同一条工序**（`terrainPipeline.synthesizeTerrain`：推演 → 排水骨架 → 丘陵 → 填洼 → 湖）。
  // 量尺与产品共用一份实现，量出来的数就是产品跑出来的数。
  const PIPE = await loadModuleViaTmp('terrainPipeline.js');
  const synth = (extra) => {
    const t = Date.now();
    const hm = PIPE.synthesizeTerrain(terrain, {
      cellsAcross: CELLS, seed: SEED, isLand: mask.lookup, ...extra,
    });
    return { hm, ms: Date.now() - t };
  };
  const plain = synth({});
  if (!plain.hm) throw new Error('推演失败');
  // 有盆地骨架时，对照基线仍取“无盆地”（判据要证明骨架本身是有效因素）
  const withBasins = BASINS > 0 ? synth({ drainageBasins: BASINS }) : null;
  const withTree = TREE > 0 ? synth({ drainageTree: TREE, drainageDepth: DEPTH, drainageBranching: BRANCH }) : null;
  if (withTree && withTree.hm && withTree.hm.structure) {
    console.log(`分级河网：河口 ${withTree.hm.structure.drainageTreeOutlets} · 河道段 ${withTree.hm.structure.drainageTreeChannels} · 河道格 ${withTree.hm.structure.drainageTreeCells}`);
  }

  const E = MODE === 'none' ? null : await loadModuleViaTmp('terrainErosion.js');
  /** 侵蚀（可选）+ 重新填洼（合成地形本身也填，侵蚀后必须再填一次） */
  const erode = (hm, msBefore) => {
    const te = Date.now();
    if (MODE === 'grid') {
      const res = E.erodeGridSurface({ grid: hm.grid, h: hm.h }, { iterations: ITERS, strength: STRENGTH }, { seaLevel: 20 });
      const land = new Uint8Array(hm.h.length);
      for (let i = 0; i < land.length; i++) land[i] = res.h[i] >= 20 ? 1 : 0;
      const filled = TS.fillDepressions(res.h, land, hm.grid.cellsX, hm.grid.cellsY, 20, 0.04);
      return { hm: { grid: hm.grid, h: filled }, stats: res.stats, ms: msBefore + (Date.now() - te) };
    }
    const copy = { grid: hm.grid, h: Array.from(hm.h) };
    const st = E.erodeTerrain(copy, { seaLevel: 20, iterations: Math.max(1, Math.min(6, ITERS)), strength: 2.8 });
    return { hm: { grid: hm.grid, h: Float64Array.from(copy.h) }, stats: st, ms: msBefore + (Date.now() - te) };
  };

  const rows = [];
  const shots = {};
  const run = (hm, label, msGen) => {
    const net = R.buildRiverNetwork(hm, { minFlux: MIN_FLUX, smoothPasses: SMOOTH, ...(SRCRISE > 0 ? { minSourceRise: SRCRISE } : {}) });
    const st = measure(net, hm, label, msGen);
    rows.push(st);
    const img = render(hm, Object.assign(net, { R }));
    fs.writeFileSync(path.join(outDir, `${label}.png`), img.png);
    shots[label] = img;
    if (ZOOM > 1) {
      // 产品里看的是放大后的细节（用户截图是 400%）：只缩到 1200px 会把梳齿糊成一条实线
      const big = render(hm, Object.assign(net, { R }), 1200 * ZOOM);
      const cw = Math.min(big.W, 1200), ch = Math.min(big.H, 600);
      const zoomed = cropImage(big, cw, ch, Math.floor(big.W / 2), Math.floor(big.H / 2));
      fs.writeFileSync(path.join(outDir, `zoom-${label}.png`), zoomed.png);
      shots[`zoom-${label}`] = zoomed;
    }
    console.log(JSON.stringify(st));
    return st;
  };

  // 多尺度丘陵走 `terrainPipeline`（与产品同一份实现）：这里只判断要不要撒、撒多少
  const hillMod = HILLS > 0;

  if (FMG_REF) {
    // 参照口径：FMG/Azgaar 的模板地形（河网引擎与判据完全相同的一把尺子）—— 用来校准“扇状度”判据
    const F = await loadModuleViaTmp('fmg/index.js');
    const t = Date.now();
    const gen = F.generateHeightmap({ cellsDesired: 26000, seed: SEED, templateId: 'continents' });
    const msF = Date.now() - t;
    run({
      grid: { points: gen.points, cellsX: gen.cellsX, cellsY: gen.cellsY, spacing: gen.spacing },
      h: gen.h, lakes: gen.lakes,
    }, 'ref-fmg', msF);
  }
  if (STORED) {
    // 直接渲染项目里**已落盘**的高度图 + 用河网引擎现算的河 —— 这就是用户打开项目看到的底子。
    const hmRaw = bm.heightmap;
    if (!hmRaw || !hmRaw.grid || !Array.isArray(hmRaw.h)) throw new Error('项目里没有高度图');
    const g = hmRaw.grid;
    run({
      grid: { points: g.points, cellsX: g.cellsX, cellsY: g.cellsY, spacing: g.spacing },
      h: hmRaw.h, lakes: hmRaw.lakes,
    }, 'project-stored', 0);
    return;
  }

  if (PROD) {
    // 产品参数路径：面板参数 → toSynthesisOptions → terrainPipeline（量它 = 量产品）
    const P = await loadModuleViaTmp('terrainParams.js');
    const po = P.toSynthesisOptions(P.normalizeTerrainParams({ cellsAcross: CELLS, seed: SEED }).params, { isLand: mask.lookup });
    const t = Date.now();
    const hm = PIPE.synthesizeTerrain(terrain, po);
    run({ grid: hm.grid, h: hm.h, lakes: hm.lakes }, 'prod-params', Date.now() - t);
  }
  const base = run({ grid: plain.hm.grid, h: plain.hm.h, lakes: plain.hm.lakes }, `00-baseline-${CELLS}`, plain.ms);
  // 排水骨架的参数（丘陵参数分开拼：`hills` 由工序自己叠）
  const shapeOpts = TREE > 0
    ? { drainageTree: TREE, drainageDepth: DEPTH, drainageBranching: BRANCH }
    : withBasins ? { drainageBasins: BASINS } : {};
  let shaped = withTree ? withTree.hm : withBasins ? withBasins.hm : plain.hm;
  let shapedMs = withTree ? withTree.ms : withBasins ? withBasins.ms : plain.ms;
  let mid = null, midLabel = null;
  if (withBasins) {
    midLabel = `01-basins-${CELLS}`;
    mid = run({ grid: withBasins.hm.grid, h: withBasins.hm.h, lakes: withBasins.hm.lakes }, midLabel, withBasins.ms);
  }
  if (withTree) {
    midLabel = `02-tree-${CELLS}`;
    mid = run({ grid: withTree.hm.grid, h: withTree.hm.h, lakes: withTree.hm.lakes }, midLabel, withTree.ms);
  }
  if (hillMod) {
    const hres = synth({ ...shapeOpts, hills: HILLS });
    shaped = hres.hm;
    shapedMs = hres.ms;
    midLabel = `03-hills-${CELLS}`;
    mid = run(shaped, midLabel, shapedMs);
  }
  let after = null, eroStats = null, msFinal = shapedMs, actualFinalH = shaped.h;
  if (E) {
    const res = erode(shaped, shapedMs);
    eroStats = res.stats;
    msFinal = res.ms;
    actualFinalH = res.hm.h;
    after = run(res.hm, `99-final-${CELLS}`, res.ms);
    fs.writeFileSync(path.join(outDir, `compare-${CELLS}.png`),
      sideBySide(shots[`00-baseline-${CELLS}`], shots[`99-final-${CELLS}`]));
  } else if (mid) {
    // 不跑侵蚀时，“最终”就是骨架（最后一档中间样本）——判据表照常对得上
    after = mid;
    actualFinalH = shaped.h;
    msFinal = shapedMs;
    fs.writeFileSync(path.join(outDir, `compare-${CELLS}.png`),
      sideBySide(shots[`00-baseline-${CELLS}`], shots[midLabel]));
  }

  // 确定性：整条工序（合成 + 丘陵 + 侵蚀）同 seed 再跑一遍，逐字节比（判据④的前半）
  const again = synth(hillMod ? { ...shapeOpts, hills: HILLS } : shapeOpts);
  let finalH = again.hm.h;
  if (MODE === 'grid' && E) {
    const r2 = E.erodeGridSurface({ grid: again.hm.grid, h: finalH }, { iterations: ITERS, strength: STRENGTH }, { seaLevel: 20 });
    const land = new Uint8Array(r2.h.length);
    for (let i = 0; i < land.length; i++) land[i] = r2.h[i] >= 20 ? 1 : 0;
    finalH = TS.fillDepressions(r2.h, land, again.hm.grid.cellsX, again.hm.grid.cellsY, 20, 0.04);
  }
  const deterministic = hashH(actualFinalH) === hashH(finalH);
  const totalMs = msFinal;

  const md = [
    '# 地形对照实验（P2：让水有谷可汇）',
    '',
    `项目：\`${path.basename(PROJECT)}\` / 底图 \`${KEY}\` / 轮廓 ${terrain.length} 省 / 种子 ${SEED} / 格数 ${CELLS} / 闸门 ${MIN_FLUX}`,
    `骨架：出水口 ${BASINS || 0} 个（0 = 关）/ 分级河网 ${TREE || 0} 河口（层 ${DEPTH} × 支 ${BRANCH}）/ 丘陵 ${HILLS || 0} 座（0 = 关）/ 侵蚀：模式 \`${MODE}\` / 轮数 ${ITERS} / 强度 ${STRENGTH}`,
    '',
    '| 样本 | 格网 | 河数 | 中位格数 | 长度中位 | 最长 | **最长源—海** | 分叉点 | 分叉/万格 | ≤4格 | 最高级 | **扇状度** | 生成 ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.cols}×${r.rows} | ${r.rivers} | ${r.cellsP50} | ${r.lenP50} | ${r.lenMax} | ${r.longestPath} | ${r.branch} | ${r.branchPer10k} | ${r.shortShare}% | ${r.maxOrder} | ${r.fan} | ${r.msGen} |`),
    '',
    '## 判据（基线 = 00-baseline；现状 = 99-final）',
    '',
    '| 判据 | 基线 | 现状 | 目标 | 结论 |',
    '|---|---|---|---|---|',
    `| 扇状度（1 = 完全平行） | ${base.fan} | ${after ? after.fan : '-'} | 显著下降（≥0.05） | ${after ? (after.fan < base.fan - 0.05 ? '过' : '不过') : '-'} |`,
    `| 分叉点 / 万格 | ${base.branchPer10k} | ${after ? after.branchPer10k : '-'} | ≥ 2× | ${after ? (after.branchPer10k >= base.branchPer10k * 2 ? '过' : '不过') : '-'} |`,
    `| 最长源—海路径 | ${base.longestPath} | ${after ? after.longestPath : '-'} | ≥ 400 | ${after ? (after.longestPath >= 400 ? '过' : '不过') : '-'} |`,
    `| 同 seed 确定性 | 是 | ${deterministic ? '是' : '否'} | 逐字节一致 | ${deterministic ? '过' : '不过'} |`,
    `| 陆地格守恒 | ${base.land} | ${after ? after.land : '-'} | 不变 | ${after && after.land === base.land ? '过' : after ? '不过' : '-'} |`,
    `| 生成耗时（256 格） | ${plain.ms}ms | ${totalMs}ms | ≤500ms | ${totalMs <= 500 ? '过' : '不过'} |`,
    '',
    `对照图：\`compare-${CELLS}.png\`（左 = 基线，右 = 最终，同机位同尺度；含山地阴影，谷能直接看出来）。`,
    `中间样本：${mid ? '按工序先后见上表' : '未跑'}；单张 \`00-baseline-${CELLS}.png\` / \`03-final-${CELLS}.png\`。`,
    eroStats ? `\n侵蚀自述：${JSON.stringify(eroStats)}` : '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md, 'utf8');
  fs.writeFileSync(path.join(outDir, `summary-${CELLS}.json`),
    JSON.stringify({ rows, deterministic, totalMs, basins: BASINS, hills: HILLS, iters: ITERS, strength: STRENGTH, eroStats }, null, 2), 'utf8');
  console.log('\n' + md);
}

/**
 * 把 terrainErosion 及其依赖拷到临时目录（相对导入补 .js 后缀、保留目录结构）后加载。
 * 之所以要拷：仓内浏览器侧的导入写成 `./riverTrace`（无后缀，Vite 能解析），Node ESM 不能。
 */
async function loadModuleViaTmp(entry) {
  const seen = new Map();                     // 相对 UTILS 的路径 → 源码
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
  // 临时目录放进仓内的 build/：这样 `delaunator` 之类 npm 依赖能沿目录树找到 node_modules
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
  // 导入完成后即可删掉临时副本（模块已在内存里，后续调用不再碰磁盘）
  const mod = await import(pathToFileURL(path.join(tmp, entry)).href);
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.rmdirSync(tmpRoot); } catch { /* 还有别的副本在用 → 留着 */ }
  return mod;
}

main().catch((e) => { console.error(e); process.exit(1); });

/** 从一张已渲染的图里裁一块（用于“放大到产品 400% 那种视角”看细节） */
function cropImage(img, cw, ch, cx, cy) {
  const x0 = Math.max(0, Math.min(img.W - cw, cx - Math.floor(cw / 2)));
  const y0 = Math.max(0, Math.min(img.H - ch, cy - Math.floor(ch / 2)));
  const out = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) {
    const src = ((y0 + y) * img.W + x0) * 3;
    out.set(img.px.subarray(src, src + cw * 3), y * cw * 3);
  }
  return { png: encodePNG(cw, ch, out), W: cw, H: ch, px: out };
}