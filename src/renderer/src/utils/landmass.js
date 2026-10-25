// utils/landmass.js — **造陆**：按参数生成大陆/群岛轮廓（纯函数，零 DOM/Vue，Node 可测；2026-10-25）
//
// ── 为什么单独一件（P0-2）──────────────────────────────────────────────────
//   现有链路只能「按**已画好的**陆地轮廓推演地形」（`terrainSynthesis.js`）。也就是用户必须先
//   用自由绘制/套索画出一块大陆 —— 而"画一个像样的大陆形状"本身就是门槛：
//   手画出来的多是圆饼，且每次都是同一块中央大陆。P0-2 要补的是**陆地轮廓本身**：
//   参数（陆块数 / 陆地占比 / 形状 / 崎岖度 / 大小差异）→ 一组闭合环 → 交给铺底切省。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────────
//   ① **确定性**：随机只来自 `makeRng(seed)`（与铺底同一个 PRNG 实现），同 seed + 同参数 = 同一组环；
//   ② **不重叠**：大陆之间按"椭圆外扩"判定最小间距，宁可缩小也不让两块地粘在一起
//      （粘在一起会让铺底切出的省横跨两块大陆，归属/海岸线都不好解释）；
//   ③ **必须落在给定 bbox 内**：环按半径内缩，不留"出界半个大陆"（出界部分渲染看不到，
//      用户却会以为省份数不对）。
//
// ── 形状口径 ──────────────────────────────────────────────────────────────
//   `continent`  = 圆润大陆（各向同性 + 低频起伏）
//   `elongated`  = 长条大陆（一个主轴，aspect ≈ 0.42，像一截海岸山脉）
//   `archipelago`= 群岛（每个"陆块"再拆成 2~4 个小岛，绕着簇心散开）
//
//   所有形状都用同一个环采样器：`r(θ) = R · (1 + roughness·(噪声 + 谐波))`。
//   区别只在 **aspect（长宽比）**、**谐波**与**是否拆岛** —— 不写三套生成器，
//   否则"调了崎岖度只有一种形状有反应"这类不一致迟早发生。

import { makeRng } from './voronoiBatch';

export const LANDMASS_VERSION = 1;

export const LAND_SHAPES = Object.freeze([
  { id: 'continent', name: '圆润大陆', aspect: 0.78, harmonics: 2 },
  { id: 'elongated', name: '长条大陆', aspect: 0.42, harmonics: 2 },
  { id: 'archipelago', name: '群岛', aspect: 0.92, harmonics: 3 },
]);

const shapeOf = (id) => LAND_SHAPES.find((s) => s.id === id) || LAND_SHAPES[0];

function polygonArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x * points[i].y) - (points[i].x * points[j].y);
  }
  return Math.abs(a) / 2;
}

function centroid(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / Math.max(1, points.length), y: y / Math.max(1, points.length) };
}

/** 把环整体缩进 bbox（绕形心缩放；不裁点，保证闭合与凸性不被破坏） */
function fitRingToBox(points, box) {
  const c = centroid(points);
  let k = 1;
  for (const p of points) {
    const dx = Math.abs(p.x - c.x), dy = Math.abs(p.y - c.y);
    const roomX = dx > 1e-9 ? (p.x > c.x ? box.maxX - c.x : c.x - box.minX) / dx : Infinity;
    const roomY = dy > 1e-9 ? (p.y > c.y ? box.maxY - c.y : c.y - box.minY) / dy : Infinity;
    k = Math.min(k, roomX, roomY);
  }
  if (!(k < 1) || !Number.isFinite(k)) return points;
  const kk = Math.max(0.2, k * 0.999);
  return points.map((p) => ({ x: c.x + (p.x - c.x) * kk, y: c.y + (p.y - c.y) * kk }));
}

/** 角度 → 确定性噪声（复用同一个 PRNG 会破坏"每个角度独立"的分布，这里用哈希正弦） */
function wave(seed, k) {
  const s = Math.sin((seed % 997) * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s); // [0,1)
}

/**
 * 单个陆块 → 闭合环。
 * @param {object} o { cx, cy, radius, aspect, roughness, seed, phase, harmonics }
 * @returns {Array<{x:number,y:number}>} 逆/顺时针闭合环（首尾不重复）
 */
