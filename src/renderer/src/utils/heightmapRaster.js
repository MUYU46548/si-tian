// utils/heightmapRaster.js — 高度图 → 离屏栅格（跨视图共享的**渲染层**；M2/A2，2026-09-25）
//
// ── 为什么抽出这一层 ────────────────────────────────────────────────────────
// 「三套表示并存」的渲染侧成因就在这里：同一份高度图，两个视图各有一套渲染算法与配色 ——
//   · ScenarioMap：逐格上色 → **离屏 canvas**（预渲染，一次 drawImage 贴上去）
//   · PlanetMap：`buildLabelOutlines` → **矢量平滑轮廓**（另一套代码、另一套观感）
// 结果是同一颗行星在剧本里和在行星地图里看起来是两个世界，而且改一处配色不影响另一处。
// M2 的目标是两边读**同一份**高度图、用**同一套**配色渲染 —— 本模块就是那个「同一套」。
//
// ── 边界（保持纯）────────────────────────────────────────────────────────────
// 只做「高度图 + 配色方案 → 离屏 canvas」这一件事：不含缓存、不碰 Vue、不读 store。
// 缓存由调用方按自己的 key 管理（ScenarioMap 用 `baseMapKey|kind`，PlanetMap 用 `planetId|kind`），
// 因为「什么时候算过期」是各视图自己的事（切底图 / 切行星 / 涂抹后）。
//
// ⚠️ 颜色与阈值**逐字**取自 ScenarioMap 的既有实现（2026-09-25 抽取时刻），
//    抽取初衷是零行为变更 —— 要改配色请改这里，两个视图会同时变（这正是抽出的目的）。
//
// 2026-10-08：新增 `culture` / `religion` 两档（行星侧文化/宗教笔刷的"看得见"环节）。
//    这两档与上面几档不同：颜色**不是**色带采样，而是来自每颗行星自己的
//    `cultures` / `religions` 元数据（下标 → 颜色），所以要由调用方传 `palette`。
//    颜色定义与「无主」底色的口径在 `utils/heightmapChannels.js`（单一实现）。

import { CHANNEL_KEYS, CHANNEL_UNASSIGNED_HEX } from './heightmapChannels';
import { buildSeaDepth } from './seaDepth';

// ── 陆海底色（无主省份本色 / 海洋底）───────────────────────────────────────
export const LAND_BASE_COLOR = [220, 216, 207];   // #dcd8cf
export const SEA_BASE_COLOR = [201, 214, 228];    // #c9d6e4

// ── 色带（hex）──────────────────────────────────────────────────────────────
export const HYPSO_WATER = ['#e4f1f9', '#d2e9f6', '#bcdff0', '#a4d2e9', '#8cc4df'];
// 🔴 2026-10-27（用户附 EU4 截图 + B1「黑一块白一块」）：旧陆地色带的高端是
//    `#c3853d`/`#a9742f`（橙/深棕），在粗格高度图上会糊成一块块"锈斑"；
//    低端 `#e9e6b4` 乘 1.08 又顶到近白。改成**低饱和的绿→麦→灰褐**，且不再有近白/深黑，
//    山体只靠阴影表达（EU4 的地形色几乎是同一族色，明暗才是立体感来源）。
export const HYPSO_LAND = ['#a9c489', '#bfd09a', '#d5d9aa', '#ddd2a3', '#d0bd92', '#c0a780', '#b09478'];

/**
 * 陆地分带的**高度分割线**（t 的升序下界，7 档 6 条线）—— 与 `HYPSO_LAND` 逐项对应。
 *
 * 为什么不是等分：等分时"中位高度"正好落在第 4 档（沙色），整幅地图像被烤过一遍
 * （实测截图：陆地大面积橙黄、只有海岸是绿的）。参考图的绿占绝大多数面积，
 * 橙/棕只属于真正的高山 —— 所以低档要宽、高档要窄。
 * 这套比例是**对着意大利地形图量的**（平原绿 ≈ 一半陆地，高山 ≈ 顶 10%）。
 */
