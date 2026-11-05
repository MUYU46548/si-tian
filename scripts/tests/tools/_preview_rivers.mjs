// 诊断用：把**产品自己的**河网直接光栅化成 PNG，用来肉眼判断"河网长成什么样"。
//
// ⚠️ 这不是产品渲染（画布那条链在 `ScenarioMap.vue` + `interaction/rivers.js`，走 canvas：
//    实心丝带 / 屏幕像素线宽 / 抗锯齿）。这里只做"够看的近似"：同一份几何（`buildRiverNetwork`
//    输出的河 + `getOffset/widthFromOffset` 的同一份宽度公式），线宽按世界单位画。
//    它要回答的问题只有一个：**拓扑对不对**（有没有漏河的孤段、有没有湖、主干分级是不是读得出来）。
//    观感（配色/丝带/海岸裁剪）仍以真机截图为准。
//
// 用法：
//   node scripts/tests/tools/_preview_rivers.mjs                       # 合成环岛地形（与 test_river_health 同源）
//   node scripts/tests/tools/_preview_rivers.mjs --cells 192 --seed 7
//   node scripts/tests/tools/_preview_rivers.mjs --project <x.sitian> --key desite
// 产物：build/river-preview/<tag>.png + 一行指标
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const SEA = 20;

function ringIsland(Rr) {
  const ring = [];
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const r = Rr * (1 + 0.08 * Math.sin(a * 3 + 0.7) + 0.05 * Math.sin(a * 7 - 1.1));
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return ring;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

async function buildFixture(cellsAcross, seed) {
  const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);
  const ring = ringIsland(380);
  const isLand = (x, y) => pointInRing(x, y, ring);
  return TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], {
    cellsAcross, seed, isLand,
    structureOverrides: { rangeWeight: 0.34, crossRangeWeight: 0.12, riftDepth: 0.22, plateauWeight: 0.28 },
  });
}

function buildFromProject(file, key) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bms = (j.scenarios && j.scenarios.baseMaps) || {};
  const bm = bms[key];
  if (!bm || !bm.heightmap) throw new Error(`底图 ${key} 没有高度图`);
  return bm.heightmap;
}

// ── 光栅（世界坐标 → 像素）────────────────────────────────────────────────────
function makeRaster(w, h) {
  const px = new Uint8Array(w * h * 3);
  const fill = (r, g, b) => { for (let i = 0; i < w * h; i++) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b; } };
  const set = (x, y, r, g, b, a = 1) => {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const i = (yi * w + xi) * 3;
    if (a >= 1) { px[i] = r; px[i + 1] = g; px[i + 2] = b; return; }
    px[i] = px[i] * (1 - a) + r * a;
    px[i + 1] = px[i + 1] * (1 - a) + g * a;
    px[i + 2] = px[i + 2] * (1 - a) + b * a;
  };
  const disc = (cx, cy, rad, r, g, b, a) => {
    const r2 = rad * rad;
    const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad);
    const y0 = Math.floor(cy - rad), y1 = Math.ceil(cy + rad);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) set(x, y, r, g, b, a);
      }
    }
  };
  const line = (x0, y0, x1, y1, rad, r, g, b, a = 1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, r, g, b, a);
    }
  };
  return { w, h, px, fill, set, disc, line };
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
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
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 高度 → 颜色（粗色带，只为分辨地形，不追产品的配色）
function landColor(t) {
  const stops = [
    [0.00, 150, 170, 120], [0.25, 170, 180, 120], [0.45, 190, 185, 130],
    [0.62, 185, 165, 125], [0.78, 175, 140, 115], [0.90, 200, 190, 185], [1.00, 245, 245, 245],
  ];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, r0, g0, b0] = stops[i];
    const [b, r1, g1, b1] = stops[i + 1];
    if (t <= b) {
      const u = b > a ? (t - a) / (b - a) : 0;
      return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u];
    }
  }
  return [245, 245, 245];
}

