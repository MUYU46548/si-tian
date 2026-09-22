// composables/useProvinceBrush.js — 省份笔刷 / 套索的状态 + 画布渲染（Phase 3）
//
// 只做两件事：① 持有笔刷参数与套索轨迹；② 把「归属标签网格」画出来（格 + 自动省界）。
// 数据写入一律走 store 的 provinceEditing 模块（一笔 = 一条 undo），本文件不改数据。
//
// 🔴 渲染走「栅格 → 矢量轮廓」，与地形涂色层（useTerrainCanvasBrush）同一套做法：
//    旧实现是逐格 roundRect + 屏幕空间 blur（铁律 87 的消体素感技法），但在省份网格上
//    副作用很明显 —— 用户实测原话：「自由轮廓视图下这个让人产生密集恐惧症的恶心视图」：
//    圆角格之间留下的缝隙连成一张深色网格、每个四角交汇处都露出一个「点」，
//    整屏就是密密麻麻的格子+点阵。现在把格边界抽成平滑闭合环（utils/gridOutline）后
//    每个省份只画一遍 fill，缝隙与点阵一起消失，顺带省掉逐格成本。
//
// onRender 的 ctx 已带相机变换（铁律 77）→ 这里一律用**世界坐标**绘制，线宽/圆角按 zoom 折算。

import { ref } from 'vue';
import { extractBorders, chaikin } from '../utils/provinceGrid';
import { buildLabelOutlines } from '../utils/gridOutline';

export const PROVINCE_TOOLS = [
  { key: 'paint', label: '归属笔刷', hint: '按住涂抹 → 整笔划归所选省份（一次拖动 = 一条撤销）' },
  { key: 'erase', label: '抹除', hint: '按住涂抹 → 涂回「无主」（海域/未划归）' },
  { key: 'smooth', label: '平滑', hint: '按住涂抹 → 按 3×3 邻域众数修毛边' },
  { key: 'lasso', label: '自由轮廓', hint: '按住画一圈 → 圈内所有格整批划归（一笔成形，不用描点）' },
];

/** 取色失败时的兜底色板（保证「有主的格一定看得见」—— 渲染成透明=用户以为没生效） */
const FALLBACK_PALETTE = [
  '#c4956a', '#5b8c5a', '#d4a857', '#4a90d9', '#c23b3b', '#6b5b95', '#e6a23c', '#8b7355',
  '#2ecc71', '#8e44ad', '#3498db', '#e74c3c', '#16a085', '#f39c12', '#7f8c8d', '#2980b9',
];

// 轮廓参数（以**格**为单位：格宽会变，固定世界单位阈值会失效 —— 与地形层同约定）
const EPS_FULL = 0.75;
const EPS_FAST = 1.2;
const MIN_AREA_FULL = 0.5;
const MIN_AREA_FAST = 1.5;

