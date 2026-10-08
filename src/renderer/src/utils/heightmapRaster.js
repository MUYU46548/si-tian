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
 * 每个网格单元画一个 spacing × spacing 的方块 —— 网格点在 spacing/2 内抖动，方块拼接即完整覆盖。
 *
 * @param {object} hm 高度图（`{ h, temp, prec, grid:{points,spacing} }`）
 * @param {'landsea'|'height'|'temp'|'prec'|'culture'|'religion'} kind 配色方案
 * @param {{palette?: Array<[number,number,number]>}} [opts] `culture`/`religion` 档必须给调色板
 * @returns {{canvas: HTMLCanvasElement, minX: number, minY: number, w: number, h: number}|null}
 *   调用方用 `ctx.drawImage(r.canvas, r.minX, r.minY, r.w, r.h)` 贴到**世界坐标**上。
 */
export function buildHeightmapRaster(hm, kind, opts) {
  const palette = (opts && opts.palette) || null;
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
