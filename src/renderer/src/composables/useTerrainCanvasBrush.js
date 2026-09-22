/**
 * useTerrainCanvasBrush.js — 画布地形涂色笔刷 composable
 *
 * 与「高度图笔刷」共用同一套网格几何（同一数据源 = mapData[planetId].heightmap.grid）：
 * - 同样的格宽（heightmap.grid.spacing，14.4 世界单位）→ 两套笔刷的像素**完全对齐**，
 *   不再出现"两团不同规格的像素打架"
 * - 原点对齐高度图网格，但**四周多留 EXTRA_CELLS 圈**（涂色范围比高度图数据区更大，
 *   这样大陆外缘的海域也有地方涂）
 * - 无高度图时按地形包围盒 + 同一格宽推导（两者仍同粒度）
 *
 * 数据：mapData[planetId].terrainGrid = Uint8Array(cols × rows)
 *   0..7 = TERRAIN_TYPES 索引（0 是海洋，是有效值）；255 = 未绘制
 *   持久化：普通数组（TypedArray 过 JSON 会退化成无 length 的对象 → 读回即废）
 *   撤销：beginGridSnapshot（按下）→ 实时改 → endGridStroke（抬起，一次 stroke = 一条 undo）
 */

import { ref, toRaw, watch } from 'vue';
import { TerrainBrush, TERRAIN_TYPES } from '../utils/terrainBrush';
import { buildLabelOutlines } from '../utils/gridOutline';
import { beginGridSnapshot, endGridStroke } from '../store/undo';
import { brushSegmentRect } from '../utils/dirtyRect';

const DEFAULT_SPACING = 14.4; // 与 heightMath / 高度图保持同一格宽
const EMPTY_TERRAIN = 255;    // 未绘制（0 是海洋）
const EXTRA_CELLS = 16;       // 地形涂色区比高度图数据区四周各多留的圈数（给大陆外缘留涂色余地）
const MAX_COLS = 512;
const MAX_ROWS = 512;
const DEFAULT_EXTENT = 1200;  // 无地形数据时的兜底覆盖半径

// ===== 有机轮廓渲染参数（替代「逐格 roundRect + 5 档噪点」的马赛克画法）=====
const OUTLINE_EPS_CELLS = 0.75;      // RDP 容差，**以格为单位**（格宽会变，固定世界单位阈值会失效）
const OUTLINE_CHAIKIN_ITERS = 2;     // 圆角细分次数
const OUTLINE_MIN_AREA_CELLS = 0.5;  // 小于半格的碎块不画（纯噪声）
const OUTLINE_MIN_THROTTLE_MS = 50;  // 涂抹中轮廓重算的最小间隔
// ⚠️ 不要在这里再叠「纸感颗粒 / 噪点瓦片」：任何逐像素级的随机变化，在真实缩放下
//    都会被读成细密马赛克（这正是本次要修的东西）。要质感就做**大尺度**明暗。

