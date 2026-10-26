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
// ── v4 增量（2026-10-25 用户判词：「放大到很近时仍能看出多边形感」）──────────────
//   v3 的拓扑（抖动网格逐格判海陆）是对的，但**几何也来自网格顶点**：18 单位一格的方形网格
//   让 45° 海岸必然是等长台阶（实测中位边长 17.6 单位）。v4 只动尺度，不动拓扑：
//     ① 网格加密到 24k~40k 格（6~8 单位/格）+ 抖动拉满 ±0.45 格（格边方向被随机化）；
//     ② 顶点**吸附到等值线**（`snapLoopToLevel`）：几何由高度场决定，不再由格距决定；
//     ③ 地形换成"轮廓定形状、`terrainSynthesis` 定山"的分工（体元场没有排水结构，
//        合成地形才有山脉/高原/裂谷）——预览缩略图因此能画成地形图，而不是一块平涂土黄。
//   ⚠️ 河流这一轮**没有出货**（理由与证据见 `⑤b` 上方注释与 archive 记录）。
//
//   ⚠️ 随机只来自 `makeRng(seed)` 与整数哈希噪声 —— 本文件与 `landmassField.js` 都没有
//      `Math.random`（用例扫描源码守这条）。

import {
  createField, addBlob, addRidge, addStrait, maskField,
  modifyField, applyRoughness, addCoastDetail, flattenCoast, bandField,
  refineField, fbm,
} from './landmassField';
import { synthesizeHeightmapFromTerrain } from './terrainSynthesis';
import { inciseByFlow } from './terrainErosion';
import { traceRivers, clipPolylineToLand } from './riverTrace';
import { flowToDischargeEquivalent } from './riverRender';
import { buildRiverPaths } from './riverChains';

export const LANDMASS_VERSION = 4;

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

    // ── 长条大陆：**一条脊柱上的若干核**（不是"把整张图压成一条带"）─────────────
    // 🔴 用户原话：「长条模式也只是'窄带'而不是天然的地峡/半岛链」。v3 的做法是
    //    "一个压扁的椭圆 + 纵向带窗"，所以出来是一条等宽的香肠。这里改成：
    //    · 脊柱上 4~6 个**半径不等**的核（中段最宽，偶发窄颈 → 地峡）；
    //    · 脊柱本身**弯曲**（bow），不是直尺；
    //    · 1~2 条**横向半岛**从脊柱垂直射进海里（长条也有岬角）；
    //    · 两端各一枚小岛（尾巴 = 岛链，把"长条"延伸到海上）。
    if (shape.id === 'elongated') {
      const spineLen = R * (3.0 + 0.8 * rng());
      const segs = 5 + Math.floor(rng() * 3);
      const bow = (rng() - 0.5) * R * 0.7;
      const fat = 0.3 + rng() * 0.24;
      const nodes = [];
      for (let n = 0; n < segs; n++) {
        const t = segs > 1 ? n / (segs - 1) - 0.5 : 0;
        const neck = n > 0 && n < segs - 1 && rng() < 0.34 ? 0.45 : 1;   // 窄颈 = 地峡
        const rr = R * (0.3 + fat * Math.cos(t * Math.PI) ** 2) * neck;
        nodes.push({
          dx: t * spineLen,
          dy: bow * Math.sin(t * Math.PI * 1.2) + (rng() - 0.5) * R * 0.14,
          rr,
          h: Math.round(66 + 22 * (1 - Math.abs(t) * 1.5) + rng() * 8),
        });
      }
      for (const nd of nodes) {
        const [xr, yr] = at(nd.dx, nd.dy);
        push((c) => addBlob(c, {
          count: [1, 1], height: [26, 33], xr, yr,
          radius: nd.rr * 1.5, squash: 0.62, wobble: 0.34,
        }));
      }
      for (const nd of nodes) {
        const [xr, yr] = at(nd.dx, nd.dy);
        push((c) => addBlob(c, {
          count: [1, 1], height: [nd.h, nd.h + 12], xr, yr,
          radius: nd.rr, squash: 0.62, wobble: 0.3,
        }));
      }
      // 横向半岛：从脊柱中段垂直射出去（脊线尾巴 = 岬角）
      const arms = 1 + (rng() < 0.5 ? 1 : 0);
      for (let a = 0; a < arms; a++) {
        const nd = nodes[1 + Math.floor(rng() * Math.max(1, nodes.length - 2))];
        const side = a === 0 ? 1 : -1;
        const [xr, yr] = at(nd.dx, nd.dy + side * R * 0.45);
        push((c) => addRidge(c, {
          count: [1, 1], height: [46 + rng() * 8, 58 + rng() * 8],
          xr, yr, radius: Math.max(1.5, R * 0.1), taper: 0.62,
        }));
      }
      // 两端尾巴：脊柱延长线上的小岛（岛链感）
      for (const side of [-1, 1]) {
        const [xr, yr] = at(side * (spineLen / 2 + R * 0.55), (rng() - 0.5) * R * 0.3);
        push((c) => addBlob(c, {
          count: [1, 1], height: [26 + rng() * 6, 36 + rng() * 6], xr, yr,
          radius: R * (0.16 + rng() * 0.12), squash: 0.7, wobble: 0.36,
        }));
      }
      return;
    }

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

  // ⑬ 长条大陆：纵向带状窗（不压横向）—— 否则全球散点岛与山脊会把陆地摊成"方饼"。
  //    半高 0.36 → 0.44：v4 的长条是"脊柱 + 窄颈 + 横向半岛"，太窄的带窗会把半岛切掉。
  if (shape.id === 'elongated') push((c) => bandField(c, 0.5, 0.44));
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
 * **把环上的顶点贴到真正的等值线上**（v4 的海岸几何收口）。
 *
 * 拓扑来自抖动网格（逐格判海陆，天然不会自交/不会丢湖），但**几何**来自高度场：
 * 网格顶点只是"格子角上离海最近的采样点"，所以岸线会带着格网的步进。
 * 这里让每个顶点沿高度梯度走到 `h = seaLevel` 的那条等值线上（牛顿一步 + 位移上限），
 * 于是岸线的形状由地形决定，而不是由格距决定 —— 放大看不再是一段段等长的台阶。
 *
 * ⚠️ 位移上限 = 1.2 个采样步长（≈ 半个场格）：岸线最窄处（一格宽的地峡）不会被拽到对面，
 *    也不会因为平坦区梯度趋近 0 而飞出老远（`g2 < eps` 时原地不动）。
 */
