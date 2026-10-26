// 出图（纯 Node，无依赖）：造陆轮廓 / 地形 / 河流的**观感存仓**
//
// 为什么要有这个工具：造陆的判据在 `scripts/tests/unit/test_landmass.js`（几何数值），
// 但"海岸像不像真的"只能看图。本文件把 `generateLandmass()` 的结果直接光栅化成 PNG
// （软件光栅 + 2× 超采样），供人眼判断与前后对照。
//
// 用法：
//   node scripts/tests/tools/render_landmass_preview.mjs --out build/landmass-v4 --seed 7
//   node scripts/tests/tools/render_landmass_preview.mjs --out build/x --shape archipelago --seed 1284
//   node scripts/tests/tools/render_landmass_preview.mjs --out build/x --crop "-200,-100,200,120"
// 参数：--seed --shape --ratio --rough --count --prov --w --h --crop --no-rivers --flat
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const OUT = path.resolve(ROOT, String(arg('out', 'build/landmass-preview')));
const SEED = Number(arg('seed', 7));
const SHAPE = String(arg('shape', 'continent'));
const RATIO = Number(arg('ratio', 0.32));
const ROUGH = Number(arg('rough', 0.45));
const COUNT = Number(arg('count', 3));
const PROV = Number(arg('prov', 180));
const W = Number(arg('w', 960));
const H = Number(arg('h', 540));
const SS = 2;                       // 超采样倍数（= 抗锯齿）
const SHOW_RIVERS = !arg('no-rivers', false);
const FLAT = !!arg('flat', false);
const BBOX = { minX: -900, minY: -500, maxX: 900, maxY: 500 };
// 只影响**渲染取景**（生成仍用整幅 bbox）：--crop x0,y0,x1,y1（世界坐标）用于放大看海岸
const CROP = String(arg('crop', '')) || null;
const VIEW = CROP
  ? (() => { const [a, b, c, d] = CROP.split(',').map(Number); return { minX: a, minY: b, maxX: c, maxY: d }; })()
  : BBOX;
// A/B 对照：`--src build/v3all/src/renderer/src/utils` 可以渲染**旧版本**的生成器
const SRC_DIR = arg('src') ? path.resolve(ROOT, String(arg('src'))) : SRC;

// ── 模块加载（与单测同一套"复制到临时目录 + 补 .js 后缀"的加载器）──────────────
function collectDeps(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = (() => {
      try { return fs.readFileSync(path.join(SRC_DIR, f), 'utf8'); } catch (_) { return ''; }
    })();
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+)'/g)) {
      const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-lm-'));
const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (m) => (m.includes(".js'") ? m : m.slice(0, -1) + ".js'"));
for (const f of collectDeps(['landmass.js', 'landmassRelief.js', 'riverRender.js'])) {
  try {
    fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  } catch (_) { /* 旧快照里可能没有新模块（landmassRelief）→ 跳过 */ }
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
const L = await import(pathToFileURL(path.join(tmp, 'landmass.js')).href);
// 画布侧画河的同一套（导入河/自动河共用 `smoothRiverLine`）——工具也用它，
// 否则"图上难看"可能只是工具没做圆角，与用户看到的不是一回事。
const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);
const LR = await import(pathToFileURL(path.join(tmp, 'landmassRelief.js')).href).catch(() => null);

// ── 光栅（RGB 浮点 + 2× 超采样 + 2×2 盒下采样）────────────────────────────────
function makeRaster(w, h) {
  const px = new Float32Array(w * h * 3);
  return {
    w, h, px,
    clear(r, g, b) {
      for (let i = 0; i < w * h; i++) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b; }
    },
    set(x, y, r, g, b) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    },
  };
}

/** 扫描线填充（even-odd：外环与洞一起喂进来，洞自然被挖掉） */
function fillRings(ras, rings, color) {
  const [r, g, b] = color;
  let minY = Infinity, maxY = -Infinity;
  for (const ring of rings) for (const p of ring) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(ras.h - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], c = ring[j];
        if ((a.y > sy) === (c.y > sy)) continue;
        xs.push(a.x + ((sy - a.y) * (c.x - a.x)) / (c.y - a.y));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(ras.w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) ras.set(x, y, r, g, b);
    }
  }
}