export function useTerrainCanvasBrush({ store, props, renderer, canvas }) {
  const terrainBrushSize = ref(6); // 笔刷直径（单位：格）
  const terrainBrushHardness = ref(0.5);
  const terrainBrushType = ref(2); // 默认草地
  const isTerrainBrushing = ref(false);
  const terrainGrid = ref(null); // Uint8Array
  const gridWidth = ref(0);
  const gridHeight = ref(0);
  const cellWorldSize = ref(DEFAULT_SPACING);
  const lastBrushX = ref(0);
  const lastBrushY = ref(0);
  const terrainGridEnabled = ref(false);
  const terrainBrushPreview = ref(null); // { x, y, radius }

  let gridOriginX = 0;
  let gridOriginY = 0;

  // 轮廓渲染缓存状态（声明放在最前，避免 setup 期 TDZ：几何函数会调用 markOutlineDirty）
  let outlineRevision = 0;     // 每次涂抹/重采样/换行星自增
  let outlineBuiltRev = -1;    // 已建缓存对应的 revision
  let outlineForce = false;    // 下次绘制必须重建（起笔、抬手）
  let outlineCache = null;     // Map<label, Array<{pts, bbox}>>
  let outlineBuildCost = 0;    // 上次重建耗时（用于自适应节流）
  let outlineBuiltAt = 0;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const unwrap = (v) => (v && typeof v === 'object') ? toRaw(toRaw(v)) : v;
  const ptX = (p) => Array.isArray(p) ? p[0] : p.x;
  const ptY = (p) => Array.isArray(p) ? p[1] : p.y;

  function rawEntry() {
    const id = props.planet?.id;
    if (!id) return null;
    const map = unwrap(store.mapData);
    const entry = map && map[id];
    return entry ? unwrap(entry) : null;
  }

  function terrainBounds(md) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of md?.terrain || []) {
      for (const p of poly?.points || []) {
        const px = ptX(p), py = ptY(p);
        if (typeof px !== 'number' || typeof py !== 'number') continue;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }
    if (!isFinite(minX)) {
      return { minX: -DEFAULT_EXTENT, minY: -DEFAULT_EXTENT, maxX: DEFAULT_EXTENT, maxY: DEFAULT_EXTENT };
    }
    return { minX, minY, maxX, maxY };
  }

  // 目标几何：优先与高度图网格同粒度、同原点（外扩 EXTRA_CELLS 圈），否则由地形包围盒推导
  function targetGeometry(md) {
    const hmGrid = unwrap(md?.heightmap)?.grid;
    const hmPts = hmGrid ? (unwrap(hmGrid.points) || hmGrid.points) : null;
    if (hmPts && hmPts.length > 0 && Number.isInteger(hmGrid.cellsX) && Number.isInteger(hmGrid.cellsY)) {
      const cell = hmGrid.spacing || DEFAULT_SPACING;
      return {
        cell,
        originX: ptX(hmPts[0]) - EXTRA_CELLS * cell,
        originY: ptY(hmPts[0]) - EXTRA_CELLS * cell,
        cols: clamp(hmGrid.cellsX + EXTRA_CELLS * 2, 8, MAX_COLS),
        rows: clamp(hmGrid.cellsY + EXTRA_CELLS * 2, 8, MAX_ROWS),
        grid: null,
      };
    }
    const b = terrainBounds(md);
    const cell = DEFAULT_SPACING;
    const originX = Math.floor(b.minX / cell) * cell - EXTRA_CELLS * cell;
    const originY = Math.floor(b.minY / cell) * cell - EXTRA_CELLS * cell;
    return {
      cell, originX, originY,
      cols: clamp(Math.ceil((b.maxX - originX) / cell) + EXTRA_CELLS, 8, MAX_COLS),
      rows: clamp(Math.ceil((b.maxY - originY) / cell) + EXTRA_CELLS, 8, MAX_ROWS),
      grid: null,
    };
  }

  function emptyGrid(geom) {
    const g = new Uint8Array(geom.cols * geom.rows);
    g.fill(EMPTY_TERRAIN);
    return g;
  }

  // 已涂内容按「世界坐标」重采样到新几何：格宽/原点变了也绝不丢已涂地形
  // （典型场景：早期 30m 格数据 → 统一到 14.4m 格；或高度图重建后原点微移）
  function resampleInto(raw, from, geom) {
    const out = emptyGrid(geom);
    for (let r = 0; r < geom.rows; r++) {
      const wy = geom.originY + (r + 0.5) * geom.cell;
      const or = Math.floor((wy - from.originY) / from.cell);
      if (or < 0 || or >= from.rows) continue;
      const outRow = r * geom.cols;
      for (let c = 0; c < geom.cols; c++) {
        const wx = geom.originX + (c + 0.5) * geom.cell;
        const oc = Math.floor((wx - from.originX) / from.cell);
        if (oc < 0 || oc >= from.cols) continue;
        const v = raw[or * from.cols + oc];
        if (v !== EMPTY_TERRAIN) out[outRow + c] = v;
      }
    }
    return out;
  }

  function resolveGeometry(md) {
    const geom = targetGeometry(md);
    const raw = md?.terrainGrid;
    const cols = md?.gridWidth, rows = md?.gridHeight, cell = md?.cellWorldSize;
    const ox = md?.gridOriginX, oy = md?.gridOriginY;
    const persistedOk = raw && typeof raw.length === 'number' && raw.length > 0
      && Number.isInteger(cols) && Number.isInteger(rows) && cols * rows === raw.length
      && typeof cell === 'number' && cell > 0 && typeof ox === 'number' && typeof oy === 'number';
    if (!persistedOk) { geom.grid = emptyGrid(geom); return geom; }

    const sameGeom = cell === geom.cell && cols === geom.cols && rows === geom.rows
      && Math.abs(ox - geom.originX) < 1e-6 && Math.abs(oy - geom.originY) < 1e-6;
    if (sameGeom) { geom.grid = Uint8Array.from(raw); return geom; }

    geom.grid = resampleInto(raw, { cols, rows, cell, originX: ox, originY: oy }, geom);
    return geom;
  }

  function applyGeometry(g) {
    terrainGrid.value = g.grid;
    gridWidth.value = g.cols;
    gridHeight.value = g.rows;
    cellWorldSize.value = g.cell;
    gridOriginX = g.originX;
    gridOriginY = g.originY;
    markOutlineDirty(true); // 几何/数据变了 → 轮廓缓存作废
  }

  function initTerrainGrid() {
    const planetId = props.planet?.id;
    if (!planetId) return false;
    // 读原始对象：网格点数万级，逐属性读代理会明显变慢
    const md = rawEntry();
    if (!md) return false; // 地图数据尚未加载 → 由 mousedown 懒初始化重试
    applyGeometry(resolveGeometry(md));
    terrainGridEnabled.value = true;
    renderer.requestRender();
    return true;
  }

  // ===== 笔刷 =====
  // size 用世界单位传入：slider 的"格数" × 格宽 → 与网格同单位（曾直接传格数 = 只涂 1 格）
  const terrainBrush = new TerrainBrush({ size: 90, hardness: 0.5, terrainType: terrainBrushType.value });

  function syncBrush() {
    terrainBrush.size = Math.max(1, terrainBrushSize.value) * cellWorldSize.value;
    terrainBrush.hardness = terrainBrushHardness.value;
    terrainBrush.terrainType = terrainBrushType.value;
  }

  // paint() 只写 weight > 0.15 的格（与 TerrainBrush.getWeight 一致）→ 预览圈画真实生效半径
  function effectiveRadiusFactor() {
    const h = terrainBrushHardness.value;
    return 1 - Math.pow(0.15, h * 0.99 + 0.01);
  }

  function updateBrushPreview(wx, wy) {
    const r = (terrainBrushSize.value * cellWorldSize.value) / 2 * effectiveRadiusFactor();
    terrainBrushPreview.value = { x: wx, y: wy, radius: r };
  }

  function clearBrushPreview() { terrainBrushPreview.value = null; }

  // P2-3 脏矩形：网格笔刷的实际影响半径（含预览圈，预览半径 ≤ 涂抹半径）
  function brushWorldRadius() {
    return Math.max(1, (terrainBrushSize.value * cellWorldSize.value) / 2);
  }

  /** 把「上一落点 → 本落点」的覆盖范围交给脏矩形追踪器（缺一就会留拖尾） */
  function markBrushDirty(prev, cur) {
    if (!renderer.markDirtyRect) return;
    renderer.markDirtyRect(brushSegmentRect(prev, cur, brushWorldRadius()));
  }

  function paintAt(wx, wy) {
    terrainBrush.paint(
      terrainGrid.value, gridWidth.value, gridHeight.value,
      wx - gridOriginX, wy - gridOriginY, cellWorldSize.value,
    );
    markOutlineDirty();
  }

  function startTerrainBrush(wx, wy) {
    if (!terrainGrid.value) return;
    isTerrainBrushing.value = true;
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    beginGridSnapshot(terrainGrid.value, 'terrain-paint', `涂色地形（${TERRAIN_TYPES[terrainBrushType.value]?.name || '橡皮擦'}）`);
    syncBrush();
    paintAt(wx, wy);
    markOutlineDirty(true); // 起笔立即重建一次：否则第一笔要等节流窗口才出现在画布上
    updateBrushPreview(wx, wy);
    markBrushDirty(null, { x: wx, y: wy });
    renderer.requestRender();
  }

  function moveTerrainBrush(wx, wy) {
    if (!isTerrainBrushing.value || !terrainGrid.value) return;
    const prev = { x: lastBrushX.value, y: lastBrushY.value };
    terrainBrush.paintInterpolated(
      terrainGrid.value, gridWidth.value, gridHeight.value,
      lastBrushX.value - gridOriginX, lastBrushY.value - gridOriginY,
      wx - gridOriginX, wy - gridOriginY, cellWorldSize.value,
    );
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    markOutlineDirty();
    updateBrushPreview(wx, wy);
    markBrushDirty(prev, { x: wx, y: wy });
    renderer.requestRender();
  }

  function endTerrainBrush() {
    if (!isTerrainBrushing.value) return;
    isTerrainBrushing.value = false;
    markOutlineDirty(true); // 抬手落定：轮廓必须与最终格数据完全一致
    endGridStroke(terrainGrid.value, saveTerrainGrid);
  }

  function saveTerrainGrid() {
    const planetId = props.planet?.id;
    if (!planetId || !terrainGrid.value) return;
    // 必须基于原始对象展开：{...响应式代理} 会把每层属性换成代理塞进新容器，
    // 之后 toRaw(store.mapData)[id] 拿到的仍是代理 → 重循环重新退化成代理读（实测卡死）
    const current = unwrap(store.mapData) || {};
    const md = unwrap(current[planetId]);
    if (!md) return;
    store.mapData = {
      ...current,
      [planetId]: {
        ...md,
        terrainGrid: Array.from(terrainGrid.value),
        gridWidth: gridWidth.value,
        gridHeight: gridHeight.value,
        gridOriginX, gridOriginY,
        cellWorldSize: cellWorldSize.value,
        updatedAt: new Date().toISOString(),
      },
    };
    store.scheduleAutoSaveMap(planetId);
  }

  // ===== 渲染（世界坐标：onRender 传入的 ctx 已带 camera transform） =====
  //
  // 🔴 为什么不再逐格画：逐格 roundRect + 5 档噪点抖动，在真实缩放下（1 格 ≈ 2~3 屏幕像素）
  // 渲染出来的就是一片细密马赛克（用户实测原话「依然是马赛克方块填色，不是自然的笔刷」）。
  // 现在改为「栅格 → 矢量」：拿格边界抽平滑闭合环（utils/gridOutline：共线塌缩 + RDP + Chaikin），
  // 再一次性 fill。同色描边把相邻区域之间因圆角内收产生的细缝一起堵掉。
  function markOutlineDirty(force = false) {
    outlineRevision++;
    if (force) outlineForce = true;
  }

  function rebuildOutlines() {
    if (!terrainGrid.value) { outlineCache = null; return; }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    outlineCache = buildLabelOutlines(terrainGrid.value, gridWidth.value, gridHeight.value, {
      cell: cellWorldSize.value,
      ox: gridOriginX,
      oy: gridOriginY,
      eps: OUTLINE_EPS_CELLS,
      chaikinIters: OUTLINE_CHAIKIN_ITERS,
      outside: EMPTY_TERRAIN,
      ignore: [EMPTY_TERRAIN],
      minAreaCells: OUTLINE_MIN_AREA_CELLS,
    });
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    outlineBuildCost = now - t0;
    outlineBuiltAt = now;
    outlineBuiltRev = outlineRevision;
    outlineForce = false;
  }

  function drawTerrainGridToCtx(ctx) {
    if (!terrainGridEnabled.value || !terrainGrid.value) return;

    // 重建闸门：轮廓重算是 O(格数)（真实库 3.9 万格实测 ~17ms），未变更则复用；
    // 涂抹中按「上次耗时的 2.5 倍」自适应节流，抬手/起笔强制重建。
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const stale = outlineForce || outlineBuiltRev !== outlineRevision || !outlineCache;
    if (stale && !(isTerrainBrushing.value && !outlineForce
      && now - outlineBuiltAt < Math.max(OUTLINE_MIN_THROTTLE_MS, outlineBuildCost * 2.5))) {
      rebuildOutlines();
    }
    const outlines = outlineCache;
    if (!outlines || !outlines.size) return;

    // 视口世界矩形 → 逐环剔除
    let vminX = -Infinity, vminY = -Infinity, vmaxX = Infinity, vmaxY = Infinity;
    const cvs = canvas?.value;
    if (cvs && cvs.clientWidth > 0) {
      const a = renderer.screenToWorld(0, 0);
      const b = renderer.screenToWorld(cvs.clientWidth, cvs.clientHeight);
      vminX = Math.min(a.x, b.x); vmaxX = Math.max(a.x, b.x);
      vminY = Math.min(a.y, b.y); vmaxY = Math.max(a.y, b.y);
    }

    const cell = cellWorldSize.value;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [label, loops] of outlines) {
      const type = TERRAIN_TYPES[label];
      if (!type) continue;
      ctx.beginPath();
      let any = false;
      for (const lp of loops) {
        const b = lp.bbox;
        if (b[2] < vminX || b[0] > vmaxX || b[3] < vminY || b[1] > vmaxY) continue;
        const pts = lp.pts;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        any = true;
      }
      if (!any) continue;
      const color = `rgb(${type.base[0]},${type.base[1]},${type.base[2]})`;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      // 同色描边 ≈ 外扩半线宽：既柔化轮廓，也堵住相邻区域圆角内收留下的细缝
      ctx.lineWidth = cell * 0.9;
      ctx.stroke();
      ctx.fill('evenodd');
    }
    ctx.restore();
    ctx.beginPath(); // 收尾清空路径，避免污染后续绘制
  }

  /** 供用例/诊断读：上次轮廓重建耗时与环数 */
  function outlineStats() {
    let loops = 0, pts = 0;
    if (outlineCache) for (const list of outlineCache.values()) for (const l of list) { loops++; pts += l.pts.length; }
    return { cost: outlineBuildCost, loops, pts, rev: outlineBuiltRev };
  }


  function clearTerrainBrush() {
    isTerrainBrushing.value = false;
    lastBrushX.value = 0;
    lastBrushY.value = 0;
    clearBrushPreview();
  }

  watch([terrainBrushSize, terrainBrushHardness, terrainBrushType], syncBrush);
  watch(() => props.planet?.id, () => {
    terrainGridEnabled.value = false;
    terrainGrid.value = null;
    markOutlineDirty(true);
  });

  return {
    terrainBrushSize,
    terrainBrushHardness,
    terrainBrushType,
    isTerrainBrushing,
    terrainGrid,
    gridWidth,
    gridHeight,
    cellWorldSize,
    terrainGridEnabled,
    terrainBrushPreview,

    initTerrainGrid,
    startTerrainBrush,
    moveTerrainBrush,
    endTerrainBrush,
    drawTerrainGridToCtx,
    outlineStats,
    invalidateTerrainOutline: markOutlineDirty,
    clearTerrainBrush,
    clearBrushPreview,
    updateBrushPreview,
    syncBrush,
    saveTerrainGrid,

    TERRAIN_TYPES,
    EMPTY_TERRAIN,
  };
}