export const HYPSO_LAND_BANDS = Object.freeze([0, 0.45, 0.63, 0.76, 0.86, 0.93, 0.975]);
export const TEMP_RAMP = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#fee090', '#fdae61', '#f46d43', '#d73027'];
export const PREC_RAMP = ['#fff7bc', '#fee391', '#fec44f', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8'];

/** 海平面阈值（与 heightMath.SEA_LEVEL 同口径；此处用字面量以保持抽取时的一致性） */
export const RASTER_SEA_LEVEL = 20;

/**
 * 平滑档（反「拼豆」，2026-10-09）—— 每格再细分成 SS×SS 个子像素做**双线性上采样**。
 *
 * 为什么需要它：旧实现每格画一个实心 `spacing×spacing` 方块（1 世界单位 = 1 像素），
 * 放大后就是马赛克。⚠️ 只在绘制端开 `imageSmoothingEnabled` **救不了** —— 旧画布是
 * 1 px/世界单位、按 1:1 贴回世界坐标，浏览器根本不触发插值。
 *
 * 做法：① 先在**格分辨率**上算好每格的 RGB；② 再按 SS 倍细分输出，
 * 每个子像素对「格 RGB」做双线性采样。连续场（h/temp/prec）与分类场
 * （biome/culture/religion/landsea）共用这一条路 —— 分类场混色即得渐变边界。
 *
 * ⚠️ 必须插值**格 RGB**，不能插值通道值再取色：分类场的值是下标，
 *    插值下标会得到"不存在的类别"，而且不报错（比缺色难查得多）。
 * ⚠️ 顺带更省内存：输出边长 ≈ `w·SS/spacing`，面积只有旧实现的 `(SS/spacing)²` ≈ 1/13。
 */
export const RASTER_SUBSAMPLE = 4;
/** 平滑档默认开关（false = 回到旧的逐格方块观感；同时影响两视图与导出全图） */
export const RASTER_SMOOTH = true;

export function hexToRgb(hex) {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const HYPSO_WATER_RGB = HYPSO_WATER.map(hexToRgb);
const HYPSO_LAND_RGB = HYPSO_LAND.map(hexToRgb);
const TEMP_RGB = TEMP_RAMP.map(hexToRgb);
const PREC_RGB = PREC_RAMP.map(hexToRgb);

/** 通道（文化/宗教）「无主」的底色 */
const CHANNEL_UNASSIGNED_RGB = hexToRgb(CHANNEL_UNASSIGNED_HEX);

/**
 * 把「下标 → 颜色」的列表编成调色板（`palette[v]` = `[r,g,b]`）。
 *
 * 🔴 下标是**位置**（1 起），不是条目的 `id` —— 行星侧 `mapData[pid].cultures` 的 `id` 是
 *    `Date.now()`（见 `utils/heightmapChannels.js#nextChannelIndex` 的说明）。
 *
 * ⚠️ 缺色/坏色**不跳过条目**、只有真解析不出来才回落底色 —— 跳过会让下标整体错位，
 *    于是"第 3 号文化"画成"第 4 号文化的颜色"，且不报错（比缺色难查得多）。
 *
 * @param {Array<{id:number,color:string}>} list 元数据列表（`mapData[pid].cultures` 等）
 */
export function buildChannelPalette(list) {
  const pal = [CHANNEL_UNASSIGNED_RGB];
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length && i + 1 <= 255; i++) {
    const hex = String((items[i] && items[i].color) || '');
    pal[i + 1] = /^#?[0-9a-fA-F]{6}$/.test(hex) ? hexToRgb(hex) : CHANNEL_UNASSIGNED_RGB;
  }
  return pal;
}

function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

/** 色带采样（线性插值，返回 [r,g,b]） */
export function sampleRamp(rgbList, t) {
  const u = clamp01(t);
  if (u <= 0) return rgbList[0];
  if (u >= 1) return rgbList[rgbList.length - 1];
  const f = u * (rgbList.length - 1);
  const i = Math.floor(f);
  const k = f - i;
  const a = rgbList[i];
  const b = rgbList[i + 1] || a;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** 网格单元 → 颜色（kind: landsea | height | temp | prec | culture | religion）
 *
 * `ctx`（可选，2026-10-26）：
 *   · `span: {lo,hi}` —— 陆地高度的**本幅图**分位区间（p2~p98）。不给则按旧的 `(h-20)/80`。
 *   · `sea: {t}`      —— 海深场（`seaDepth.buildSeaDepth` 的产物）。不给则按旧口径用 h 采样。
 * 两处都必须**由 `buildHeightmapRaster` 一次算好**再传进来：逐格去算分位数/距岸就是每帧 O(n log n)。
 */
export function cellColor(kind, i, hm, palette, ctx) {
  if (kind === 'landsea') {
    // 2026-10-27：剧本画布把「陆海底色」当**海面纸**用（陆地由省份多边形负责）。
    // 旧实现把陆地也刷成浅米色 → 省界平滑后海岸会漏出一圈块状"白斑"
    // （用户 B1「黑一块白一块」）。`landAsSea` 时整张底图统一海色，漏出的部分看起来就是海。
    if (ctx && ctx.landAsSea) return SEA_BASE_COLOR;
    return hm.h[i] >= RASTER_SEA_LEVEL ? LAND_BASE_COLOR : SEA_BASE_COLOR;
  }
  if (kind === 'temp') {
    return sampleRamp(TEMP_RGB, (hm.temp[i] + 40) / 60);   // 实测范围 -40…20 °C
  }
  if (kind === 'prec') {
    return sampleRamp(PREC_RGB, hm.prec[i] / 100);         // FMG 降水标尺 0…100
  }
  if (CHANNEL_KEYS.indexOf(kind) >= 0) {
    // 文化/宗教：颜色来自行星自己的元数据调色板；无主（0）或调色板缺失 → 底色
    const arr = hm[kind];
    const v = arr ? (arr[i] | 0) : 0;
    return (palette && palette[v]) || CHANNEL_UNASSIGNED_RGB;
  }
  const h = hm.h[i];
  // ── 海：有海深场就按"离岸多远"**连续**采样（5 色渐变）──
  // ⚠️ 海面**不分带**：分带后每条带边都锁在格边界上，1× 下是一圈圈方块梯田
  //    （实测截图）；层次交给等深线去表达，色带只负责"越远越深"。
  if (h < RASTER_SEA_LEVEL) {
    const sea = ctx && ctx.sea;
    if (sea && sea.t) return sampleRamp(HYPSO_WATER_RGB, sea.t[i] || 0);
    return sampleRamp(HYPSO_WATER_RGB, h / (RASTER_SEA_LEVEL - 1));
  }
  // ── 陆：按**本幅图自己的陆地高度分位**归一化，再按非等宽分带取色 ──────────
  // 🔴 2026-10-26（用户附意大利地形图）：旧口径 `(h-20)/80` 在这份真实数据上
  //    只用到色带的 0.02~0.63（陆地 p98 = 63.5）—— 棕/灰/雪永远不出现，整幅偏黄绿。
  //    现在换成 p2~p98 映射到 0..1（"按本分布归一化"，与河宽/流量同一条纪律），
  //    并按 `HYPSO_LAND_BANDS` 取档（参考图是分层设色，不是连续渐变）。
  const span = ctx && ctx.span;
  const lo = span ? span.lo : RASTER_SEA_LEVEL;
  const hi = span ? span.hi : RASTER_SEA_LEVEL + 80;
  const t = clamp01((h - lo) / (hi - lo > 1e-6 ? hi - lo : 1));
  return HYPSO_LAND_RGB[landBandIndex(t)];
}

/** t（0..1 的相对高度）→ 陆地色带下标（按 `HYPSO_LAND_BANDS` 的非等宽分档） */
export function landBandIndex(t) {
  const v = clamp01(Number.isFinite(t) ? t : 0);
  let idx = 0;
  for (let i = 0; i < HYPSO_LAND_BANDS.length; i++) {
    if (v >= HYPSO_LAND_BANDS[i]) idx = i;
  }
  return Math.min(HYPSO_LAND_RGB.length - 1, idx);
}

/**
 * 陆地高度的**本幅图分位区间**（p2 / p98）—— 分带配色的归一化基准。
 *
 * 为什么不用绝对量程：高度点没有物理单位（导入图 20~70、造陆图 20~100 都合法），
 * 写死除 80 的表现是"这份数据只用得到半条色带"，而且不报错。
 *
 * @param {ArrayLike<number>} h
 * @param {number} [seaLevel]
 * @returns {{lo:number, hi:number, count:number, fallback:boolean}}
 */
export function landHeightSpan(h, seaLevel = RASTER_SEA_LEVEL) {
  const vals = [];
  if (h) {
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (Number.isFinite(v) && v >= seaLevel) vals.push(v);
    }
  }
  if (vals.length < 8) return { lo: seaLevel, hi: seaLevel + 80, count: vals.length, fallback: true };
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * (vals.length - 1))))];
  const lo = q(0.02);
  const hi = q(0.98);
  // 几乎全平的地形：分位区间会退化成 0 → 回落到旧量程，避免整幅一个颜色
  if (!(hi - lo > 2)) return { lo: seaLevel, hi: seaLevel + 80, count: vals.length, fallback: true };
  return { lo, hi, count: vals.length, fallback: false };
}