function snapLoopToLevel(pts, sample, level, step, bbox) {
  const out = new Array(pts.length);
  const cap = step * 1.2;
  const minX = bbox ? bbox.minX : -Infinity, maxX = bbox ? bbox.maxX : Infinity;
  const minY = bbox ? bbox.minY : -Infinity, maxY = bbox ? bbox.maxY : Infinity;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const h = sample(p.x, p.y);
    const gx = sample(p.x + step, p.y) - sample(p.x - step, p.y);
    const gy = sample(p.x, p.y + step) - sample(p.x, p.y - step);
    const g2 = gx * gx + gy * gy;
    if (!(g2 > 1e-12)) { out[k] = p; continue; }
    const t = (level - h) / g2;
    let dx = gx * t, dy = gy * t;
    const dl = Math.hypot(dx, dy);
    if (dl > cap) { dx *= cap / dl; dy *= cap / dl; }
    // 贴到等值线之后仍须落在图幅内（a2 判据：**所有**顶点不许出界）
    out[k] = {
      x: clamp(p.x + dx, minX, maxX),
      y: clamp(p.y + dy, minY, maxY),
    };
  }
  return out;
}

/** 整数哈希 → [0,1)（确定性微起伏用；本文件不许出现 `Math.random`） */
function hash01(x, seed) {
  let h = (Math.imul(Math.round(x * 1000) | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * **把陆地环光栅化成掩膜**（even-odd：外环与洞一起扫，洞自然变成水）。
 *
 * 为什么不用"逐格点在多边形里"：12 个环 × 2000 顶点 × 3 万格 = 7 亿次边测试。
 * 扫描线是 O(行数 × 边数)，同一份环在 250 行上只有 60 万次。
 *
 * 掩膜是**下游三件事的同一份陆地定义**：合成地形（`synthesizeHeightmapFromTerrain`）、
 * 河源/河口（`traceRivers` 的 `isLand`）、以及"把河裁到海岸"。三者若各判一次，
 * 就会出现"河从海里起步"或"河口悬在岸外"这类**看着只是别扭、查起来极难**的问题。
 */
function rasterizeLandMask(rings, bbox, cols, rows) {
  const sx = (bbox.maxX - bbox.minX) / Math.max(1, cols - 1);
  const sy = (bbox.maxY - bbox.minY) / Math.max(1, rows - 1);
  const mask = new Uint8Array(cols * rows);
  // 边表（世界坐标）
  const edges = [];
  for (const r of rings) {
    for (const ring of [r.points, ...(r.holes || [])]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        if (a.y === b.y) continue;
        edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
      }
    }
  }
  const xs = [];
  for (let j = 0; j < rows; j++) {
    const wy = bbox.minY + j * sy;
    xs.length = 0;
    for (const e of edges) {
      if ((e.y0 > wy) === (e.y1 > wy)) continue;
      xs.push(e.x0 + ((wy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - bbox.minX) / sx));
      const i1 = Math.min(cols - 1, Math.floor((xs[k + 1] - bbox.minX) / sx));
      for (let i = i0; i <= i1; i++) mask[j * cols + i] = 1;
    }
  }
  const isLand = (x, y) => {
    // 🔴 **掩膜范围之外一律是海**。这里曾经用 clamp 把界外坐标夹到边上，
    //    而掩膜的 bbox 恰好是"陆地自己的包围盒"→ 边缘那一圈是陆地 → 夹完以后
    //    合成地形四周的 pad 也变成陆地，栅格陆地占比从 32% 涨到 41%（a10 当场抓住）。
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) return false;
    const i = Math.round((x - bbox.minX) / sx);
    const j = Math.round((y - bbox.minY) / sy);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
    return mask[j * cols + i] === 1;
  };
  let land = 0;
  for (let i = 0; i < mask.length; i++) land += mask[i];
  return { mask, cols, rows, spacing: sx, isLand, landCells: land };
}

/**
 * **多尺度丘陵**：在地形里撒一批半径/高度各异的丘与盆（Azgaar 的 `addHill` / `addBlob` 同款思路）。
 *
 * 🔴 为什么必须有（第四轮实测结论，写下来免得再试）：
 *   `terrainSynthesis` 的地形 = **一个离岸距离穹顶** + 一层**各向异性**脊线。
 *   穹顶上每一格的"最陡方向"都指向海岸 → D8 流线天然是**放射状 / 平行**的；
 *   各向异性脊线又让水在平行的谷里平行下流。两者叠加，画出来就是"一片 45° 直线"
 *   （顺手做过的三件事都没救回来：加大脊线权重、局部起伏放大 1.8×、按流向场下切 3 轮 ——
 *    它们都只是把同一批直线切深/弄弯，没有改变"水往哪走"）。
 *
 *   真实地形的坡是被**一堆大小不一的丘**弄乱的：水先流进小洼、翻过鞍部、再汇进大河。
 *   所以这里按 `1/r` 的幂律撒丘（小丘多、大丘少），并让 30% 是**负丘（盆）** ——
 *   盆地正是"水留一会儿再走"的地方，也是树枝状水系的分叉点。
 *
 * @param {{h:number[], grid:{cellsX:number,cellsY:number,spacing:number}}} hm 就地修改
 * @param {{count:number, rMin:number, rMax:number, ampMin:number, ampMax:number,
 *          seaLevel?:number, rng:()=>number}} opts `rMin/rMax` 是**格**；`amp` 是高度点
 * @returns {{placed:number, skipped:number}}
 */
function scatterHills(hm, opts) {
  const { cellsX: cols, cellsY: rows } = hm.grid;
  const sea = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 20;
  const rng = opts.rng;
  const count = Math.max(0, Math.round(opts.count));
  let placed = 0, skipped = 0, guard = 0;
  while (placed < count && guard++ < count * 30) {
    const ci = 2 + Math.floor(rng() * Math.max(1, cols - 4));
    const cj = 2 + Math.floor(rng() * Math.max(1, rows - 4));
    const ck = cj * cols + ci;
    if (hm.h[ck] < sea + 0.6) { skipped++; continue; }        // 只落在陆地上
    // 半径按 1/r 幂律：小丘多、大丘少（真实地形的"丘陵谱"就长这样）
    const r = opts.rMin + (opts.rMax - opts.rMin) * Math.pow(rng(), 1.7);
    const amp = (opts.ampMin + (opts.ampMax - opts.ampMin) * Math.pow(rng(), 1.4))
      * (rng() < (opts.basinRate == null ? 0.3 : opts.basinRate) ? -1 : 1);
    const i0 = Math.max(1, Math.floor(ci - r)), i1 = Math.min(cols - 2, Math.ceil(ci + r));
    const j0 = Math.max(1, Math.floor(cj - r)), j1 = Math.min(rows - 2, Math.ceil(cj + r));
    for (let jj = j0; jj <= j1; jj++) {
      for (let ii = i0; ii <= i1; ii++) {
        const d = Math.hypot(ii - ci, jj - cj) / r;
        if (d >= 1) continue;
        const f = (1 - d * d) ** 2;
        const k = jj * cols + ii;
        // 🔴 **只动陆地格**：丘的圆盘会越过海岸线。若把海格也抬过 20，栅格里的陆地就比
        //    海岸环多出一圈（实测面积 +21%，a10 当场抓住），而省份是按环切的 ——
        //    画面上就是"水里明明该有省，却没有"。
        if (hm.h[k] < sea + 0.6) continue;
        // 负丘（盆）不许把陆地压到海平面以下：那会在轮廓里凭空多出一个"湖"，
        // 而海岸环并不知道它（预览里是蓝斑、省份却盖在上面）。压到 sea+0.4 就够成洼了。
        hm.h[k] = Math.max(sea + 0.4, hm.h[k] + amp * f);
      }
    }
    placed++;
  }
  for (let k = 0; k < hm.h.length; k++) hm.h[k] = Math.round(hm.h[k] * 100) / 100;
  return { placed, skipped };
}

/** 高度图（`synthesizeHeightmapFromTerrain` 的产物）→ 预览栅格 */function reliefFromHeightmap(hm, seaLevel) {
  const { cellsX: w, cellsY: h, points } = hm.grid;
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(100, Number(hm.h[i]) || 0));
    data[i] = Math.round((v / 100) * 255);
  }
  return {
    w, h, data,
    origin: { x: points[0][0], y: points[0][1] },
    spacing: hm.grid.spacing,
    seaLevel,
  };
}