export function useProvinceBrush() {
  const radius = ref(5);          // 半径（格）
  const strength = ref(0.8);      // 强度 0~1
  const tool = ref('paint');
  const targetIdx = ref(1);
  const showCells = ref(true);
  const showBorders = ref(true);
  const showNoStar = ref(false);

  // 省界 / 轮廓缓存：只跟「网格 + 版本号」走（提取 + 平滑 ~2ms，但不能每帧重算）
  let borderToken = 0;
  const cache = { key: null, token: -1, chains: [], segs: 0 };
  const cellCache = { key: null, token: -1, fast: false, outlines: null, loops: 0, pts: 0, cost: 0 };

  /** 数据变了以后必须调一次（否则省界与省域轮廓还是旧的） */
  function invalidateBorders() { borderToken++; }

  function borderChains(key, labels, grid) {
    if (cache.key === key && cache.token === borderToken) return cache.chains;
    const raw = extractBorders(labels, grid);
    cache.key = key;
    cache.token = borderToken;
    cache.chains = raw.map(ch => chaikin(ch, 2));
    cache.segs = raw.reduce((a, ch) => a + ch.length, 0);
    return cache.chains;
  }

  /** 归属格 → 每个省份的平滑闭合环（世界坐标，带缓存） */
  function provinceOutlines(key, labels, grid, fast) {
    if (cellCache.key === key && cellCache.token === borderToken && cellCache.fast === fast && cellCache.outlines) {
      return cellCache.outlines;
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const outlines = buildLabelOutlines(labels, grid.cols, grid.rows, {
      cell: grid.cell, ox: grid.ox, oy: grid.oy,
      eps: fast ? EPS_FAST : EPS_FULL,
      chaikinIters: fast ? 0 : 2,
      outside: 0,            // 网格外框 = 无主
      ignore: [0],           // 无主格不参与轮廓
      minAreaCells: fast ? MIN_AREA_FAST : MIN_AREA_FULL,
    });
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    cellCache.key = key;
    cellCache.token = borderToken;
    cellCache.fast = fast;
    cellCache.outlines = outlines;
    cellCache.cost = now - t0;
    cellCache.loops = 0;
    cellCache.pts = 0;
    for (const list of outlines.values()) for (const lp of list) { cellCache.loops++; cellCache.pts += lp.pts.length; }
    return outlines;
  }

  /** 供用例/诊断读：轮廓缓存状态 */
  function meshStats() {
    return {
      labels: cellCache.outlines ? cellCache.outlines.size : 0,
      loops: cellCache.loops, pts: cellCache.pts,
      cost: Math.round(cellCache.cost * 100) / 100, fast: cellCache.fast,
    };
  }

  /**
   * 画网格（省域色块 + 自动省界）。世界坐标绘制（ctx 已带相机变换）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} o { key, labels, grid, zoom, colorOf, viewRect, fast }
   *   colorOf(idx) → 颜色串（idx 为 0 时不调用）；viewRect = {minX,minY,maxX,maxY} 世界矩形（视口裁剪）
   *   fast = true 时走快速档（跳圆角/平滑，涂抹期保帧预算）
   */
  function drawProvinceGrid(ctx, { key, labels, grid, zoom = 1, colorOf, viewRect = null, fast = false } = {}) {
    if (!labels || !grid) return;
    const { cols, rows, cell, ox, oy } = grid;

    // 视口裁剪范围（世界坐标；缺省=全图）
    const vw = viewRect || { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };

    if (showCells.value) {
      // 取色兜底：colorOf 拿不到颜色也必须画出来（涂成透明 = 用户以为涂抹没生效）
      const pick = (idx) => (colorOf && colorOf(idx)) || FALLBACK_PALETTE[(idx - 1) % FALLBACK_PALETTE.length];

      // ① 无主格底色：整块一次 fill（旧实现逐格 rect，格子多时纯浪费）
      if (showNoStar.value) {
        ctx.save();
        ctx.fillStyle = 'rgba(18, 34, 52, 0.55)';
        ctx.fillRect(ox, oy, cols * cell, rows * cell);
        ctx.restore();
      }

      // ② 有主格：整省一遍平滑轮廓 fill（同色描边堵掉圆角内收的细缝）
      const outlines = provinceOutlines(key, labels, grid, !!fast);
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const [idx, loops] of outlines) {
        ctx.beginPath();
        let any = false;
        for (const lp of loops) {
          const bb = lp.bbox;
          if (bb[2] < vw.minX || bb[0] > vw.maxX || bb[3] < vw.minY || bb[1] > vw.maxY) continue;
          const p = lp.pts;
          ctx.moveTo(p[0].x, p[0].y);
          for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
          ctx.closePath();
          any = true;
        }
        if (!any) continue;
        const color = pick(idx);
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = cell * 0.5;
        ctx.stroke();
        ctx.fill('evenodd');
      }
      ctx.restore();
    }

    if (showBorders.value) {
      const chains = borderChains(key, labels, grid);
      ctx.strokeStyle = 'rgba(8, 14, 24, 0.78)';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1 / Math.max(zoom, 1e-6), cell * 0.18);
      ctx.beginPath();
      for (const ch of chains) {
        for (let i = 0; i < ch.length; i++) {
          if (i) ctx.lineTo(ch[i].x, ch[i].y);
          else ctx.moveTo(ch[i].x, ch[i].y);
        }
      }
      ctx.stroke();
    }
  }

  return {
    radius, strength, tool, targetIdx, showCells, showBorders, showNoStar,
    PROVINCE_TOOLS, invalidateBorders, borderChains, drawProvinceGrid,
    provinceOutlines, meshStats,
  };
}