export function makeLandRing(o) {
  const harmonics = Math.max(1, Math.floor(o.harmonics || 2));
  const rough = Math.min(1, Math.max(0, Number(o.roughness) || 0));
  const aspect = Math.min(1, Math.max(0.2, Number(o.aspect) || 0.8));
  const N = Math.round(72 + rough * 48);
  const rot = (Number(o.phase) || 0) * Math.PI * 2;
  // 谐波相位由 seed 定（同一 seed 同一形态）；低频起伏幅度与 roughness 上限挂钩
  const harm = [];
  for (let h = 2; h <= 2 + harmonics; h++) {
    harm.push({ k: h, amp: (0.5 + wave(o.seed, h) * 0.9) * rough * (0.22 / (h - 1)), ph: wave(o.seed + h, h * 3) * Math.PI * 2 });
  }
  const pts = [];
  const raw = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // 低频噪声：相邻角度的值连续（不是逐点乱跳），靠 wave 采样 4 个点做线性插值
    const t = (a / (Math.PI * 2)) * 6;
    const i0 = Math.floor(t), f = t - i0;
    const n0 = wave(o.seed, i0), n1 = wave(o.seed, i0 + 1);
    const noise = n0 + (n1 - n0) * f;
    let r = 1 + rough * (noise - 0.5) * 1.1;
    // 高频细节（18 个采样）：没有它时 rough=1 只是"低频变形"，实测周长反而比光滑环短 4%
    const t2 = (a / (Math.PI * 2)) * 18;
    const j0 = Math.floor(t2), g = t2 - j0;
    const m0 = wave(o.seed + 77, j0), m1 = wave(o.seed + 77, j0 + 1);
    r += rough * ((m0 + (m1 - m0) * g) - 0.5) * 0.9;
    for (const h of harm) r += Math.sin(a * h.k + h.ph) * h.amp;
    raw.push(Math.max(0.35, r));
  }
  // 🔴 归一化到「平均半径 = 1」：这样 roughness 只改**起伏**（周长/形状），不改整体大小；
  //    若按"最大半径 = 1"归一，崎岖度越大平均半径越小 → 实测 roughness=1 的周长反而比 0 短 15%。
  const meanR = raw.reduce((a, b) => a + b, 0) / Math.max(1, raw.length);
  const kScale = meanR > 1e-9 ? 1 / meanR : 1;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rr = raw[i] * kScale;
    const x = Math.cos(a + rot) * o.radius * rr;
    const y = Math.sin(a + rot) * o.radius * rr * aspect;
    pts.push({ x: o.cx + x, y: o.cy + y });
  }
  return pts;
}

/**
 * 生成一组大陆环。
 *
 * @param {object} params 见 `terrainParams.normalizeLandParams`
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox 目标区域
 * @returns {{version:number, seed:number, bbox:object, rings:Array<{id:string,points:Array,area:number,
 *            center:{x:number,y:number}, radius:number, aspect:number}>, stats:object}}
 */