/**
 * 生成一组大陆环。
 * @param {object} params 见 `terrainParams.normalizeLandParams`
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @returns {{version:number, seed:number, bbox:object, shape:string,
 *            rings:Array<{id:string, points:Array, holes:Array<Array>, area:number, center:object}>,
 *            rivers:Array<{id:string, name:string, points:Array, width:number, discharge:number}>,
 *            relief:object|null, stats:object}}
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
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();

  // ── ⓪ 宏观场（长边 240 格）：**所有体元半径都是格数**，必须在这个分辨率上铺，
  //    否则 480 格上 `baseR` 翻倍、山脊/海湾宽度跟着翻倍 —— 等于换了一块大陆。
  const target = 240;
  const macroSpacing = longSide / target;
  const cols0 = Math.max(24, Math.ceil(W / macroSpacing) + 1);
  const rows0 = Math.max(24, Math.ceil(H / macroSpacing) + 1);
  const ctx0 = createField({ cols: cols0, rows: rows0, seed });
  for (const step of buildLandSteps(ctx0, { ...p, shape: shape.id, landRatio, roughness })) step(ctx0);
  applyRoughness(ctx0, roughness, seed + 7001);
  const tSteps = now() - t0;

  // ── ① 加密（×2）+ 细尺度岩性噪声：宏观形状不变，只多出细节。
  //    没有这一步，等值线只能落在 7.5 世界单位一根的格点上，"放大看是面片"就是这么来的。
  const ctx = refineField(ctx0, 2);
  const sx = W / Math.max(1, ctx.cols - 1);
  const sy = H / Math.max(1, ctx.rows - 1);
  // 中尺度起伏（世界波长 100~240 → 25~60 单位）：让坡面不是双线性插值出来的斜面，
  // ⚠️ 但不能更细 —— 480 格场上再叠 2~3 格波长的噪声，分位数一切就是满屏碎岛。
  applyRoughness(ctx, roughness, seed + 3301, { freqMul: 2.5, octaves: 3, ampMul: 0.5 });
  const tField = now() - t0;
  // ── ③ 海平面 = 目标占比对应的**格高分位数**（不是整体平移）。
  let seaLevel = quantileLevel(ctx.heights, landRatio);
  // 近岸压平（坡度不压缓，同样的噪声只能推动 1~2 格，海岸还是"整块"）→ 再加海岸带细节
  flattenCoast(ctx, seaLevel, 0.55, 24);
  seaLevel = quantileLevel(ctx.heights, landRatio);
  addCoastDetail(ctx, 5 + roughness * 5, seed + 991, seaLevel, { freqCells: 26, octaves: 3 });
  seaLevel = quantileLevel(ctx.heights, landRatio);

  const sampleField = (x, y) => {
    const fx = (x - bbox.minX) / sx;
    const fy = (y - bbox.minY) / sy;
    const i0 = clamp(Math.floor(fx), 0, ctx.cols - 1), j0 = clamp(Math.floor(fy), 0, ctx.rows - 1);
    const i1 = Math.min(ctx.cols - 1, i0 + 1), j1 = Math.min(ctx.rows - 1, j0 + 1);
    const tx = clamp(fx - i0, 0, 1), ty = clamp(fy - j0, 0, 1);
    const h00 = ctx.heights[j0 * ctx.cols + i0], h10 = ctx.heights[j0 * ctx.cols + i1];
    const h01 = ctx.heights[j1 * ctx.cols + i0], h11 = ctx.heights[j1 * ctx.cols + i1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  };
  // ── ④ 海岸：抖动网格逐格判海陆 → 沿格边描环（拓扑）→ 顶点贴到等值线（几何）。
  //
  // 加密网格（24k~40k 格 = 6~8 世界单位/格）在这里是**必要**的：v3 的 6000 格（18 单位/格）
  // 在 760px 预览里就是 7px 的台阶，放大后是"像素画"。网格再细一档之后，
  // 一条 45° 的海岸不再由等长的直角台阶组成。
  //
  // 抖动幅度也拉满了（±0.45 格）：顶点只在**自己的格子里**移动，所以拓扑不变，
  // 但格边的方向被随机化 —— 这正是"看不到格网"的关键（等距台阶的观感来自轴对齐的边）。
  const meshCells = Math.round(24000 + roughness * 16000);
  const mesh = coastRingsFromMesh(sampleField, bbox, meshCells, landRatio, ctx.rng, 0.62 + roughness * 0.28);
  const tContour = now() - t0;

  const minArea = W * H * 0.00012;
  const simpleEps = Math.min(W, H) / 900;
  const outers = [];
  const holes = [];
  for (const loop of mesh.loops) {
    const snapped = snapLoopToLevel(loop, sampleField, mesh.level, sx * 0.5, bbox);
    const simplified = rdp(cornerCut(snapped, 1), simpleEps);
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

  // ── ⑤ 地形（**复用 `terrainSynthesis`**，不是第二套地形生成）→ 河流 → 预览栅格。
  //
  // 为什么地形要**重新在轮廓里合成**、而不继续用上面那张体元场：
  //   · 体元场的作用是"造形状"（陆核/叶/山脊/海槽 → 半岛与海湾），它的高度分布是几个丘叠出来的，
  //     **没有排水结构**（实测：整幅只有一个流域，450 条河全挤在一个 100 单位的洼地里）；
  //   · `terrainSynthesis` 是司天自己的"轮廓 → 地形"实现（距离场 + 山脉走向 + 高原 + 裂谷 +
  //     洼地填平），它的高度场**天生朝海岸排水**，`traceRivers` 在它上面能长出水系。
  //   两者分工：**轮廓定"海在哪"，地形定"山在哪，水往哪走"**。
  const maskCells = 448;
  const maskRows = Math.max(24, Math.round((maskCells - 1) * (H / Math.max(1, W))) + 1);
  const landMask = rasterizeLandMask(rings, bbox, maskCells, maskRows);
  const terrainCells = Math.round(170 + roughness * 30);
  const hm = synthesizeHeightmapFromTerrain(
    rings.map((r) => ({ rings: [r.points, ...(r.holes || [])] })),
    {
      isLand: landMask.isLand,
      cellsAcross: terrainCells,
      seed,
      // 参数面板的"崎岖度"直接喂给山脉/裂谷权重：同一个滑杆既改岸线也改山势。
      // 🔴 高原面权重必须**压低**（默认 0.92 → 这里 0.3）：高原是"大面积同一高度"，
      //    水在它上面只能按格序走 → 画面上是**一片 45° 平行直线**（实测截图）。
      //    陆地世界要的是水系，不是台地；山脉走向 + 裂谷已经足够给出高差。
      structureOverrides: {
        rangeWeight: 0.34 + roughness * 0.2,
        crossRangeWeight: 0.12 + roughness * 0.08,
        riftDepth: 0.18 + roughness * 0.16,
        plateauWeight: 0.2 + roughness * 0.1,
      },
    },
  );
  const tTerrain = now() - t0;

  // ── ⑤b **多尺度丘陵**（第四轮的核心改动）：把"穹顶 + 平行脊线"的坡面打散成
  //    "一堆大小不一的丘与盆"。这一步是**河流能不能长成树枝状**的前提（理由见 `scatterHills`）。
  const hills = hm
    ? scatterHills(hm, {
      count: Math.round(90 + roughness * 110),
      rMin: 2.2,
      rMax: 8.5,
      ampMin: 1.2,
      ampMax: 6.5,
      basinRate: 0.16,
      seaLevel: 20,
      rng: ctx.rng,
    })
    : null;

  // ── ⑤b2 地形微起伏：洼地填平会在陆地上留下大片**同一高度**的格子（高原面最明显），
  //    平地上没有坡向，地形着色看上去像一块塑料板。这里给陆地格加一层细尺度微起伏
  //    （±0.55 高度点、波长 ~27 世界单位），只为了"看起来有质感"。
  if (hm) {
    const cellW = hm.grid.spacing || 8;
    for (let k = 0; k < hm.h.length; k++) {
      if (hm.h[k] < 20.5) continue;                  // 只动陆地
      const i = k % hm.grid.cellsX;
      const j = (k / hm.grid.cellsX) | 0;
      const micro = fbm(i * 0.34, j * 0.34, seed + 6067, 3) * 0.55;
      const jitter = (hash01(i * 12.9898 + j * 78.233, seed + 6067) - 0.5) * 0.25 * (cellW / 8);
      hm.h[k] = Math.round((hm.h[k] + micro + jitter) * 100) / 100;
    }
  }

  // ── ⑤c **河成侵蚀**：让水把丘与丘之间的谷切深（正反馈：切得深 → 汇流更多 → 切得更深）。
  const erosion = hm
    ? inciseByFlow(hm, {
      seaLevel: 20,
      isLand: landMask.isLand,
      iterations: 3,
      strength: 2.2,
    })
    : null;
  // 地形高差读数（回执/用例看"山地确实起来了"）
  let terrainMin = 0, terrainMax = 0;
  if (hm) {
    terrainMin = Infinity;
    for (const v of hm.h) {
      if (v < 20) continue;
      if (v < terrainMin) terrainMin = v;
      if (v > terrainMax) terrainMax = v;
    }
    if (!Number.isFinite(terrainMin)) terrainMin = 0;
  }

  // ── ⑤d 河流：多尺度丘陵 + 侵蚀之后，地形才有"丘间谷"，这时才谈得上画河。
  //    仍然**复用**画布「自动河流」的整条链（`traceRivers` → `buildRiverPaths`），
  //    不写第二套追踪器；这里只负责挑哪些链、以及线宽口径。
  let traced = { rivers: [], segments: [], elapsedMs: 0 };
  const rivers = [];
  if (hm) {
    traced = traceRivers(hm, {
      seaLevel: 20,
      sourceHeight: 24 + roughness * 10,
      sourceInlandCells: 2,
      minPoints: 4,
      coalesce: true,
      isLand: landMask.isLand,
    });
    // ⚠️ **不剪枝**：`pruneRiverNetwork` 会砍掉细段，而 `buildRiverPaths` 是"沿上游串链"——
    //    中间少一段，链就在那里断掉（实测：剪完再串，每条河只剩 4~5 个点 = 一堆短棍）。
    const chains = buildRiverPaths(traced.segments, { minFlow: 2, minLen: 8, maxPaths: 260 });
    const maxRivers = 56;
    const pick = [];
    for (const ch of chains) {
      if (!ch || !ch.points || ch.points.length < 6) continue;
      // 只收**能流到海**的链：支流链在汇流点就断了，单画它是"悬在半山腰的半截河"
      if (!ch.endInSea) continue;
      const pts = clipPolylineToLand(ch.points.map((q) => ({ x: q.x, y: q.y })), landMask.isLand);
      if (pts.length < 4) continue;
      let len = 0;
      for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      // 太短的只算沟（不到 10 格），不像河
      if (len < hm.grid.spacing * 10) continue;
      // 🔴 **直度闸门**：真实河几乎不会笔直。实测在这份地形上，"河口→源头直线距离 / 路径长"
      //    接近 1 的那批，正是画面上最扎眼的"45° 平行线"（均匀坡面上的并行水流）。
      //    留弯曲的、丢掉直的 —— 宁可稀疏，也不要一排排假河。
      const chord = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y);
      const straightness = chord / Math.max(1e-6, len);
      if (straightness > 0.82) continue;
      pick.push({ points: pts, flow: Math.max(2, ch.flow || 2), len, straightness });
    }
    pick.sort((a, b) => (b.len - a.len) || (b.flow - a.flow));
    const rawRivers = pick.slice(0, maxRivers);
    const maxFlow = rawRivers.reduce((a, r) => Math.max(a, r.flow), 0) || 2;
    rawRivers.forEach((r, i) => {
      rivers.push({
        id: `land_river_${seed}_${i}`,
        name: '',
        points: r.points,
        // 线宽口径：与导入河同一条公式（`basemapRiverWidthPx` 按本图最大 width 归一化）
        width: Math.round((0.03 + 0.23 * Math.sqrt(Math.max(0, r.flow - 1) / Math.max(1, maxFlow - 1))) * 1000) / 1000,
        discharge: Math.round(flowToDischargeEquivalent(r.flow, maxFlow)),
      });
    });
  }
  const tRivers = now() - t0;
  const relief = hm ? reliefFromHeightmap(hm, 20) : null;
  const tEnd = now() - t0;

  return {
    version: LANDMASS_VERSION,
    seed,
    bbox: { ...bbox },
    shape: shape.id,
    rings,
    rivers,
    // 地形高度图（`terrainSynthesis` 同构）：面板画山体阴影，也是下一步"落高度图"的入口
    terrain: hm || null,
    relief,
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
      fieldCells: ctx.cols * ctx.rows,
      spacing: sx,
      meshPitch: Math.sqrt((W * H) / Math.max(1, mesh.cells)),
      // 海平面是**格高分位数**（目标占比决定），不是固定 20 —— 面板/用例别拿 20 当判据
      seaLevel: Math.round(mesh.level * 100) / 100,
      cellLandRatio: mesh.cellRatio,
      cells: mesh.cells,
      // 地形（合成）与掩膜：预览/用例读它，别自己再算
      terrainCells: hm ? hm.grid.cellsX * hm.grid.cellsY : 0,
      terrainCellSize: hm ? hm.effectiveCellSize : 0,
      terrainRifts: hm && hm.structure ? hm.structure.rifts : 0,
      terrainMin: Math.round(terrainMin * 10) / 10,
      terrainMax: Math.round(terrainMax * 10) / 10,
      // 丘陵/侵蚀/河流（诊断与回执）
      hillCount: hills ? hills.placed : 0,
      erodedRounds: erosion ? erosion.iterations : 0,
      erodedDepth: erosion ? erosion.carved : 0,
      rivers: rivers.length,
      riverPoints: rivers.reduce((a, r) => a + r.points.length, 0),
      tracedRivers: traced.rivers.length,
      maskLandRatio: landMask.landCells / Math.max(1, landMask.cols * landMask.rows),
      // 分段时间（ms）：生成器是同步跑的，面板卡不卡全看这几个数
      timings: {
        steps: Math.round(tSteps),
        field: Math.round(tField),
        terrain: Math.round(tTerrain),
        rivers: Math.round(tRivers - tTerrain),
        coast: Math.round(tContour),
        total: Math.round(tEnd),
      },
    },
  };
}
