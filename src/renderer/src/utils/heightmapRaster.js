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

// ── 陆海底色（无主省份本色 / 海洋底）───────────────────────────────────────
export const LAND_BASE_COLOR = [220, 216, 207];   // #dcd8cf
export const SEA_BASE_COLOR = [201, 214, 228];    // #c9d6e4

// ── 色带（hex）──────────────────────────────────────────────────────────────
export const HYPSO_WATER = ['#12314f', '#1d4a70', '#2b6b93', '#3f8fb0', '#63b0c9'];
export const HYPSO_LAND = ['#6f9f5a', '#8fb063', '#c3c46c', '#d8bf7a', '#b59468', '#8f7a5c', '#d9d2c6'];
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

/** 网格单元 → 颜色（kind: landsea | height | temp | prec | culture | religion） */
export function cellColor(kind, i, hm, palette) {
  if (kind === 'landsea') {
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
  return h < RASTER_SEA_LEVEL
    ? sampleRamp(HYPSO_WATER_RGB, h / (RASTER_SEA_LEVEL - 1))
    : sampleRamp(HYPSO_LAND_RGB, (h - RASTER_SEA_LEVEL) / 80);
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
  const NORM = 0.9;        // 每多少"个标准差"的高差算满坡（0.9 实测能出结构又不爆）
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
      out[i] = Math.max(0.55, Math.min(1.45, shade));
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

  // 平滑档只在「网格维度与数据长度严格自洽」时启用；不自洽（历史数据）自动退回方块档，
  // 宁可方块也不要画错（下标一旦错位，颜色会整体偏移且不报错）。
  const cols = hm.grid.cellsX | 0, rows = hm.grid.cellsY | 0;
  if (smooth && cols > 0 && rows > 0 && cols * rows === values.length && pts.length === values.length) {
    const shade = shadeOn ? buildShadeMap(hm.h, cols, rows, { shade: opts.shade }) : null;
    return buildSmoothRaster(kind, hm, values, palette, spacing, pts[0], cols, rows, minX, minY, w, h, shade);
  }
  return buildBlockRaster(kind, hm, values, palette, spacing, pts, minX, minY, w, h);
}

/**
 * 平滑档：格分辨率 RGB → 子格双线性上采样。
 * 输出画布边长 ≈ `w·SS/spacing`（不是 1 世界单位 1 像素），由绘制端插值放大。
 */
function buildSmoothRaster(kind, hm, values, palette, spacing, p0, cols, rows, minX, minY, w, h, shade) {
  const ox = p0[0] - spacing / 2, oy = p0[1] - spacing / 2;   // 格 (0,0) 的左上角
  const n = cols * rows;

  // ① 格分辨率 RGB（每个格子一次 cellColor）
  const cellRgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = cellColor(kind, i, hm, palette);
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
function buildBlockRaster(kind, hm, values, palette, spacing, pts, minX, minY, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const rc = canvas.getContext('2d');
  const img = rc.createImageData(w, h);
  const data = img.data;
  const half = spacing / 2;

  for (let i = 0; i < pts.length && i < values.length; i++) {
    const rgb = cellColor(kind, i, hm, palette);
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
