// P1 数据尺度审计（只读实验，2026-11-04）
//
// 问题：暮雨说“河流一直做不好，我怀疑是底图有问题”。要回答的不是“像不像”，是**格数够不够**。
// 做法：拿他真实世界的**轮廓**（415 个省的环），用产品自己的推演在 96 / 192 / 256 三档各生成一次，
// 再用产品自己的河网引擎跑一遍，量六个量；旧底图（97×45，存量数据）作为**对照样本**一并量。
//
// ⚠️ 只读：项目文件只读不写；产物全落 build/scale-audit/。
// ⚠️ 这是**量尺**，不是产品渲染：只为判断“河道有多长、分叉有多密”，观感以真机截图为准。
//
// 用法：node scripts/tests/tools/_audit_scale.mjs [--project <x.sitian>] [--key desite] [--seed 7]
import fs from 'fs';
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
const MIN_FLUX = Number(arg('minflux', '120'));
// 生成器的默认上限是 6 万格（超了会自动放粗格距）——审计要能看到 384/512 的**真实**曲线，必须放开。
const MAX_CELLS = Number(arg('maxcells', '220000'));

// ── PNG（zlib + CRC，无依赖；与 _preview_rivers 同一套做法）────────────────────
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

function landColor(t) {
  const stops = [[0, 150, 170, 120], [0.3, 175, 182, 124], [0.55, 190, 180, 132],
    [0.75, 178, 145, 118], [0.9, 200, 190, 185], [1, 245, 245, 245]];
  for (let i = 0; i + 1 < stops.length; i++) {
    const [a, r0, g0, b0] = stops[i], [b, r1, g1, b1] = stops[i + 1];
    if (t <= b) { const u = b > a ? (t - a) / (b - a) : 0; return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u]; }
  }
  return [245, 245, 245];
}

/**
 * 把一份高度图渲染成 PNG。
 * `win` 决定取景（世界坐标），`W` 决定像素宽 —— 两者一起决定“缩放”，
 * 于是同一份数据可以出 1× 全图和 4× 局部图（P1 判据里要的“1×/4× 观感”）。
 */
function render(hm, out, W = 1200, win = null) {
  const cols = hm.grid.cellsX, rows = hm.grid.cellsY, sp = hm.grid.spacing;
  const pts = hm.grid.points, h = hm.h;
  const fullX = pts[0][0] - sp / 2, fullY = pts[0][1] - sp / 2;
  const fullW = cols * sp, fullH = rows * sp;
  const x0 = win ? win.x0 : fullX, y0 = win ? win.y0 : fullY;
  const worldW = win ? win.w : fullW;
  const worldH = win ? win.h : fullH;
  const scale = W / worldW;
  const H = Math.max(40, Math.round(worldH * scale));
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
  const cellPx = Math.max(1, Math.ceil(sp * scale));
  for (let i = 0; i < h.length; i++) {
    const X = Math.round((pts[i][0] - sp / 2 - x0) * scale), Y = Math.round((pts[i][1] - sp / 2 - y0) * scale);
    let col;
    if (h[i] <= 20) { const d = Math.min(1, (20 - h[i]) / 14); col = [120 - 60 * d, 175 - 60 * d, 210 - 50 * d]; }
    else col = landColor(Math.min(1, (h[i] - 20) / Math.max(1, landMax - 20)));
    for (let y = Y; y < Y + cellPx; y++) for (let x = X; x < X + cellPx; x++) set(x, y, col[0] | 0, col[1] | 0, col[2] | 0);
  }
  // 河：每点宽度按 engine 的 getOffset（这里只做近似）
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
  return encodePNG(W, H, px);
}