/**
 * **山体阴影（hillshade）系数** —— 逐格的明暗乘子（1 = 不变，<1 阴面，>1 阳面）。
 *
 * 🔴 为什么加这个（2026-10-17 第七修，用户附了张真实世界地图：「地形怎么3D表现」）：
 *    我们此前只有**分层设色**（hypsometric tint）—— 高度靠**颜色**表达。
 *    真实地图让地形"立起来"靠的是**阴影**：同一颜色带上，朝光的坡亮、背光的坡暗。
 *    只有设色时，一块高原和一片缓坡看上去是同一张平面纸（这正是"没有 3D 感"的成因）。
 *
 * 口径（一次算好、逐格一个乘子，渲染时按子像素双线性插值）：
 *   · 坡向由**相邻格高差**求（中心差分 = 最省事且不引入方向偏差）；
 *   · 光照方向 NW（`lx=-0.7, ly=-0.7`，屏幕 y 向下）—— 制图惯例：光从左上来，
 *     山体的东南坡为阴面，读者对"凸起/凹陷"的判断不会反转（光从右下会整体反转，像挖的坑）；
 *   · **除以本幅图的高度标准差**得到"陡峭度"：起伏大的地形自然出更多明暗，
 *     平缓地形也不会被放大成噪声（第五次强调：按本分布归一化，绝对数字换个数据就失效）；
 *   · **海格不参与**（水面是平的，给海面加阴影会像结了冰）。
 *
 * @param {ArrayLike<number>} h @param {number} cols @param {number} rows
 * @param {{shade?:number}} [opts] `shade` = 强度（0 = 关闭，1 = 默认）
 * @returns {Float32Array|null} 长度 cols*rows 的乘子表
 */
