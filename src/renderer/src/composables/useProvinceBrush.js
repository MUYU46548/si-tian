// composables/useProvinceBrush.js — 省份笔刷 / 套索的状态 + 画布渲染（Phase 3）
//
// 只做两件事：① 持有笔刷参数与套索轨迹；② 把「归属标签网格」画出来（格 + 自动省界）。
// 数据写入一律走 store 的 provinceEditing 模块（一笔 = 一条 undo），本文件不改数据。
//
// 渲染技法沿用铁律 87：格用 roundRect + 屏幕空间 blur 消体素感；blur 必须按 1/zoom 补偿，
// 画完必须 `ctx.filter = 'none'`（否则后面的省界/标签全糊）。onRender 的 ctx 已带相机变换
// （铁律 77）→ 这里一律用**世界坐标**绘制，线宽/圆角按 zoom 折算。

import { ref } from 'vue';
import { extractBorders, chaikin } from '../utils/provinceGrid';

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

export function useProvinceBrush() {
  const radius = ref(5);          // 半径（格）
  const strength = ref(0.8);      // 强度 0~1
  const tool = ref('paint');
  const targetIdx = ref(1);
  const showCells = ref(true);
  const showBorders = ref(true);
  const showNoStar = ref(false);

  // 省界缓存：只跟「网格 + 版本号」走（提取 + 平滑 ~2ms，但不能每帧重算）
  let borderToken = 0;
  const cache = { key: null, token: -1, chains: [], segs: 0 };

  /** 数据变了以后必须调一次（否则省界还是旧的） */
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

  /**
   * 画网格 + 省界。世界坐标绘制（ctx 已带相机变换）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} o { key, labels, grid, zoom, colorOf, viewRect, fast }
   *   colorOf(idx) → 颜色串（idx 为 0 时不调用）；viewRect = {minX,minY,maxX,maxY} 世界矩形（视口裁剪）
   *   fast = true 时走快速档（关圆角与模糊，涂抹期保帧预算）
   */
  function drawProvinceGrid(ctx, { key, labels, grid, zoom = 1, colorOf, viewRect = null, fast = false } = {}) {
    if (!labels || !grid) return;
    const { cols, rows, cell, ox, oy } = grid;
    const cellScreen = cell * zoom;
    const quality = !fast && cellScreen >= 2.5;
    const roundR = quality ? Math.min(cell * 0.22, 4 / Math.max(zoom, 1e-6)) : 0;
    const saved = ctx.filter;

    // 视口裁剪范围（格坐标）
    let c0 = 0, c1 = cols - 1, r0 = 0, r1 = rows - 1;
    if (viewRect) {
      c0 = Math.max(0, Math.floor((viewRect.minX - ox) / cell) - 1);
      c1 = Math.min(cols - 1, Math.ceil((viewRect.maxX - ox) / cell) + 1);
      r0 = Math.max(0, Math.floor((viewRect.minY - oy) / cell) - 1);
      r1 = Math.min(rows - 1, Math.ceil((viewRect.maxY - oy) / cell) + 1);
    }

    if (showCells.value) {
      if (quality) ctx.filter = `blur(${(1.4 / Math.max(1, zoom)).toFixed(2)}px)`;
      // 取色兜底：colorOf 拿不到颜色也必须画出来（素描成透明 = 用户以为涂抹没生效）
      const pick = (idx) => (colorOf && colorOf(idx)) || FALLBACK_PALETTE[(idx - 1) % FALLBACK_PALETTE.length];
      // 无主格（海域/未划归）：整片一个颜色，一次 fill
      if (showNoStar.value) {
        ctx.fillStyle = 'rgba(18, 34, 52, 0.55)';
        ctx.beginPath();
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            if (labels[r * cols + c]) continue;
            const X = ox + c * cell, Y = oy + r * cell;
            if (quality) ctx.roundRect(X, Y, cell, cell, roundR); else ctx.rect(X, Y, cell, cell);
          }
        }
        ctx.fill();
      }
      // 有主格：按「连续同序号」分批（一行内成批 → 少切 fillStyle）
      let last = -1;
      for (let r = r0; r <= r1; r++) {
        last = -1;
        for (let c = c0; c <= c1; c++) {
          const v = labels[r * cols + c];
          if (v !== last) {
            if (last > 0) { ctx.fillStyle = pick(last); ctx.fill(); }
            ctx.beginPath();
            last = v;
          }
          if (v > 0) {
            const X = ox + c * cell, Y = oy + r * cell;
            if (quality) ctx.roundRect(X, Y, cell, cell, roundR); else ctx.rect(X, Y, cell, cell);
          }
        }
        if (last > 0) { ctx.fillStyle = pick(last); ctx.fill(); }
      }
      ctx.filter = saved || 'none';
    }

    if (showBorders.value) {
      const chains = borderChains(key, labels, grid);
      ctx.strokeStyle = 'rgba(8, 14, 24, 0.78)';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1 / Math.max(zoom, 1e-6), quality ? cell * 0.18 : cell * 0.12);
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
  };
}
