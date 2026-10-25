// utils/landmass.js — **造陆**：按参数生成大陆/群岛轮廓（纯函数，零 DOM/Vue，Node 可测；2026-10-25）
//
// ── v3 重写（2026-10-25 用户判词：「从几坨面团变成了几坨花生酱」）──────────────
//   v1 = 每个大陆一个径向噪声圆；v2 = 椭圆掩膜 + 域扭曲噪声 + 分位数等值线。
//   两版都只有"场"，没有**成因**：海岸线是某个标量场的等值面，而场的骨架始终是几个椭圆，
//   所以怎么摇种子都是面团/花生酱。v3 分成"地形"与"海岸"两层：
//
//     ① **铺地形**（`landmassField.js`）：陆核（平顶二次衰减的丘）+ 陆核旁的**叶**
//        （半岛/岛链的基座）+ **山脊**（山脊的尾巴就是伸进海里的半岛）+ **海槽**
//        （从海里切进来的海湾/峡湾）+ **海峡**（取 min 压到海平面以下，真把大陆切开）；
//        再叠整幅 fBm 粗糙度 + **只作用在水陆交界一圈**的海岸带细节；
//     ② **定海平面**：按目标陆地占比取**格高分位数**（不是整体平移 —— 双峰分布下平移
//        只能让平台整块同时露出/没入，永远命中不了目标）；
//     ③ **描海岸**：抖动网格逐格判海陆，沿"陆/海"格边描闭合环（陆地始终在左侧），
//        方向即语义（外环 CCW / 湖 CW）；一次角切削掉直角台阶，再 RDP 简化。
//        ⚠️ v2 用两轮 Chaikin 把锯齿磨圆，正是"花生酱表面"的元凶；这里最多削一次角。
//     ④ 内陆低地（盆地）自然成为洞 = 湖泊，挂到包含它的陆块上。
//
//   判据（`test_landmass.js`）：同参数可复现、占比命中（格 ≤0.5pp / 多边形 ≤2pp）、
//   不重叠、不出界、湖泊存在、长条/群岛形状口径、roughness↑ → 海岸复杂度与顶点密度上升。
//
//   ⚠️ 随机只来自 `makeRng(seed)` 与整数哈希噪声 —— 本文件与 `landmassField.js` 都没有
//      `Math.random`（用例扫描源码守这条）。

import {
  createField, addBlob, addRidge, addStrait, maskField,
  modifyField, applyRoughness, addCoastDetail, flattenCoast, bandField,
} from './landmassField';

export const LANDMASS_VERSION = 3;

export const LAND_SHAPES = Object.freeze([
  { id: 'continent', name: '圆润大陆', aspect: 0.85, arms: 3, lobes: 4 },
  { id: 'elongated', name: '长条大陆', aspect: 0.38, arms: 4, lobes: 3 },
  { id: 'archipelago', name: '群岛', aspect: 0.95, arms: 2, lobes: 3 },
]);

const shapeOf = (id) => LAND_SHAPES.find((s) => s.id === id) || LAND_SHAPES[0];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pct = (v) => clamp(v, 0.5, 99.5);
const pctRange = (a, b) => [pct(Math.min(a, b)), pct(Math.max(a, b))];

// ── 布局：大陆中心（拒绝采样，保持角距）──────────────────────────────────
function layoutCenters(ctx, count, shape, rng) {
  const { cols, rows } = ctx;
  const minGap = Math.sqrt((cols * rows) / Math.max(1, count)) * 0.62;
  const centers = [];
  let gap = minGap;
  for (let round = 0; round < 80 && centers.length < count; round++) {
    const x = cols * (0.12 + 0.76 * rng());
    const y = rows * (0.14 + 0.72 * rng());
    if (centers.every(([cx, cy]) => (cx - x) ** 2 + (cy - y) ** 2 >= gap * gap)) {
      centers.push([x, y]);
    } else if (round > 40) {
      gap *= 0.92;              // 放不下就放宽间距（不无限重试）
    }
  }
  while (centers.length < count) { // 兜底：沿圆周均匀散开
    const a = (centers.length / count) * Math.PI * 2;
    centers.push([cols * (0.5 + Math.cos(a) * 0.28), rows * (0.5 + Math.sin(a) * 0.24)]);
  }
  if (shape.id === 'elongated') {
    // 长条大陆：中心沿**水平轴**排开，再靠 squash 把每块压扁（轴必须固定：
    // squash 只会压 y，若中心轴是斜的，压出来的长条方向和排布方向就对不上）
    const len = cols * 0.3;
    centers.sort((a, b) => a[0] - b[0]);
    centers.forEach((c, i) => {
      const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2;
      c[0] = cols * 0.5 + len * t + (c[0] - cols * 0.5) * 0.35;
      c[1] = rows * 0.5 + (c[1] - rows * 0.5) * 0.3;
    });
  }
  return centers;
}