async function main() {
  const R = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
  const project = arg('project', '');
  const key = arg('key', 'desite');
  const cells = Number(arg('cells', '192'));
  const seed = Number(arg('seed', '7'));
  const tag = arg('tag', '') || (project ? `project-${key}` : `ring-${cells}`);

  const hm = project ? buildFromProject(project, key) : await buildFixture(cells, seed);
  const cols = hm.grid.cellsX | 0, rows = hm.grid.cellsY | 0;
  const pts = hm.grid.points;
  const h = hm.h;
  const spacing = hm.grid.spacing || 14.4;
  const lakeMap = new Map();
  for (const lk of (hm.lakes || [])) for (const i of (lk.cells || [])) lakeMap.set(i, lk.level);

  const t0 = Date.now();
  const minFlux = Number(arg('minflux', '0')) || undefined;
  const out = R.buildRiverNetwork(hm, minFlux ? { minFlux } : {});
  const genMs = Date.now() - t0;
  const segs = out.segments || [];
  const stats = out.stats || {};

  // 河链 = 引擎输出的"河"本身（每条河从源头到河口一条点列，含 meander）。
  // 宽度按上游 `getOffset` 的同一份公式算（与渲染侧同口径），再按全图归一化成像素。
  const fluxMax = stats.maxFlux || 1;
  const chains = (out.rivers || []).map((rv) => {
    let wmax = 0;
    const list = rv.points.map((p, k) => {
      const off = R.getOffset({
        flux: p.flux || 0, pointIndex: k, widthFactor: rv.widthFactor,
        startingWidth: rv.sourceWidth, fluxMax,
      });
      const w = R.widthFromOffset(off);
      if (w > wmax) wmax = w;
      return { ...p, w };
    });
    return {
      id: rv.id, parent: rv.parent, pts: list, flow: rv.discharge, wmax,
      endInSea: rv.endInSea, endInLake: rv.endInLake, endAtEdge: rv.endAtEdge, order: rv.order,
    };
  });

  // ── 画布 ──────────────────────────────────────────────────────────────────
  const W = 1200;
  const x0 = pts[0][0] - spacing, y0 = pts[0][1] - spacing;
  const worldW = (cols - 1) * spacing + spacing * 2;
  const worldH = (rows - 1) * spacing + spacing * 2;
  const scale = W / worldW;
  const H = Math.max(80, Math.ceil(worldH * scale));
  const ras = makeRaster(W, H);
  ras.fill(24, 40, 58);
  const X = (x) => (x - x0) * scale;
  const Y = (y) => (y - y0) * scale;
  const cellPx = Math.max(1, Math.round(spacing * scale));
  let landMax = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > SEA && h[i] > landMax) landMax = h[i];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const px0 = Math.round(X(pts[i][0] - spacing / 2));
      const py0 = Math.round(Y(pts[i][1] - spacing / 2));
      let col;
      if (h[i] <= SEA) {
        const d = Math.min(1, (SEA - h[i]) / 14);
        col = [120 - 60 * d, 175 - 60 * d, 210 - 50 * d];
      } else {
        col = landColor(Math.min(1, (h[i] - SEA) / Math.max(1, landMax - SEA)));
      }
      if (lakeMap.has(i)) col = [70, 140, 178];
      for (let y = py0; y < py0 + cellPx; y++) {
        for (let x = px0; x < px0 + cellPx; x++) ras.set(x, y, col[0], col[1], col[2]);
      }
    }
  }

  // 河链：按流量由细到粗（粗的压在上面，分叉处才不会被细线横切）
  const wGlobal = Math.max(1e-6, ...chains.map((c) => c.wmax));
  const sorted = chains.slice().sort((a, b) => a.flow - b.flow);
  const MAX_PX = 2.6, MIN_PX = 0.55;
  for (const ch of sorted) {
    const n = ch.pts.length;
    for (let k = 1; k < n; k++) {
      const wRel = Math.max(ch.pts[k - 1].w || 0, ch.pts[k].w || 0) / wGlobal;
      const px = Math.max(MIN_PX, MAX_PX * Math.pow(wRel, 0.55));
      ras.line(X(ch.pts[k - 1].x), Y(ch.pts[k - 1].y), X(ch.pts[k].x), Y(ch.pts[k].y),
        Math.max(0.5, (px / 2) * scale), 40, 96, 140);
    }
  }
  // "漏河的支流" = 沿 parent 链走不到海/湖/图边（= 真正的孤段，不是正常支流）
  const byId = new Map(chains.map((c) => [c.id, c]));
  const reachesWater = (c) => {
    let cur = c, guard = 0;
    while (cur && guard++ < 64) {
      if (cur.endInSea || cur.endInLake || cur.endAtEdge) return true;
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return false;
  };
  const orphans = chains.filter((c) => c.pts.length && !reachesWater(c));
  for (const ch of orphans) {
    for (let k = 1; k < ch.pts.length; k++) {
      ras.line(X(ch.pts[k - 1].x), Y(ch.pts[k - 1].y), X(ch.pts[k].x), Y(ch.pts[k].y), 1.2, 220, 60, 60);
    }
  }

  const outDir = path.join(ROOT, 'build', 'river-preview');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${tag}.png`);
  fs.writeFileSync(file, encodePNG(W, H, ras.px));

  const chainLens = chains.map((c) => c.pts.length).sort((a, b) => a - b);
  const med = chainLens.length ? chainLens[Math.floor(chainLens.length / 2)] : 0;
  const lakeCells = lakeMap.size;
  console.log(`[${tag}] ${cols}×${rows} 格 / 格距 ${spacing.toFixed(2)} / 湖 ${(hm.lakes || []).length} 处 ${lakeCells} 格`);
  console.log(`  引擎 ${genMs}ms / 段 ${segs.length} / 河 ${chains.length}（每条点数中位 ${med}）`);
  console.log(`  河终点：入海 ${chains.filter((c) => c.endInSea).length} / 入湖 ${chains.filter((c) => c.endInLake).length} / 漏河 ${orphans.length}`);
  console.log(`  等级：${chains.length ? `${Math.min(...chains.map((c) => c.order || 0))}–${Math.max(...chains.map((c) => c.order || 0))}` : '-'} / 统计 ${JSON.stringify(stats).slice(0, 220)}`);
  console.log(`  写出 ${path.relative(ROOT, file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