export function buildShadeMap(h, cols, rows, opts) {
  const strength = opts && Number.isFinite(opts.shade) ? opts.shade : 1;
  if (!h || !(cols > 1) || !(rows > 1) || h.length < cols * rows) return null;
  if (!(strength > 0)) return null;

  // 高度标准差：把"陡峭度"归一化到本幅图自己的量纲上
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < cols * rows; i++) {
    const v = h[i] || 0;
    sum += v; sum2 += v * v; n++;
  }
  const mean = n ? sum / n : 0;
  const std = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
  // 标准差为 0（完全平坦）→ 没有坡可投影，直接给"无阴影"
  if (!(std > 1e-6)) return null;

  const out = new Float32Array(cols * rows);
  // 2026-10-27：NORM 0.9 → 1.15（同样高差算"更缓"），并把手影区间从 0.62~1.08
  // 收到 **0.80~1.03** —— 旧值在 97×45 粗格上是一块块死黑/死白（用户截图）。
  const NORM = 1.15;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if ((h[i] || 0) < RASTER_SEA_LEVEL) { out[i] = 1; continue; }   // 海面不投影
      const xl = x > 0 ? i - 1 : i, xr = x < cols - 1 ? i + 1 : i;
      const yu = y > 0 ? i - cols : i, yd = y < rows - 1 ? i + cols : i;
      // 相邻格若有海格，按"高度 0"处理会让海岸出现一圈黑边 → 用自身高度代替
      const hv = (k) => ((h[k] || 0) < RASTER_SEA_LEVEL ? (h[i] || 0) : (h[k] || 0));
      const dzdx = (hv(xr) - hv(xl)) / (2 * NORM * std);
      const dzdy = (hv(yd) - hv(yu)) / (2 * NORM * std);
      // 与 NW 光向点乘：坡朝向光 → 更亮
      const shade = 1 + (dzdx * 0.7 + dzdy * 0.7) * strength;
      // 只保留柔和的明暗（阴影是辅助，不该把地形涂成黑白）
      out[i] = Math.max(0.8, Math.min(1.03, shade));
    }
  }
  return out;
}