async function main() {
  const R = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
  const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);
  const C = await import(pathToFileURL(path.join(UTILS, 'coastline.js')).href);
  const j = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
  const bm = j.scenarios.baseMaps[KEY];
  if (!bm) throw new Error(`项目里没有底图 ${KEY}`);
  const terrain = (bm.terrain || []).filter((t) => t && t.kind !== 'sea' && Array.isArray(t.points) && t.points.length >= 3);
  console.log(`轮廓 ${terrain.length} 个省 / 种子 ${SEED} / 闸门 ${MIN_FLUX}`);

  const rows = [];
  const outDir = path.join(ROOT, 'build', 'scale-audit');
  fs.mkdirSync(outDir, { recursive: true });

  const measure = (hm, label, msGen) => {
    const t0 = Date.now();
    const out = R.buildRiverNetwork(hm, { minFlux: MIN_FLUX });
    const msNet = Date.now() - t0;
    const lens = out.rivers.map((r) => r.cells.length).sort((a, b) => a - b);
    const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] : 0);
    const L = out.rivers.map((r) => r.length).sort((a, b) => a - b);
    const qL = (p) => (L.length ? L[Math.min(L.length - 1, Math.floor(L.length * p))] : 0);
    // 分叉点：有 ≥2 个子河的河（按 parent 计数）
    const kids = new Map();
    for (const r of out.rivers) if (r.parent) kids.set(r.parent, (kids.get(r.parent) || 0) + 1);
    const branch = [...kids.values()].filter((n) => n >= 2).length;
    const shortShare = out.rivers.length ? out.rivers.filter((r) => r.cells.length <= 4).length / out.rivers.length : 0;
    // 直线度（“梳子感”的量化）：|首尾直线距离| / 折线长。越接近 1 = 越像被梳子拉的直线。
    const straight = out.rivers
      .filter((r) => r.points && r.points.length >= 2 && (r.length || 0) > 20)
      .map((r) => {
        const a = r.points[0], b = r.points[r.points.length - 1];
        const chord = Math.hypot(b.x - a.x, b.y - a.y);
        return chord / Math.max(1e-6, r.length || 0);
      })
      .sort((x, y) => x - y);
    const straightP50 = straight.length ? +straight[Math.floor(straight.length / 2)].toFixed(3) : 0;
    // “有没有弯”比直线度更贴观感：离弦最远 > 1.5 世界单位 = 有弯（长河子集，短河不参与）
    const bent = out.rivers
      .filter((r) => r.points && r.points.length >= 3 && (r.length || 0) > 20)
      .map((r) => {
        const a = r.points[0], b = r.points[r.points.length - 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const L2 = dx * dx + dy * dy || 1e-9;
        let maxD = 0;
        for (const p of r.points) {
          const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
          const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
          if (d > maxD) maxD = d;
        }
        return maxD;
      });
    const bendShare = bent.length ? +((bent.filter((d) => d > 1.5).length / bent.length) * 100).toFixed(1) : 0;
    // 等高线台阶（“地形糊/马赛克”的量化）：4 邻域里跨色带的相邻格对占比
    const cols = hm.grid.cellsX, gy = hm.grid.cellsY;
    const hh = hm.h;
    let landMin = Infinity, landMax = -Infinity;
    for (let i = 0; i < hh.length; i++) if (hh[i] > 20) { if (hh[i] < landMin) landMin = hh[i]; if (hh[i] > landMax) landMax = hh[i]; }
    const band = Math.max(1e-6, (landMax - landMin) / 20);
    let pairs = 0, stepped = 0;
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (!(hh[i] > 20)) continue;
        if (x + 1 < cols && hh[i + 1] > 20) {
          pairs++;
          if (Math.floor((hh[i] - landMin) / band) !== Math.floor((hh[i + 1] - landMin) / band)) stepped++;
        }
        if (y + 1 < gy && hh[i + cols] > 20) {
          pairs++;
          if (Math.floor((hh[i] - landMin) / band) !== Math.floor((hh[i + cols] - landMin) / band)) stepped++;
        }
      }
    }
    const stat = {
      label, cols, rows: gy,
      cells: hh.length, spacing: +Number(hm.grid.spacing).toFixed(2),
      land: out.stats.land,
      landPct: +((out.stats.land / hh.length) * 100).toFixed(1),
      rivers: out.rivers.length,
      cellsP50: q(0.5), cellsP90: q(0.9),
      lenP50: Math.round(qL(0.5)), lenP90: Math.round(qL(0.9)), lenMax: Math.round(qL(1)),
      branch, branchPer10k: +(branch / Math.max(1, out.stats.land) * 10000).toFixed(1),
      straightP50, bendShare,
      shortShare: +(shortShare * 100).toFixed(1),
      contourStep: +((stepped / Math.max(1, pairs)) * 100).toFixed(1),
      endInSea: out.stats.endInSea, endInLake: out.stats.endInLake,
      maxOrder: out.stats.maxOrder,
      msGen, msNet,
    };
    rows.push(stat);
    const png = render(hm, Object.assign(out, { R }));
    fs.writeFileSync(path.join(outDir, `${label}.png`), png);
    // 4× 局部：取最长那条河的中点，窗口 = 图幅的 1/4
    const longest = out.rivers.slice().sort((a, b) => (b.length || 0) - (a.length || 0))[0];
    const mid = longest && longest.points ? longest.points[Math.floor(longest.points.length / 2)] : null;
    const worldW = cols * Number(hm.grid.spacing), worldH = gy * Number(hm.grid.spacing);
    if (mid) {
      const w = worldW / 4, hh2 = worldH / 4;
      const win = { x0: mid.x - w / 2, y0: mid.y - hh2 / 2, w, h: hh2 };
      const png4 = render(hm, Object.assign(out, { R }), 1200, win);
      fs.writeFileSync(path.join(outDir, `${label}-x4.png`), png4);
    }
    console.log(JSON.stringify(stat));
    return stat;
  };

  // 0) 旧底图（存量 97×45）—— 对照样本：这是“现在难看”的那张
  const oldHm = bm.heightmap;
  if (oldHm && oldHm.grid && oldHm.h) {
    measure({ grid: oldHm.grid, h: Float64Array.from(oldHm.h), lakes: oldHm.lakes }, '00-stored-' + oldHm.grid.cellsX + 'x' + oldHm.grid.cellsY, 0);
  }

  // 1) 用同一份轮廓重新推演 96 / 192 / 256 / 384 / 512
  // ⚠️ 必须传 `isLand`：`synthesizeHeightmapFromTerrain` 不会自己从多边形推陆地掩膜
  //    （没传 → 陆格 0 → 返回 null，实测踩到）。这里用产品自己的 `buildLandMask`（与渲染/裁岸同一份）。
  const mask = C.buildLandMask(terrain);
  const tiers = [96, 192, 256, 384, 512];
  for (let ti = 0; ti < tiers.length; ti++) {
    const ca = tiers[ti];
    const t0 = Date.now();
    const hm = TS.synthesizeHeightmapFromTerrain(terrain, { cellsAcross: ca, seed: SEED, isLand: mask.lookup, maxCells: MAX_CELLS });
    const msGen = Date.now() - t0;
    if (!hm) { console.error(`cellsAcross=${ca} 推演失败`); continue; }
    measure({ grid: hm.grid, h: Float64Array.from(hm.h), lakes: hm.lakes }, `${String(ti + 1).padStart(2, '0')}-gen-${ca}`, msGen);
  }

  // 海岸线曲折度（按省级轮廓，**与格数无关** —— 它量的是“原始数据里有多少弯”）
  const sinuosity = (poly) => {
    let a = 0, p = 0;
    for (let i = 0; i < poly.length; i++) {
      const q1 = poly[i], q2 = poly[(i + 1) % poly.length];
      a += (q1.x ?? q1[0]) * (q2.y ?? q2[1]) - (q2.x ?? q2[0]) * (q1.y ?? q1[1]);
      p += Math.hypot((q2.x ?? q2[0]) - (q1.x ?? q1[0]), (q2.y ?? q2[1]) - (q1.y ?? q1[1]));
    }
    a = Math.abs(a) / 2;
    return a > 1e-6 ? (p * p) / (4 * Math.PI * a) : 0;
  };
  const sins = terrain.map((t) => sinuosity(t.points)).filter((x) => x > 0).sort((x, y) => x - y);
  const coastSinuosity = sins.length ? +sins[Math.floor(sins.length / 2)].toFixed(2) : 0;

  // 汇总：判据门槛（中位格数 ≥ 8 且 ≤4 格占比 < 25%）在哪个档第一次满足
  const gen = rows.filter((r) => r.label.indexOf('-gen-') > 0);
  const hit = gen.find((r) => r.cellsP50 >= 8 && r.shortShare < 25);
  // 外推只在“曲线还在单调变好”时才做 —— 格数被 maxCells 截住时曲线会饱和，
  // 硬外推会给出一个假数字（第一版就输出了“cellsAcross ≈ 896”，而实际格网卡在 329×150）。
  const mono = gen.length >= 2 && gen[gen.length - 1].cellsP50 > gen[gen.length - 2].cellsP50;
  let extrapolate = '';
  if (!hit && mono) {
    const a = gen[gen.length - 2], b = gen[gen.length - 1];
    const dCells = b.cellsP50 - a.cellsP50;
    const caA = Number(a.label.split('-').pop()), caB = Number(b.label.split('-').pop());
    const needCa = caB + ((8 - b.cellsP50) / dCells) * (caB - caA);
    extrapolate = `中位格数还在随档位上升（${a.cellsP50} → ${b.cellsP50}），按这两档线性外推：`
      + `到 8 大约需要 **cellsAcross ≈ ${Math.round(needCa / 32) * 32}**。`;
  } else if (!hit) {
    extrapolate = '最近两档的中位格数**没有继续上升**（曲线已饱和）—— 说明卡住的不是 `cellsAcross` 参数，'
      + '而是本轮的上限/地形本身，外推没有意义；要么放开 `maxCells` 再跑，要么改地形生成（侵蚀/平滑）。';
  }

  const md = [
    '# 尺度审计（P1，2026-11-04 复跑）',
    '',
    `项目：\`${path.basename(PROJECT)}\` / 底图 \`${KEY}\` / 轮廓 ${terrain.length} 省 / 种子 ${SEED} / 闸门 ${MIN_FLUX}`,
    '',
    `- **海岸线曲折度（省级轮廓，分辨率无关）**：面积加权中位 **${coastSinuosity}**（1 = 圆；越大越碎）。`,
    '- 产物：每档 `<label>.png`（1× 全图）与 `<label>-x4.png`（4× 局部，取最长河中点）。',
    '',
    '| 样本 | 格网 | 格距 | 陆地格 | 河数 | 中位格数 | 长度中位 | 长度p90 | 最长 | 分叉点 | 每万格分叉 | 直线度中位 | 有弯占比 | ≤4格占比 | 跨色带相邻格 | 最高级 | 建网 ms |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.cols}×${r.rows} | ${r.spacing} | ${r.land} | ${r.rivers} | ${r.cellsP50} | ${r.lenP50} | ${r.lenP90} | ${r.lenMax} | ${r.branch} | ${r.branchPer10k} | ${r.straightP50} | ${r.bendShare}% | ${r.shortShare}% | ${r.contourStep}% | ${r.maxOrder} | ${r.msNet} |`),
    '',
    '> 判据口径：`中位格数` = 一条河由几个格子组成；`长度` 是世界单位（图幅约 1775×824）；',
    '> `跨色带相邻格` = 4 邻域里落在不同高度色带的相邻格对占比（越高越像马赛克）；',
    '> `每万格分叉` = 分叉点数 / 陆地格 × 10000（跨档可比）。',
    '',
    '## 结论',
    '',
    hit ? `**${hit.label}** 第一次同时满足“中位格数 ≥ 8”与“≤4 格占比 < 25%”。` : '五档**都没到**门槛（中位格数 ≥ 8 且 ≤4 格占比 < 25%）。',
    '',
    extrapolate,
    '',
    '## 已知局限（写清楚，别当成通过）',
    '',
    '1. 这里量的是**推演 + 河网引擎**，不是真机单帧耗时；真机帧时得用 `shot_real_project.py` 另测。',
    '2. `河流条目数` 随面积涨、`长度` 按世界单位算，两者不能直接跨档比“密度”。',
    '3. 4× 局部图用的是产品引擎的近似画法（`getOffset` + 圆盘描边），不是画布的真实线宽。',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md, 'utf8');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log('\n' + md);
}

main().catch((e) => { console.error(e); process.exit(1); });