/**
 * 参数 → 高度图步骤（**唯一"长什么样"的地方**；执行器/等值线/铺底都不用动）。
 *
 * 一个大陆的"解剖"（尺寸都由格半径 R 派生，换分辨率不会变形）：
 *   · 陆核：R*0.95 的平顶丘，高度 66~96，轮廓抖动 0.26；
 *   · 叶：3~5 个 R*0.26~0.46 的小丘贴在核外（半岛/岛链的基座，让轮廓不平整）；
 *   · 山脊：2~4 条从中心射向海里的脊线（R*1.1）——**山脊的尾巴就是半岛**；
 *   · 海槽：1~2 条从海里切进来的负脊线 → 海湾/峡湾；
 *   · 盆地：1~2 个负丘 → 校准后低于海平面 = 湖；
 *   · 全图：散点小岛、贯穿海峡、低频海槽与山脉，最后是海岸带细节 + 边缘淡出。
 */
export function buildLandSteps(ctx, params) {
  const { cols, rows, rng } = ctx;
  const shape = shapeOf(params.shape);
  const count = clamp(Math.round(params.continentCount || 3), 1, 8);
  const sizeVar = clamp(Number(params.sizeVariance) || 0, 0, 1);
  const rough = clamp(Number(params.roughness) || 0, 0, 1);
  const islandy = shape.id === 'archipelago';

  const centers = layoutCenters(ctx, count, shape, rng);
  const weights = centers.map(() => 1 - sizeVar + sizeVar * rng() ** 2);
  const maxW = Math.max(...weights);
  const baseR = Math.sqrt((cols * rows) / count / Math.PI);
  const shortSide = Math.min(cols, rows);

  const steps = [];
  const push = (fn) => steps.push(fn);
  const toPctX = (dx) => (dx / cols) * 100;
  const toPctY = (dy) => (dy / rows) * 100;

  // ⓪ **浅海底床**：把整张图铺满低矮起伏（高度 8~20，低于大陆、但不再是 0）。
  //    没有它，图幅里近一半格子是 0，目标占比分位数会落在 1~3 高度点 —— 海平面就成了
  //    "陆块脚印的边缘"，取出来只能是一个光滑大团。铺满之后分位数切在"浅海面"上，
  //    海岸线才会沿着底床与大陆的交接处蜿蜒，也才有近岸碎岛。
  push((c) => addBlob(c, {
    count: [10, 16],
    height: [8, 20],
    xr: [2, 98],
    yr: [4, 96],
    radius: Math.max(5, shortSide * 0.34),
    wobble: 0.4,
  }));

  centers.forEach(([cx, cy], idx) => {
    const w = weights[idx] / maxW;                       // 0..1（1 = 最大陆块）
    const R = Math.max(5, baseR * (islandy ? 0.3 : 0.36) * (0.6 + 0.55 * w));
    const cxPct = (cx / cols) * 100;
    const cyPct = (cy / rows) * 100;
    // 以中心为原点的偏移（格）→ 百分比区间（区间宽度 0 = 定点）
    const at = (dx, dy) => [
      pctRange(cxPct + toPctX(dx), cxPct + toPctX(dx)),
      pctRange(cyPct + toPctY(dy), cyPct + toPctY(dy)),
    ];

    // ① 陆架：一圈低矮的宽阔基座（高度刚过海平面）。它的作用是让模板在**定海平面之前**就
    //    覆盖足够大的面积 —— 分位数海平面只有落在"陆地高度分布"里面才切得出海岸；若大部分格
    //    是 0，分位数会落在 1~2 高度点，海平面就成了"陆块脚印的边缘"。定完海平面之后，
    //    陆架被淹掉大半，留下的是"浅海 + 碎海岸"。
    push((c) => addBlob(c, {
      count: [1, 1],
      height: [25 + rng() * 4, 32 + rng() * 4],
      xr: pctRange(cxPct - 0.6, cxPct + 0.6),
      yr: pctRange(cyPct - 0.6, cyPct + 0.6),
      radius: R * (islandy ? 1.1 : 1.4),
      squash: shape.aspect,
      wobble: 0.34,
      jitter: 1,
    }));

    // ② 陆核
    push((c) => addBlob(c, {
      count: [1, 1],
      height: [Math.round(66 + 16 * w), Math.round(84 + 12 * w)],
      xr: pctRange(cxPct - 0.6, cxPct + 0.6),
      yr: pctRange(cyPct - 0.6, cyPct + 0.6),
      radius: R * 0.95,
      squash: shape.aspect,
      wobble: islandy ? 0.34 : 0.26,
      jitter: 1,
    }));

    // ③ 叶：贴在核外的小丘（让大陆轮廓出现宽窄、凹口与近岸岛屿）
    const lobes = shape.lobes + Math.floor(rng() * 3);
    const a0 = rng() * Math.PI * 2;
    for (let a = 0; a < lobes; a++) {
      const ang = a0 + (a / lobes) * Math.PI * 2 + (rng() - 0.5) * 0.9;
      const dist = R * (0.55 + rng() * 0.35);
      const rr = R * (0.26 + rng() * 0.2);
      const [xr, yr] = at(Math.cos(ang) * dist, Math.sin(ang) * dist * shape.aspect);
      push((c) => addBlob(c, {
        count: [1, 1],
        height: [Math.round(26 + rng() * 8), Math.round(40 + rng() * 10)],
        xr,
        yr,
        radius: rr,
        wobble: 0.32,
      }));
    }

    // ④ 半岛臂：从中心射向海里的脊线（尾巴尖 = 半岛尖端）
    const arms = shape.arms + Math.floor(rng() * 2);
    for (let a = 0; a < arms; a++) {
      const ang = a0 + (a / arms) * Math.PI * 2 + (rng() - 0.5) * 0.6;
      const [xr, yr] = at(Math.cos(ang) * R * 0.4, Math.sin(ang) * R * 0.4 * shape.aspect);
      push((c) => addRidge(c, {
        count: [1, 1],
        height: [42 + rng() * 8, 56 + rng() * 8],
        xr,
        yr,
        radius: Math.max(1.6, R * 0.13),
        taper: 0.68,
      }));
    }

    // ⑤ 山脉：横穿主体的脊线（加高地形；山尾同样伸进海里）
    const vertical = rng() > 0.5;
    const spanX = vertical ? R * 0.6 : R * 1.8;
    const spanY = vertical ? R * 1.8 : R * 0.6;
    const ox = (rng() - 0.5) * R * 0.5, oy = (rng() - 0.5) * R * 0.5;
    push((c) => addRidge(c, {
      count: [1, 1],
      height: [58 + rough * 10, 74 + rough * 10],
      xr: pctRange(cxPct + toPctX(ox - spanX / 2), cxPct + toPctX(ox + spanX / 2)),
      yr: pctRange(cyPct + toPctY(oy - spanY / 2), cyPct + toPctY(oy + spanY / 2)),
      radius: Math.max(1.4, R * 0.11),
      taper: 0.35,
    }));

    // ⑥ 海湾：从外侧切进来的海槽（宽度 R*0.1，深度足够切到海平面以下）
    const troughs = 1 + (rng() > 0.5 ? 1 : 0);
    for (let q = 0; q < troughs; q++) {
      const ang = rng() * Math.PI * 2;
      const [xr, yr] = at(Math.cos(ang) * R * 0.7, Math.sin(ang) * R * 0.7 * shape.aspect);
      push((c) => addRidge(c, {
        count: [1, 1],
        height: [20 + rng() * 10, 30 + rng() * 10],
        xr,
        yr,
        radius: Math.max(1.4, R * 0.1),
        sign: -1,
        taper: 0.2,
      }));
    }

    // ⑦ 内陆盆地：负丘 → 分位数海平面之下，成为湖
    const pits = 1 + (rng() > 0.5 ? 1 : 0);
    for (let q = 0; q < pits; q++) {
      const [xr, yr] = at((rng() - 0.5) * R * 0.8, (rng() - 0.5) * R * 0.8 * shape.aspect);
      push((c) => addBlob(c, {
        count: [1, 1],
        height: [20 + rng() * 8, 30 + rng() * 8],
        xr,
        yr,
        radius: Math.max(2, R * 0.13),
        sign: -1,
        wobble: 0.3,
      }));
    }
  });

  // ⑧ 基础涌浪：再铺一层**中低丘**（高度 14~32，半径 0.22 短边），让浅海面本身有起伏 ——
  //    海岸线因此不是沿着一条光滑等值线走，而是沿着"底床 + 大陆"的交错带蜿蜒。
  push((c) => addBlob(c, {
    count: [6, 10],
    height: [14, 32],
    xr: [5, 95],
    yr: [8, 92],
    radius: Math.max(4, shortSide * 0.22),
    wobble: 0.36,
  }));

  // ⑨ 把陆高压向海平面：海岸带因此变宽、变碎（"真实海岸"最关键的一步）
  push((c) => modifyField(c, { range: 'land', mult: islandy ? 0.62 : 0.72 }));

  // ⑩ 散点小岛：全图撒，给主大陆外围补群岛
  push((c) => addBlob(c, {
    count: [count * (islandy ? 5 : 3), count * (islandy ? 7 : 4)],
    height: [24, 34],
    xr: [4, 96],
    yr: [6, 94],
    radius: Math.max(2, shortSide * (islandy ? 0.035 : 0.026)),
    wobble: 0.4,
  }));

  // ⑪ 贯穿海峡：把大陆真正切开（否则永远是一整坨）
  const straits = count > 1 ? 1 : 2;
  for (let s = 0; s < straits; s++) {
    push((c) => addStrait(c, { width: [2, 4], depth: 10, direction: s % 2 ? 'horizontal' : 'vertical' }));
  }

  // ⑫ 全图海槽 / 山脉：打碎大块陆地，造出内海与群岛
  push((c) => addRidge(c, {
    count: [2, 4],
    height: [22, 34],
    xr: [5, 95],
    yr: [10, 90],
    sign: -1,
    radius: Math.max(1.6, shortSide * 0.045),
    taper: 0.1,
  }));
  push((c) => addRidge(c, {
    count: [count, count + 2],
    height: [52, 76],
    xr: [6, 94],
    yr: [10, 90],
    radius: Math.max(1.6, shortSide * 0.05),
    taper: 0.4,
  }));
  push((c) => addBlob(c, {
    count: [2, 4],
    height: [20, 30],
    xr: [8, 92],
    yr: [12, 88],
    sign: -1,
    radius: Math.max(2, shortSide * 0.05),
    wobble: 0.3,
  }));

  // ⑬ 长条大陆：纵向带状窗（不压横向）—— 否则全球散点岛与山脊会把陆地摊成"方饼"
  if (shape.id === 'elongated') push((c) => bandField(c, 0.5, 0.36));
  // ⑭ 边缘淡出（图幅四周必须是海；海岸带细节在 `generateLandmass` 里按**动态海平面**叠，
  //    因为这里的海平面要到分位数算完才知道）
  push((c) => maskField(c, rough > 0.65 ? 1.4 : 1.8));

  return steps;
}

