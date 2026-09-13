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
import { beginGridSnapshot, endGridStroke } from '../store/undo';

const DEFAULT_SPACING = 14.4; // 与 heightMath / 高度图保持同一格宽
const EMPTY_TERRAIN = 255;    // 未绘制（0 是海洋）
const EXTRA_CELLS = 16;       // 地形涂色区比高度图数据区四周各多留的圈数（给大陆外缘留涂色余地）
const MAX_COLS = 512;
const MAX_ROWS = 512;
const DEFAULT_EXTENT = 1200;  // 无地形数据时的兜底覆盖半径

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

  function paintAt(wx, wy) {
    terrainBrush.paint(
      terrainGrid.value, gridWidth.value, gridHeight.value,
      wx - gridOriginX, wy - gridOriginY, cellWorldSize.value,
    );
  }

  function startTerrainBrush(wx, wy) {
    if (!terrainGrid.value) return;
    isTerrainBrushing.value = true;
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    beginGridSnapshot(terrainGrid.value, 'terrain-paint', `涂色地形（${TERRAIN_TYPES[terrainBrushType.value]?.name || '橡皮擦'}）`);
    syncBrush();
    paintAt(wx, wy);
    updateBrushPreview(wx, wy);
    renderer.requestRender();
  }

  function moveTerrainBrush(wx, wy) {
    if (!isTerrainBrushing.value || !terrainGrid.value) return;
    terrainBrush.paintInterpolated(
      terrainGrid.value, gridWidth.value, gridHeight.value,
      lastBrushX.value - gridOriginX, lastBrushY.value - gridOriginY,
      wx - gridOriginX, wy - gridOriginY, cellWorldSize.value,
    );
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    updateBrushPreview(wx, wy);
    renderer.requestRender();
  }

  function endTerrainBrush() {
    if (!isTerrainBrushing.value) return;
    isTerrainBrushing.value = false;
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
  function drawTerrainGridToCtx(ctx) {
    if (!terrainGridEnabled.value || !terrainGrid.value) return;
    const grid = terrainGrid.value;
    const cols = gridWidth.value, rows = gridHeight.value;
    const cell = cellWorldSize.value;

    let c0 = 0, c1 = cols - 1, r0 = 0, r1 = rows - 1;
    const cvs = canvas?.value;
    if (cvs && cvs.clientWidth > 0) {
      const a = renderer.screenToWorld(0, 0);
      const b = renderer.screenToWorld(cvs.clientWidth, cvs.clientHeight);
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      c0 = clamp(Math.floor((minX - gridOriginX) / cell) - 1, 0, cols - 1);
      c1 = clamp(Math.ceil((maxX - gridOriginX) / cell) + 1, 0, cols - 1);
      r0 = clamp(Math.floor((minY - gridOriginY) / cell) - 1, 0, rows - 1);
      r1 = clamp(Math.ceil((maxY - gridOriginY) / cell) + 1, 0, rows - 1);
    }

    // 按「地形类型 × 噪点档」批量成路径再一次性 fill（逐格 fillStyle+fillRect 是拖拽卡顿主因）
    for (let t = 0; t < TERRAIN_TYPES.length; t++) {
      const type = TERRAIN_TYPES[t];
      if (!type) continue;
      for (let nb = 0; nb < 5; nb++) {
        const noise = nb - 2;
        ctx.beginPath();
        let any = false;
        for (let row = r0; row <= r1; row++) {
          const rowBase = row * cols;
          for (let col = c0; col <= c1; col++) {
            if (grid[rowBase + col] !== t) continue;
            if (((col * 7 + row * 13) % 5) - 2 !== noise) continue;
            ctx.rect(gridOriginX + col * cell, gridOriginY + row * cell, cell, cell);
            any = true;
          }
        }
        if (!any) continue;
        ctx.fillStyle = `rgb(${clamp(type.base[0] + noise, 0, 255)},${clamp(type.base[1] + noise, 0, 255)},${clamp(type.base[2] + noise, 0, 255)})`;
        ctx.fill();
      }
    }
    ctx.beginPath(); // 收尾清空路径，避免污染后续绘制
  }

  function clearTerrainBrush() {
    isTerrainBrushing.value = false;
    lastBrushX.value = 0;
    lastBrushY.value = 0;
    clearBrushPreview();
  }

  watch([terrainBrushSize, terrainBrushHardness, terrainBrushType], syncBrush);
  watch(() => props.planet?.id, () => { terrainGridEnabled.value = false; terrainGrid.value = null; });

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
    clearTerrainBrush,
    clearBrushPreview,
    updateBrushPreview,
    syncBrush,
    saveTerrainGrid,

    TERRAIN_TYPES,
    EMPTY_TERRAIN,
  };
}