/** 粗线（按半径的圆盘沿段步进；2× 超采样下够平滑） */
function strokePolyline(ras, pts, color, width = 1, closed = false) {
  const [r, g, b] = color;
  const rad = Math.max(0.5, width / 2);
  const n = pts.length;
  const stamp = (x, y) => {
    const x0 = Math.ceil(x - rad), x1 = Math.floor(x + rad);
    const y0 = Math.ceil(y - rad), y1 = Math.floor(y + rad);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (Math.hypot(xx - x, yy - y) <= rad) ras.set(xx, yy, r, g, b);
      }
    }
  };
  const total = n + (closed ? 1 : 0);
  for (let i = 0; i + 1 < total; i++) {
    const a = pts[i % n], c = pts[(i + 1) % n];
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    const steps = Math.max(1, Math.ceil(len));
    for (let s = 0; s <= steps; s++) {
      stamp(a.x + ((c.x - a.x) * s) / steps, a.y + ((c.y - a.y) * s) / steps);
    }
  }
}

// ── 配色（海=深蓝，陆=黄褐，高地偏亮但不过曝）────────────────────────────────
const SEA = [22, 35, 59];
const COAST = [120, 104, 70];
const RIVER = [59, 130, 246];
const LAND_LO = [196, 176, 134];
const LAND_HI = [226, 216, 196];

function hyps(h, seaLevel) {
  if (h < seaLevel) return SEA;
  const t = Math.min(1, Math.max(0, (h - seaLevel) / Math.max(1, 100 - seaLevel)));
  const u = Math.pow(t, 0.85);
  return [
    LAND_LO[0] + (LAND_HI[0] - LAND_LO[0]) * u,
    LAND_LO[1] + (LAND_HI[1] - LAND_LO[1]) * u,
    LAND_LO[2] + (LAND_HI[2] - LAND_LO[2]) * u,
  ];
}

let RELIEF_SEA = 20;
// 地形栅格自己的海平面（**不是** stats.seaLevel —— 那是体元场的分位数，
// 与合成地形的高度口径不是一回事；混用会让海面在栅格里显示成浅水色/一块方框）
function reliefSeaOf(gen) {
  const r = gen && gen.relief;
  return r && Number.isFinite(r.seaLevel) ? r.seaLevel
    : (gen && gen.stats && Number.isFinite(gen.stats.seaLevel) ? gen.stats.seaLevel : 20);
}

/** 地形底图：高度场光栅 + 山体阴影（只有生成器回传 relief 时才有） */
function paintRelief(ras, relief, view) {
  const { w, h, data } = relief;
  const bw = view.maxX - view.minX, bh = view.maxY - view.minY;
  const s = Math.min(ras.w / bw, ras.h / bh);
  const ox = (ras.w - bw * s) / 2, oy = (ras.h - bh * s) / 2;
  const sp = relief.spacing || 1;
  const orx = (relief.origin && relief.origin.x) || 0;
  const ory = (relief.origin && relief.origin.y) || 0;
  for (let y = 0; y < ras.h; y++) {
    for (let x = 0; x < ras.w; x++) {
      const wx = (x - ox) / s + view.minX, wy = (y - oy) / s + view.minY;
      const fx = (wx - orx) / sp, fy = (wy - ory) / sp;
      if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) continue;
      const ix = Math.round(fx), iy = Math.round(fy);
      // 双线性采样（高度场通常比画布粗 → 直接最近邻会看到"格块"）
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const at = (i, j) => data[j * w + i] * (100 / 255);
      const hv = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty)
        + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
      const col = LR.reliefRgb(hv, RELIEF_SEA);
      const dhx = ((at(x1, y0) - at(x0, y0)) * (1 - ty)) + ((at(x1, y1) - at(x0, y1)) * ty);
      const dhy = ((at(x0, y1) - at(x0, y0)) * (1 - tx)) + ((at(x1, y1) - at(x1, y0)) * tx);
      const shade = hv >= RELIEF_SEA
        ? 1 + Math.max(-0.32, Math.min(0.32, (dhx + dhy) * 0.18))
        : 1;
      ras.set(x, y, col[0] * shade, col[1] * shade, col[2] * shade);
    }
  }
}