// ── 海岸：抖动网格 + 逐格判海陆 + 沿格边描环 ─────────────────────────────
//
// 为什么不用等值线（marching squares）：等值线是"平滑场的等值面"，240 格场上做出来
// 的海岸永远是**光滑的大弧**（实测：v2/v3 前几版无论怎么调噪声都是"花生酱"）。
// 真实地图（Azgaar / EU4）的海岸是**逐格判海陆后沿格边走出来的多边形**：格与格之间
// 一陆一海就落一条边，锯齿尺度 = 格宽，看起来才像"切出来的"海岸。
//
// 做法：抖动网格（顶点随机偏 ±0.28~0.78 格，随崎岖度）→ 每个格心双线性采样高度 →
// 按目标占比取格高分位数当海平面（占比精确命中）→ 只保留"陆格"的有向边界边
// （**陆地始终在左侧**）→ 按起点串环。因为方向统一，外环天然 CCW、湖/内海天然 CW，
// 不需要额外判内外。
function coastRingsFromMesh(sample, bbox, cellTarget, landRatio, rng, jitter = 0.5) {
  const W = bbox.maxX - bbox.minX;
  const H = bbox.maxY - bbox.minY;
  const nx = Math.max(10, Math.round(Math.sqrt(cellTarget * (W / H))));
  const ny = Math.max(8, Math.round(cellTarget / nx));
  const dx = W / nx, dy = H / ny;
  const vw = nx + 1, vh = ny + 1;
  const vx = new Float64Array(vw * vh);
  const vy = new Float64Array(vw * vh);
  // 顶点抖动幅度 = "海岸崎岖度"：抖动越大，同一份海陆判定的岸线越毛糙
  const J = Math.max(0, Math.min(0.9, jitter));
  for (let j = 0; j < vh; j++) {
    for (let i = 0; i < vw; i++) {
      const border = i === 0 || j === 0 || i === nx || j === ny;
      const ox = border ? 0 : (rng() - 0.5) * J * dx;
      const oy = border ? 0 : (rng() - 0.5) * J * dy;
      vx[j * vw + i] = bbox.minX + i * dx + ox;
      vy[j * vw + i] = bbox.minY + j * dy + oy;
    }
  }

  const n = nx * ny;
  const hc = new Float32Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      hc[j * nx + i] = sample(bbox.minX + (i + 0.5) * dx, bbox.minY + (j + 0.5) * dy);
    }
  }
  const sorted = Float32Array.from(hc);
  sorted.sort();
  const qi = Math.min(n - 1, Math.max(0, Math.round((1 - landRatio) * (n - 1))));
  const level = sorted[qi] + 1e-6;
  const land = new Uint8Array(n);
  let landCells = 0;
  for (let k = 0; k < n; k++) {
    if (hc[k] >= level) { land[k] = 1; landCells++; }
  }

  // 有向边界边（陆地始终在左侧 → 外环 CCW / 湖 CW）
  const edges = [];                     // [startVid, endVid]
  const vId = (i, j) => j * vw + i;
  const isLand = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : land[j * nx + i]);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!land[j * nx + i]) continue;
      if (!isLand(i, j - 1)) edges.push([vId(i, j), vId(i + 1, j)]);        // 下边
      if (!isLand(i + 1, j)) edges.push([vId(i + 1, j), vId(i + 1, j + 1)]); // 右边
      if (!isLand(i, j + 1)) edges.push([vId(i + 1, j + 1), vId(i, j + 1)]); // 上边
      if (!isLand(i - 1, j)) edges.push([vId(i, j + 1), vId(i, j)]);        // 左边
    }
  }
  const byStart = new Map();
  edges.forEach(([a], k) => {
    if (!byStart.has(a)) byStart.set(a, []);
    byStart.get(a).push(k);
  });
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let k = 0; k < edges.length; k++) {
    if (used[k]) continue;
    const startV = edges[k][0];
    const pts = [];
    let cur = k;
    let endV = -1;
    let guard = 0;
    while (cur != null && !used[cur] && guard++ <= edges.length) {
      used[cur] = 1;
      const [a, b] = edges[cur];
      pts.push({ x: vx[a], y: vy[a] });
      endV = b;
      const nexts = byStart.get(b) || [];
      const nk = nexts.find((x) => !used[x]);
      cur = nk == null ? null : nk;
    }
    if (endV === startV && pts.length >= 3) loops.push(pts);
  }
  return { loops, level, cells: n, landCells, cellRatio: n ? landCells / n : 0 };
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}
/** 角切：把网格的直角台阶削成斜边。一次 = 削角；两次 = 更圆润的礁石岸（再多就成"花生酱"）。 */
function cornerCut(pts, passes = 1) {
  let cur = pts;
  for (let k = 0; k < passes; k++) {
    const out = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      out.push({ x: a.x * 0.72 + b.x * 0.28, y: a.y * 0.72 + b.y * 0.28 });
      out.push({ x: a.x * 0.28 + b.x * 0.72, y: a.y * 0.28 + b.y * 0.72 });
    }
    cur = out;
  }
  return cur;
}
function rdp(pts, eps) {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const p = pts[a], q = pts[b];
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - p.x) * dy - (pts[i].y - p.y) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function pointInRing(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
const perimeterOf = (pts) => {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return L;
};

/** 目标陆地占比 → 高度分位数（= 海平面）。排序 3 万格是一次性的，几毫秒。 */
function quantileLevel(heights, landRatio) {
  const sorted = Float32Array.from(heights);
  sorted.sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((1 - landRatio) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * 生成一组大陆环。
 * @param {object} params 见 `terrainParams.normalizeLandParams`
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @returns {{version:number, seed:number, bbox:object, shape:string,
 *            rings:Array<{id:string, points:Array, holes:Array<Array>, area:number, center:object}>,
 *            stats:object}}
 */
export function generateLandmass(params, bbox) {
  const p = params || {};
  const seed = Math.max(0, Math.floor(Number(p.seed) || 7));
  const landRatio = clamp(Number(p.landRatio) || 0.32, 0.03, 0.8);
  const roughness = clamp(Number(p.roughness) || 0, 0, 1);
  const shape = shapeOf(p.shape);

  const W = Math.max(1, bbox.maxX - bbox.minX);
  const H = Math.max(1, bbox.maxY - bbox.minY);
  const longSide = Math.max(W, H);
  // 场分辨率：长边 ~240 格。体元模型对分辨率不敏感（半径是格数），240 格够画出
  // 5~10 格宽的海湾与 2~3 格宽的岛链，同时保证三张候选的生成时间在百毫秒级。
  const target = 240;
  const spacing = longSide / target;
  const cols = Math.max(24, Math.ceil(W / spacing) + 1);
  const rows = Math.max(24, Math.ceil(H / spacing) + 1);

  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const ctx = createField({ cols, rows, seed });
  const steps = buildLandSteps(ctx, { ...p, shape: shape.id, landRatio, roughness });
  for (const step of steps) step(ctx);
  const tSteps = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  applyRoughness(ctx, roughness, seed + 7001);
  // 海平面 = 目标占比对应的**分位数**。
  let seaLevel = quantileLevel(ctx.heights, landRatio);
  // 海岸带细节：**只叠在“当前海平面”那一圈**（±band）。分位数海平面是动态的，
  // 这里必须把 level 传进去 —— 早先写死 20，细节全叠错了地方，海岸因此依旧光滑。
  // 先做近岸压平：坡度不压缓，同样的噪声只能推动 1~2 格，海岸还是"整块"。
  flattenCoast(ctx, seaLevel, 0.45, 22);
  seaLevel = quantileLevel(ctx.heights, landRatio);
  addCoastDetail(ctx, 9 + roughness * 7, seed + 991, seaLevel);
  // 细节会把一部分格推过/推回海平面，重算一次分位数，保证占比仍然命中
  seaLevel = quantileLevel(ctx.heights, landRatio);
  const tField = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  // 海岸：抖动网格逐格判海陆 → 沿格边描环（见文件上半部分说明）
  const sampleField = (x, y) => {
    const fx = (x - bbox.minX) / spacing;
    const fy = (y - bbox.minY) / spacing;
    const i0 = clamp(Math.floor(fx), 0, cols - 1), j0 = clamp(Math.floor(fy), 0, rows - 1);
    const i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
    const tx = clamp(fx - i0, 0, 1), ty = clamp(fy - j0, 0, 1);
    const h00 = ctx.heights[j0 * cols + i0], h10 = ctx.heights[j0 * cols + i1];
    const h01 = ctx.heights[j1 * cols + i0], h11 = ctx.heights[j1 * cols + i1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  };
  // 6000 格：1800×1000 的图上约 18 世界单位/格（760px 预览里 ~7.5px），
  // 正好是"看得出锯齿但不碎成沙"的尺度（对照 Azgaar 的 ~12px）。
  // 格数也跟"海岸崎岖度"走：格子越细，岸线能表达的锯齿尺度越小（6k → 14k 格）
  const meshCells = Math.round(6000 + roughness * 8000);
  const mesh = coastRingsFromMesh(sampleField, bbox, meshCells, landRatio, ctx.rng, 0.28 + roughness * 0.5);
  const tContour = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  const minArea = W * H * 0.00012;
  const simpleEps = Math.min(W, H) / 420;
  const outers = [];
  const holes = [];
  for (const loop of mesh.loops) {
    const simplified = rdp(cornerCut(loop, 2), simpleEps);
    if (simplified.length < 3) continue;
    const sa = signedArea(simplified);
    if (Math.abs(sa) < minArea) continue;
    // 方向即语义：陆地始终在左 → 外环 CCW（正面积）、湖/内海 CW（负面积）
    if (sa > 0) outers.push({ points: simplified, area: sa });
    else holes.push({ points: simplified, area: -sa });
  }

  outers.sort((a, b) => b.area - a.area);
  // 洞挂到包含它的陆块（取面积最小的包含者）
  for (const h of holes) {
    const sample = h.points[0];
    let parent = null;
    for (const o of outers) {
      if (o.area <= h.area) continue;
      if (!pointInRing(sample, o.points)) continue;
      if (!parent || o.area < parent.area) parent = o;
    }
    if (parent && h.area > minArea * 2) {
      const ring = signedArea(h.points) > 0 ? h.points.slice().reverse() : h.points;
      (parent.holes || (parent.holes = [])).push(ring);
    }
  }

  const rings = outers.map((r, i) => ({
    id: `land_${seed}_${i}`,
    points: r.points,
    holes: r.holes || [],
    area: r.area,
    center: r.points.reduce((acc, pt) => ({ x: acc.x + pt.x / r.points.length, y: acc.y + pt.y / r.points.length }), { x: 0, y: 0 }),
  }));
  const holeArea = rings.reduce((a, r) => a + (r.holes || []).reduce((b, h) => b + Math.abs(signedArea(h)), 0), 0);
  const landArea = rings.reduce((a, r) => a + r.area, 0) - holeArea;
  const boxArea = W * H;
  const perimeter = rings.reduce((a, r) => a + perimeterOf(r.points)
    + (r.holes || []).reduce((b, h) => b + perimeterOf(h), 0), 0);

  return {
    version: LANDMASS_VERSION,
    seed,
    bbox: { ...bbox },
    shape: shape.id,
    rings,
    stats: {
      continentCount: clamp(Math.round(p.continentCount || 3), 1, 8),
      ringCount: rings.length,
      holeCount: rings.reduce((a, r) => a + (r.holes || []).length, 0),
      bboxArea: boxArea,
      landArea,
      landRatio: boxArea > 0 ? landArea / boxArea : 0,
      targetRatio: landRatio,
      // 海岸复杂度：总周长 / √陆地面积。"面团"这个指标低于 8，"有结构"的海岸在 14+
      coastComplexity: landArea > 0 ? perimeter / Math.sqrt(landArea) : 0,
      aspect: shape.aspect,
      roughness,
      fieldCells: cols * rows,
      spacing,
      // 海平面是**格高分位数**（目标占比决定），不是固定 20 —— 面板/用例别拿 20 当判据
      seaLevel: Math.round(mesh.level * 100) / 100,
      cellLandRatio: mesh.cellRatio,
      cells: mesh.cells,
      // 分段时间（ms）：生成器是同步跑的，面板卡不卡全看这几个数
      timings: { steps: Math.round(tSteps), field: Math.round(tField), contour: Math.round(tContour) },
    },
  };
}