/** 在 ImageData 上填一个矩形色块（逐像素，避免 canvas 抗锯齿在网格缝隙留下亮线） */
export function fillPixelBlock(data, w, h, x0, y0, x1, y1, rgb) {
  let ix0 = Math.floor(x0), iy0 = Math.floor(y0);
  let ix1 = Math.ceil(x1), iy1 = Math.ceil(y1);
  if (ix0 < 0) ix0 = 0;
  if (iy0 < 0) iy0 = 0;
  if (ix1 > w) ix1 = w;
  if (iy1 > h) iy1 = h;
  const r = rgb[0] | 0, g = rgb[1] | 0, b = rgb[2] | 0;
  for (let y = iy0; y < iy1; y++) {
    let p = (y * w + ix0) * 4;
    for (let x = ix0; x < ix1; x++) {
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      p += 4;
    }
  }
}

/**
 * 把高度图预渲染成一张离屏图层。
 *
 * 红线：大数据量必须预渲染，不逐帧重绘（几万格逐格画 = 每帧几十毫秒）。
 * 两条输出档（`RASTER_SMOOTH` 决定默认走哪条；调用方可显式覆盖）：
 *   · **平滑档**（默认）：格 RGB → 子格双线性上采样，画布为格级分辨率，绘制端插值放大 → 渐变海岸。
 *   · **方块档**：每格一个实心 `spacing×spacing` 方块，1 世界单位 = 1 像素（旧观感，放大即马赛克）。
 *
 * ⚠️ 两种档的 `canvas.width/height` 不同，但 `w/h`（世界单位）一致 →
 *    调用端统一用 `ctx.drawImage(r.canvas, r.minX, r.minY, r.w, r.h)`，无需分支。
 *
 * @param {object} hm 高度图（`{ h, temp, prec, grid:{cellsX,cellsY,points,spacing} }`）
 * @param {'landsea'|'height'|'temp'|'prec'|'culture'|'religion'} kind 配色方案
 * @param {{palette?: Array<[number,number,number]>, smooth?: boolean}} [opts]
 *        `culture`/`religion` 档必须给调色板；`smooth:false` 取回方块档（用例对照用）
 * @returns {{canvas: HTMLCanvasElement, minX: number, minY: number, w: number, h: number}|null}
 *   调用方用 `ctx.drawImage(r.canvas, r.minX, r.minY, r.w, r.h)` 贴到**世界坐标**上。
 */