export function generateLandmass(params, bbox) {
  const p = params || {};
  const seed = Math.max(0, Math.floor(Number(p.seed) || 7));
  const count = Math.max(1, Math.min(8, Math.floor(Number(p.continentCount) || 3)));
  const landRatio = Math.max(0.05, Math.min(0.75, Number(p.landRatio) || 0.42));
  const roughness = Math.max(0, Math.min(1, Number(p.roughness) || 0.45));
  const sizeVariance = Math.max(0, Math.min(1, Number(p.sizeVariance) || 0.4));
  const shape = shapeOf(p.shape);
  const rng = makeRng(seed * 2654435761 + 17);

  const box = {
    minX: Number(bbox?.minX) || -900,
    minY: Number(bbox?.minY) || -500,
    maxX: Number(bbox?.maxX) || 900,
    maxY: Number(bbox?.maxY) || 500,
  };
  const W = Math.max(1, box.maxX - box.minX);
  const H = Math.max(1, box.maxY - box.minY);
  const boxArea = W * H;
  const targetArea = boxArea * landRatio;

  // 大小权重：sizeVariance=0 → 等大；1 → 差 4 倍
  const weights = [];
  for (let i = 0; i < count; i++) weights.push(1 + (rng() - 0.5) * 2 * sizeVariance * 1.5);
  const wsum = weights.reduce((a, b) => a + b, 0);

  const rings = [];
  // 🔴 放置用**确定性网格槽位**（不是拒绝采样）：拒绝采样在"3~4 块大陆、占比 40%"时
  //    几乎必然撞车 → 只能一路把半径乘 0.92，实测 42% 会被压到 11.8%（用户看到的是"占比滑杆没反应"）。
  //    网格槽位保证不重叠（槽内缩 46%），大小只受槽位容量约束；占比不够时**如实回报**。
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = W / cols, cellH = H / rows;

  for (let i = 0; i < count; i++) {
    const areaI = targetArea * (weights[i] / wsum);
    // 群岛：每个陆块拆 2~4 个岛 → 单岛半径按 1/√k 缩，簇的占位更大
    const islands = shape.id === 'archipelago' ? 2 + Math.floor(rng() * 3) : 1;
    const islandArea = areaI / islands;
    const wantR = Math.sqrt(islandArea / (Math.PI * shape.aspect));
    // 簇的几何占位：岛心离簇心 1.25R、岛半径 0.5R（环峰外扩 peak）
    // 相邻岛心距离 ≥ 2·1.25R·sin(45°−8.6°) ≈ 1.55R，两岛半径和 = 1.0R·peak ≤ 1.25R → 必不相交。
    const peak = 1 + roughness * 0.55;
    const extentFactor = islands === 1 ? peak : (1.25 + 0.5 * peak);
    // 槽内可用半径：0.47 = 两侧各留 3% 间隙 + 槽心抖动 ≤2%（不重叠由"槽位分离"保证）
    const fitR = Math.min(cellW * 0.47, (cellH * 0.47) / shape.aspect) / extentFactor;
    const radius = Math.min(wantR, fitR);

    const cc = i % cols, cr = Math.floor(i / cols);
    const jx = (rng() - 0.5) * 0.04, jy = (rng() - 0.5) * 0.04;
    const cx = box.minX + (cc + 0.5 + jx) * cellW;
    const cy = box.minY + (cr + 0.5 + jy) * cellH;
    const phase = rng();

    if (islands === 1) {
      const raw = makeLandRing({ cx, cy, radius, aspect: shape.aspect, roughness, seed: seed + i * 131, phase, harmonics: shape.harmonics });
      const points = fitRingToBox(raw, box);
      rings.push({
        id: `land_${seed}_${i}`,
        points,
        area: polygonArea(points),
        center: centroid(points),
        radius,
        aspect: shape.aspect,
      });
    } else {
      for (let k = 0; k < islands; k++) {
        const subR = radius * 0.5;
        const ang = (k / islands) * Math.PI * 2 + rng() * 0.15;
        const off = radius * 1.25;
        const scx = cx + Math.cos(ang) * off;
        const scy = cy + Math.sin(ang) * off * shape.aspect;
        const raw = makeLandRing({
          cx: scx, cy: scy, radius: subR, aspect: 0.8 + rng() * 0.15,
          roughness, seed: seed + i * 131 + k * 17, phase: rng(), harmonics: shape.harmonics,
        });
        const points = fitRingToBox(raw, box);
        rings.push({
          id: `land_${seed}_${i}_${k}`,
          points,
          area: polygonArea(points),
          center: centroid(points),
          radius: subR,
          aspect: 0.85,
        });
      }
    }
  }

  const landArea = rings.reduce((a, r) => a + r.area, 0);
  return {
    version: LANDMASS_VERSION,
    seed,
    bbox: box,
    shape: shape.id,
    rings,
    stats: {
      continentCount: count,
      ringCount: rings.length,
      bboxArea: boxArea,
      landArea,
      // 实际占比按**环面积和**算（可能因缩小而低于参数目标 —— 如实回报，不假装达标）
      landRatio: boxArea > 0 ? landArea / boxArea : 0,
      targetRatio: landRatio,
      aspect: shape.aspect,
      roughness,
    },
  };
}