// ── PNG 编码（zlib + CRC32，无依赖）───────────────────────────────────────────
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
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 渲染一张候选 ─────────────────────────────────────────────────────────────
function renderOne(gen, file, view) {
  const BW = W * SS, BH = H * SS;
  const ras = makeRaster(BW, BH);
  // 底色 = 地形栅格的深海色（否则矩形贴图会在画面上露出一个方框边）
  const seaRgb = gen.relief && gen.relief.data && LR ? LR.reliefRgb(0, reliefSeaOf(gen)) : SEA;
  ras.clear(seaRgb[0], seaRgb[1], seaRgb[2]);
  const bw = view.maxX - view.minX, bh = view.maxY - view.minY;
  const s = Math.min(BW / bw, BH / bh);
  const ox = (BW - bw * s) / 2, oy = (BH - bh * s) / 2;
  const X = (x) => ox + (x - view.minX) * s;
  const Y = (y) => oy + (y - view.minY) * s;
  const mapRing = (pts) => pts.map((p) => ({ x: X(p.x), y: Y(p.y) }));

  if (!FLAT && gen.relief && gen.relief.data && gen.relief.w) {
    RELIEF_SEA = reliefSeaOf(gen);
    paintRelief(ras, gen.relief, view);
  } else {
    fillRings(ras, gen.rings.map((r) => mapRing(r.points)), LAND_LO);
    for (const r of gen.rings) for (const h of r.holes || []) fillRings(ras, [mapRing(h)], SEA);
  }

  // 湖：即使有地形底图也挖出来
  if (!FLAT && gen.relief) {
    for (const r of gen.rings) for (const h of r.holes || []) fillRings(ras, [mapRing(h)], [30, 58, 92]);
  }

  // 河流：按画布侧同款画法近似（Catmull-Rom 圆角 + 源头细→河口粗 + 深色岸线）
  if (SHOW_RIVERS && Array.isArray(gen.rivers) && gen.rivers.length) {
    const maxD = gen.rivers.reduce((a, r) => Math.max(a, Number(r.discharge) || 0), 0) || 1;
    const sorted = [...gen.rivers].sort((a, b) => (a.discharge || 0) - (b.discharge || 0));
    const stampTapered = (pts, baseW, color) => {
      const rad0 = Math.max(0.5, (baseW * 0.62) / 2);
      const rad1 = Math.max(0.5, baseW / 2);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], c = pts[i + 1];
        const t = i / Math.max(1, pts.length - 2);
        const rad = rad0 + (rad1 - rad0) * Math.pow(t, 1.6);
        const steps = Math.max(1, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y)));
        for (let s = 0; s <= steps; s++) {
          const x = a.x + ((c.x - a.x) * s) / steps, y = a.y + ((c.y - a.y) * s) / steps;
          const x0 = Math.ceil(x - rad), x1 = Math.floor(x + rad);
          const y0 = Math.ceil(y - rad), y1 = Math.floor(y + rad);
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              if (Math.hypot(xx - x, yy - y) <= rad) ras.set(xx, yy, color[0], color[1], color[2]);
            }
          }
        }
      }
    };
    for (const r of sorted) {
      const ctrl = (r.points || []).map((p) => ({ x: X(p.x), y: Y(p.y) }));
      if (ctrl.length < 2) continue;
      const pts = RR.catmullRomPoints(ctrl, 4);
      const t = Math.pow((Number(r.discharge) || 1) / maxD, 0.45);
      const w = (0.9 + 2.0 * t) * SS;
      stampTapered(pts, w + 0.8 * SS, [63, 100, 120]);      // 岸线（深一档）
      stampTapered(pts, w, RIVER);                          // 水面
    }
  }

  // 海岸线描边
  for (const r of gen.rings) {
    const pts = mapRing(r.points);
    if (pts.length >= 3) strokePolyline(ras, pts, COAST, 0.8 * SS, true);
  }

  // 下采样 → RGBA
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * BW + (x * SS + dx)) * 3;
          r += ras.px[i]; g += ras.px[i + 1]; b += ras.px[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * W + x) * 4;
      rgba[o] = Math.max(0, Math.min(255, r / n));
      rgba[o + 1] = Math.max(0, Math.min(255, g / n));
      rgba[o + 2] = Math.max(0, Math.min(255, b / n));
      rgba[o + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(W, H, rgba));
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const base = { seed: SEED, shape: SHAPE, landRatio: RATIO, roughness: ROUGH, continentCount: COUNT, provinceCount: PROV };
fs.mkdirSync(OUT, { recursive: true });
const t0 = performance.now();
const gen = L.generateLandmass(base, BBOX);
const ms = Math.round(performance.now() - t0);
const tag = `${SHAPE}-seed${SEED}${CROP ? '-crop' : ''}`;
const file = path.join(OUT, `landmass-${tag}.png`);
renderOne(gen, file, VIEW);

const verts = gen.rings.reduce((a, r) => a + r.points.length + (r.holes || []).reduce((b, h) => b + h.length, 0), 0);
console.log(JSON.stringify({
  file: path.relative(ROOT, file),
  ms,
  rings: gen.rings.length,
  holes: gen.stats.holeCount,
  verts,
  landRatio: +(gen.stats.landRatio * 100).toFixed(1),
  complexity: +gen.stats.coastComplexity.toFixed(1),
  seaLevel: gen.stats.seaLevel,
  fieldCells: gen.stats.fieldCells,
  meshPitch: +gen.stats.meshPitch.toFixed(1),
  rivers: (gen.rivers || []).length,
  riverPts: (gen.rivers || []).reduce((a, r) => a + r.points.length, 0),
  traced: gen.stats.tracedRivers,
  timings: gen.stats.timings,
}, null, 2));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