export function buildHeightmapRaster(hm, kind, opts) {
  const palette = (opts && opts.palette) || null;
  // 平滑档：默认取 RASTER_SMOOTH；调用方可显式传 {smooth:false} 取回旧观感（用例对照）。
  const smooth = opts && opts.smooth !== undefined ? !!opts.smooth : RASTER_SMOOTH;
  // 🔴 山体阴影（2026-10-17 第七修）：`{shade:1}` 打开，默认**关**（零行为变更）。
  //    只对"读地形的档"（高度 / 陆海底色）有意义 —— 温度/降水/文化那些是**专题图**，
  //    给它们加阴影会把数值读成地形（那是错的口径）。
  const shadeOn = !!(opts && opts.shade > 0) && (kind === 'height' || kind === 'landsea');
  const pts = hm?.grid?.points;
  if (!hm || !pts || !pts.length) return null;
  const values = kind === 'temp' ? hm.temp
    : kind === 'prec' ? hm.prec
      : (CHANNEL_KEYS.indexOf(kind) >= 0) ? hm[kind]
        : hm.h;
  if (!values || !values.length) return null;

  const spacing = hm.grid.spacing || 14.4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const x = pts[i][0], y = pts[i][1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = spacing;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = Math.max(1, Math.ceil(maxX - minX));
  const h = Math.max(1, Math.ceil(maxY - minY));

  // 只对"读地形的档"（高度）做分带归一化与海深；别的档是专题图，换量纲会把数值读成地形。
  // ⚠️ 两样都是**一次性**算好再逐格用：逐格算分位数 = 每帧 O(n log n)，逐格 BFS = 每帧几十毫秒。
  const ctx = {
    span: kind === 'height' ? landHeightSpan(hm.h, RASTER_SEA_LEVEL) : null,
    sea: kind === 'height' && !(opts && opts.sea === false)
      ? buildSeaDepth(hm, { seaLevel: RASTER_SEA_LEVEL })
      : null,
    // 剧本画布专用：landsea 只当海面纸（陆地由省份画）
    landAsSea: !!(opts && opts.landAsSea),
  };

  // 平滑档只在「网格维度与数据长度严格自洽」时启用；不自洽（历史数据）自动退回方块档，
  // 宁可方块也不要画错（下标一旦错位，颜色会整体偏移且不报错）。
  const cols = hm.grid.cellsX | 0, rows = hm.grid.cellsY | 0;
  if (smooth && cols > 0 && rows > 0 && cols * rows === values.length && pts.length === values.length) {
    const shade = shadeOn ? buildShadeMap(hm.h, cols, rows, { shade: opts.shade }) : null;
    return buildSmoothRaster(kind, hm, values, palette, spacing, pts[0], cols, rows, minX, minY, w, h, shade, ctx);
  }
  return buildBlockRaster(kind, hm, values, palette, spacing, pts, minX, minY, w, h, ctx);
}

/**
 * 平滑档：格分辨率 RGB → 子格双线性上采样。
 * 输出画布边长 ≈ `w·SS/spacing`（不是 1 世界单位 1 像素），由绘制端插值放大。
 */
function buildSmoothRaster(kind, hm, values, palette, spacing, p0, cols, rows, minX, minY, w, h, shade, ctx) {
  const ox = p0[0] - spacing / 2, oy = p0[1] - spacing / 2;   // 格 (0,0) 的左上角
  const n = cols * rows;

  // ① 格分辨率 RGB（每个格子一次 cellColor）
  const cellRgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = cellColor(kind, i, hm, palette, ctx);
    cellRgb[i * 3] = c[0] | 0;
    cellRgb[i * 3 + 1] = c[1] | 0;
    cellRgb[i * 3 + 2] = c[2] | 0;
  }

  // ② 子格双线性上采样
  const ppu = RASTER_SUBSAMPLE / spacing;   // 输出像素 / 世界单位
  const cw = Math.max(1, Math.ceil(w * ppu));
  const ch = Math.max(1, Math.ceil(h * ppu));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const rc = canvas.getContext('2d');
  const img = rc.createImageData(cw, ch);
  const data = img.data;

  const cMax = cols - 1, rMax = rows - 1;
  for (let sy = 0; sy < ch; sy++) {
    const wy = minY + (sy + 0.5) / ppu;
    let fr = (wy - oy) / spacing - 0.5;
    if (fr < 0) fr = 0; else if (fr > rMax) fr = rMax;
    const r0 = Math.floor(fr);
    const r1 = r0 < rMax ? r0 + 1 : r0;
    const tr = fr - r0;
    const rowA = r0 * cols * 3, rowB = r1 * cols * 3;
    let p = sy * cw * 4;
    for (let sx = 0; sx < cw; sx++) {
      const wx = minX + (sx + 0.5) / ppu;
      let fc = (wx - ox) / spacing - 0.5;
      if (fc < 0) fc = 0; else if (fc > cMax) fc = cMax;
      const c0 = Math.floor(fc);
      const c1 = c0 < cMax ? c0 + 1 : c0;
      const tc = fc - c0;
      const i00 = rowA + c0 * 3, i01 = rowA + c1 * 3;
      const i10 = rowB + c0 * 3, i11 = rowB + c1 * 3;
      // 山体阴影：与颜色**共用同一套双线性权重**（各格一个乘子 → 同一段插值，不会错位）
      let sh = 1;
      if (shade) {
        const s00 = shade[r0 * cols + c0], s01 = shade[r0 * cols + c1];
        const s10 = shade[r1 * cols + c0], s11 = shade[r1 * cols + c1];
        const stop = s00 + (s01 - s00) * tc;
        const sbot = s10 + (s11 - s10) * tc;
        sh = stop + (sbot - stop) * tr;
      }
      for (let k = 0; k < 3; k++) {
        const top = cellRgb[i00 + k] + (cellRgb[i01 + k] - cellRgb[i00 + k]) * tc;
        const bot = cellRgb[i10 + k] + (cellRgb[i11 + k] - cellRgb[i10 + k]) * tc;
        // 乘完**显式夹**到 0..255（在亮度域里夹比让 Uint8ClampedArray 事后夹更可控）
        const v = (top + (bot - top) * tr) * sh;
        data[p + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      data[p + 3] = 255;
      p += 4;
    }
  }
  rc.putImageData(img, 0, 0);
  return { canvas, minX, minY, w, h };
}

/** 方块档（旧观感）：每格画一个实心 spacing×spacing 方块，1 世界单位 = 1 像素 */
function buildBlockRaster(kind, hm, values, palette, spacing, pts, minX, minY, w, h, ctx) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const rc = canvas.getContext('2d');
  const img = rc.createImageData(w, h);
  const data = img.data;
  const half = spacing / 2;

  for (let i = 0; i < pts.length && i < values.length; i++) {
    const rgb = cellColor(kind, i, hm, palette, ctx);
    const cx = pts[i][0] - minX;
    const cy = pts[i][1] - minY;
    fillPixelBlock(data, w, h, cx - half, cy - half, cx + half, cy + half, rgb);
  }
  rc.putImageData(img, 0, 0);
  return { canvas, minX, minY, w, h };
}

/**
 * 按 key 缓存的栅格工厂（各视图各持一个实例）。
 *
 * 为什么做成工厂而不是模块级单例：缓存失效的**时机**是视图自己的知识
 * （切底图 / 切行星 / 涂抹之后），共用一个全局 Map 会互相误伤 ——
 * 而且两个视图的 key 口径本就不同（`baseMapKey|kind` vs `planetId|kind`）。
 */
export function createRasterCache() {
  const store = new Map();
  return {
    /** 取（未命中则构建并缓存）。`hm` 由调用方提供，保证「哪一份高度图」由调用方决定 */
    get(key, hm, kind, opts) {
      const hit = store.get(key);
      if (hit) return hit;
      const built = buildHeightmapRaster(hm, kind, opts);
      if (built) store.set(key, built);
      return built;
    },
    clear() { store.clear(); },
    size() { return store.size; },
  };
}
