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
import { execute } from '../store/undo';
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

export function useTerrainCanvasBrush({ store, props, renderer, canvas, getWorldBounds }) {
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
  /** L2 笔迹层：这一笔已走过的世界坐标（**只画，不落库**）；松手即清空 */
  const strokePath = ref([]);
  const STROKE_PATH_MAX = 320;
  /**
   * L3「将涂格」高亮（第 4 件，2026-10-24）：拖动中**只算不写**，把这些格以半透明色叠在画面上；
   * 松手时沿同一条笔迹一次性落库。`{col,row}` 是**这一笔起笔时的格点**（世界格，无界）。
   * 松手前数据一格都不动 —— 这就是"所见即所得"的判据基础（预览格集 == 落库格集）。
   */
  const terrainPendingCells = ref([]);   // Array<{col,row}>（去重；只增不改，供渲染/用例读）
  let pendingMap = null;                  // Map<'col,row', 1>（比数组快；渲染前才摊平）
  let pendingOrigin = null;               // {x, y, cell}：这一笔的格点原点（扩网格不改对齐）
  let pendingRev = 0;
  let pendingRuns = null;                 // [{type,row,c0,c1}]：按行合并的连续段（渲染缓存）
  let pendingRunsRev = -1;

  let gridOriginX = 0;
  let gridOriginY = 0;
  let strokeSnapshot = null; // 本笔的 {grid, geom, label}：几何也可能被扩，撤销要能一起还原
  let rawPath = [];          // 这一笔的**原始落点**（落库回放用；L2 显示另走抽稀的 strokePath）

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

  // 目标几何：与高度图同粒度、同原点（像素对齐，铁律 89），范围取**并集**：
  //   ① 高度图数据区  ② 地图可见范围（worldBounds：地形/区域/路线/标记/文本/地点坐标）
  //   ③ 已落盘的涂色数据范围
  // 🔴 只按高度图定范围会在地图上留下「画不进去的真空区」（用户实测原话：「似乎无法越过某条
  //    隐藏界限，在画布某些区域无法绘制，形成明显的真空区」）——真实库 `乐园星` 的
  //    高度图只覆盖 843→-1029，而地图内容一直排到 y=1629：底部 555m 的条带**看得见却涂不上**。
  function paintedBounds(md) {
    const raw = md?.terrainGrid;
    const cols = md?.gridWidth, rows = md?.gridHeight, cell = md?.cellWorldSize;
    const ox = md?.gridOriginX, oy = md?.gridOriginY;
    const ok = raw && typeof raw.length === 'number' && cols * rows === raw.length
      && Number.isInteger(cols) && Number.isInteger(rows)
      && typeof cell === 'number' && cell > 0 && typeof ox === 'number' && typeof oy === 'number';
    if (!ok) return null;
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        if (raw[base + c] === EMPTY_TERRAIN) continue;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
    }
    if (!isFinite(minC)) return null;
    return {
      minX: ox + minC * cell, minY: oy + minR * cell,
      maxX: ox + (maxC + 1) * cell, maxY: oy + (maxR + 1) * cell,
    };
  }

  function targetGeometry(md) {
    const hmGrid = unwrap(md?.heightmap)?.grid;
    const hmPts = hmGrid ? (unwrap(hmGrid.points) || hmGrid.points) : null;
    const hasHm = !!(hmPts && hmPts.length > 0
      && Number.isInteger(hmGrid.cellsX) && Number.isInteger(hmGrid.cellsY));
    const cell = hasHm ? (hmGrid.spacing || DEFAULT_SPACING) : DEFAULT_SPACING;

    const b = terrainBounds(md);
    let minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY;
    if (hasHm) {
      const h0 = ptX(hmPts[0]), v0 = ptY(hmPts[0]);
      minX = Math.min(minX, h0);
      minY = Math.min(minY, v0);
      maxX = Math.max(maxX, h0 + (hmGrid.cellsX - 1) * cell);
      maxY = Math.max(maxY, v0 + (hmGrid.cellsY - 1) * cell);
    }
    const wb = getWorldBounds ? getWorldBounds() : null;
    if (wb && Number.isFinite(wb.minX) && Number.isFinite(wb.maxX)) {
      minX = Math.min(minX, wb.minX); minY = Math.min(minY, wb.minY);
      maxX = Math.max(maxX, wb.maxX); maxY = Math.max(maxY, wb.maxY);
    }
    const pb = paintedBounds(md);
    if (pb) {
      minX = Math.min(minX, pb.minX); minY = Math.min(minY, pb.minY);
      maxX = Math.max(maxX, pb.maxX); maxY = Math.max(maxY, pb.maxY);
    }

    // 原点对齐到「与高度图同相位」的格点：否则地形格与高度图格会差半个格，两套笔刷的
    // 像素不再对齐（铁律 89 的「两团不同规格的像素打架」）。无高度图时以 0 为锚点。
    const ax = hasHm ? ptX(hmPts[0]) : 0;
    const ay = hasHm ? ptY(hmPts[0]) : 0;
    const originX = ax + (Math.floor((minX - ax) / cell) - EXTRA_CELLS) * cell;
    const originY = ay + (Math.floor((minY - ay) / cell) - EXTRA_CELLS) * cell;
    return {
      cell, originX, originY,
      cols: clamp(Math.ceil((maxX - originX) / cell) + EXTRA_CELLS, 8, MAX_COLS),
      rows: clamp(Math.ceil((maxY - originY) / cell) + EXTRA_CELLS, 8, MAX_ROWS),
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

  /**
   * 记一个笔迹点（L2 笔迹层用；**不参与任何写入**）。
   * 抽稀口径：与上一点距离 < 半个格宽就不记（一笔下来点数是"路径长度/间距"，不是采样帧数）。
   */
  function pushStrokePoint(wx, wy) {
    const p = strokePath.value;
    const last = p[p.length - 1];
    const minStep = Math.max(1.5, cellWorldSize.value * 0.5);
    if (last && Math.hypot(wx - last.x, wy - last.y) < minStep) return;
    if (p.length >= STROKE_PATH_MAX) {
      strokePath.value = p.filter((_, i) => i % 2 === 0 || i === p.length - 1).concat([{ x: wx, y: wy }]);
      return;
    }
    strokePath.value = p.concat([{ x: wx, y: wy }]);
  }

  // P2-3 脏矩形：网格笔刷的实际影响半径（含预览圈，预览半径 ≤ 涂抹半径）
  function brushWorldRadius() {
    return Math.max(1, (terrainBrushSize.value * cellWorldSize.value) / 2);
  }

  /** 把「上一落点 → 本落点」的覆盖范围交给脏矩形追踪器（缺一就会留拖尾） */
  function markBrushDirty(prev, cur) {
    if (!renderer.markDirtyRect) return;
    renderer.markDirtyRect(brushSegmentRect(prev, cur, brushWorldRadius()));
  }

  /**
   * 「将涂格」的脏矩形：**覆盖整批 pending 格**，而不是只覆盖笔刷圆心轨迹。
   *
   * 为什么需要（2026-10-25，test_140 偶发红）：局部重绘只画脏矩形内的内容；
   * 笔刷轨迹矩形与 pending 格的外接框并不总是重合（格点对齐、扩网格平移、沿笔迹外侧的格），
   * 于是 pending 数据在、`drawTerrainPendingToCtx` 也调了，但落在裁剪区外 → 像素差 0。
   * 这里按 pending 格的真实外接框补一个脏矩形，保证"预览画得出来"。
   */
  function markPendingDirty() {
    if (!renderer.markDirtyRect || !pendingOrigin || !pendingMap || !pendingMap.size) return;
    const { x: ox, y: oy, cell } = pendingOrigin;
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const key of pendingMap.keys()) {
      const i = key.indexOf(',');
      const c = Number(key.slice(0, i));
      const r = Number(key.slice(i + 1));
      if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    if (!Number.isFinite(minC) || !Number.isFinite(minR)) return;
    const pad = cell;
    renderer.markDirtyRect({
      x: ox + minC * cell - pad,
      y: oy + minR * cell - pad,
      w: (maxC - minC + 1) * cell + pad * 2,
      h: (maxR - minR + 1) * cell + pad * 2,
    });
  }

  /**
   * L3「将涂格」高亮：拖动中**只算不写**，把这些格以半透明色叠在画面上；松手时一次性落库。
   * 判据（"所见即所得"）：预览的格集 == 松手后真正被写的格集 —— 靠**同一份枚举**保证
   * （`terrainBrush.forEachCell/forEachInterpolatedCell` 被预览与落库共用）。
   *
   * ⚠️ 落库回放走的是 `rawPath`（**原始落点**），不是 L2 显示用的 `strokePath`（抽稀过的）——
   *    抽稀会丢掉中间点，回放走的折线就与预览扫过的折线不同，边角上必然对不上。
   */
  function beginPending() {
    // ⚠️ 类型也要**固定在起笔时**：拖动中改笔刷类型（工具栏可点）会让"预览混两种色、
    //    落库全按最后一种"—— 那是肉眼能看出来的不一致。
    pendingOrigin = { x: gridOriginX, y: gridOriginY, cell: cellWorldSize.value, type: terrainBrushType.value };
    pendingMap = new Map();
    pendingRev += 1;
    pendingRuns = null;
    terrainPendingCells.value = [];
  }

  function clearPending() {
    pendingMap = null;
    pendingOrigin = null;
    pendingRev += 1;
    pendingRuns = null;
    rawPath = [];
    terrainPendingCells.value = [];
  }

  /** 把一个落点会碰到的格记进 pending（**不写网格**；格点与类型都用这一笔起笔时定下的） */
  function accumulateAt(wx, wy) {
    if (!pendingMap || !pendingOrigin) return;
    const { x: ox, y: oy, cell, type } = pendingOrigin;
    terrainBrush.forEachCell(-1, -1, wx - ox, wy - oy, cell, (row, col) => {
      const key = `${col},${row}`;
      if (!pendingMap.has(key)) pendingMap.set(key, type);
    });
  }

  /** 一段落点（原始点之间的直线）会碰到的格 —— 与 `paintInterpolated` 同一份插值采样 */
  function accumulateSegment(x1, y1, x2, y2) {
    if (!pendingMap || !pendingOrigin) return;
    const { x: ox, y: oy, cell, type } = pendingOrigin;
    terrainBrush.forEachInterpolatedCell(x1 - ox, y1 - oy, x2 - ox, y2 - oy, cell, (x, y) => {
      terrainBrush.forEachCell(-1, -1, x, y, cell, (row, col) => {
        const key = `${col},${row}`;
        if (!pendingMap.has(key)) pendingMap.set(key, type);
      });
    });
  }

  /** pending 的格（供用例/诊断读；无界格点，坐标相对这一笔的原点） */
  function pendingCells() {
    if (!pendingMap) return [];
    const out = [];
    for (const key of pendingMap.keys()) {
      const i = key.indexOf(',');
      out.push({ col: Number(key.slice(0, i)), row: Number(key.slice(i + 1)) });
    }
    return out;
  }

  /** 按行合并成连续段（渲染缓存：几千格也只画几十~几百个矩形） */
  function pendingRunsOf() {
    if (!pendingMap || !pendingMap.size) return [];
    if (pendingRuns && pendingRunsRev === pendingRev) return pendingRuns;
    const byRow = new Map();
    for (const [key, type] of pendingMap) {
      const i = key.indexOf(',');
      const col = Number(key.slice(0, i));
      const row = Number(key.slice(i + 1));
      let e = byRow.get(row);
      if (!e) { e = { type, cols: [] }; byRow.set(row, e); }
      e.cols.push(col);
    }
    const runs = [];
    for (const [row, e] of byRow) {
      e.cols.sort((a, b) => a - b);
      let c0 = e.cols[0];
      let prev = c0;
      for (let i = 1; i < e.cols.length; i += 1) {
        const c = e.cols[i];
        if (c === prev + 1) { prev = c; continue; }
        runs.push({ type: e.type, row, c0, c1: prev });
        c0 = c; prev = c;
      }
      runs.push({ type: e.type, row, c0, c1: prev });
    }
    runs.sort((a, b) => (a.type - b.type) || (a.row - b.row) || (a.c0 - b.c0));
    pendingRuns = runs;
    pendingRunsRev = pendingRev;
    return runs;
  }

  /** 把「将涂格」叠到画布上（世界坐标；PlanetMap 在地形网格之后调用） */
  function drawTerrainPendingToCtx(ctx) {
    if (!isTerrainBrushing.value || !pendingMap || !pendingMap.size || !pendingOrigin) return;
    const { x: ox, y: oy, cell } = pendingOrigin;
    const runs = pendingRunsOf();
    ctx.save();
    ctx.globalAlpha = 0.55;
    let lastType = -1;
    for (const r of runs) {
      if (r.type !== lastType) {
        const t = TERRAIN_TYPES[r.type] || TERRAIN_TYPES[0];
        ctx.fillStyle = `rgb(${t.base[0]},${t.base[1]},${t.base[2]})`;
        lastType = r.type;
      }
      ctx.fillRect(ox + r.c0 * cell, oy + r.row * cell, (r.c1 - r.c0 + 1) * cell, cell);
    }
    ctx.restore();
    ctx.beginPath();
  }

  function paintAt(wx, wy) {
    terrainBrush.paint(
      terrainGrid.value, gridWidth.value, gridHeight.value,
      wx - gridOriginX, wy - gridOriginY, cellWorldSize.value,
    );
    markOutlineDirty();
  }

  // ===== 覆盖范围按需扩张 =====
  //
  // 🔴 网格是定长 TypedArray，笔刷的 paint() 会把列/行下标 clamp 进 [0, cols-1] —— 落在网格外
  //    的落点**静默无效**，用户看到的就是「有一条看不见的墙，怎么涂都涂不上」。所以每个落点先
  //    确保「落点 ± 笔刷半径」在网格内：不够就把网格按世界坐标重采样扩出去（已涂内容不丢），
  //    扩张后的几何记进本笔的撤销快照里（撤销要能还原**几何**，不只是像素）。
  function snapshotGeometry() {
    return {
      cell: cellWorldSize.value, originX: gridOriginX, originY: gridOriginY,
      cols: gridWidth.value, rows: gridHeight.value,
    };
  }

  function applySnapshot(snap) {
    terrainGrid.value = Uint8Array.from(snap.grid);
    cellWorldSize.value = snap.geom.cell;
    gridOriginX = snap.geom.originX;
    gridOriginY = snap.geom.originY;
    gridWidth.value = snap.geom.cols;
    gridHeight.value = snap.geom.rows;
    markOutlineDirty(true);
    saveTerrainGrid();
    renderer.requestRender();
  }

  /** @returns {boolean} 是否真的扩了 */
  function ensureCoverage(wx, wy) {
    if (!terrainGrid.value) return false;
    const cell = cellWorldSize.value;
    const r = brushWorldRadius() + cell;
    const curMinX = gridOriginX, curMinY = gridOriginY;
    const curMaxX = gridOriginX + gridWidth.value * cell;
    const curMaxY = gridOriginY + gridHeight.value * cell;
    if (wx - r >= curMinX && wx + r <= curMaxX && wy - r >= curMinY && wy + r <= curMaxY) return false;

    const anchorX = gridOriginX, anchorY = gridOriginY;
    const originX = anchorX + (Math.floor((Math.min(wx - r, curMinX) - anchorX) / cell) - EXTRA_CELLS) * cell;
    const originY = anchorY + (Math.floor((Math.min(wy - r, curMinY) - anchorY) / cell) - EXTRA_CELLS) * cell;
    const cols = clamp(Math.ceil((Math.max(wx + r, curMaxX) - originX) / cell) + EXTRA_CELLS, 8, MAX_COLS);
    const rows = clamp(Math.ceil((Math.max(wy + r, curMaxY) - originY) / cell) + EXTRA_CELLS, 8, MAX_ROWS);
    if (cols === gridWidth.value && rows === gridHeight.value
      && Math.abs(originX - curMinX) < 1e-6 && Math.abs(originY - curMinY) < 1e-6) return false; // 到上限了

    const geom = { cell, originX, originY, cols, rows };
    geom.grid = resampleInto(terrainGrid.value,
      { cols: gridWidth.value, rows: gridHeight.value, cell, originX: curMinX, originY: curMinY }, geom);
    applyGeometry(geom);   // 已涂内容按世界坐标重采样保留
    return true;
  }

  function startTerrainBrush(wx, wy) {
    if (!terrainGrid.value) return;
    // 🔴 快照必须在**扩网格之前**取：一笔的撤销要连几何一起还原，否则画布会留下扩张后的网格
    //    （用户视角：我只涂了一笔然后撤销，网格却永久变大了）。onMouseUp 的 after 快照含扩张结果。
    strokeSnapshot = {
      grid: Uint8Array.from(terrainGrid.value),
      geom: snapshotGeometry(),
      label: `涂色地形（${TERRAIN_TYPES[terrainBrushType.value]?.name || '橡皮擦'}）`,
    };
    const expanded = ensureCoverage(wx, wy);   // 起笔仍扩一次：让预览的原点落在网格内（落笔本身在松手时才写）
    isTerrainBrushing.value = true;
    strokePath.value = [];
    rawPath = [{ x: wx, y: wy }];
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    syncBrush();
    // 🔴 第 4 件（2026-10-24）：拖动中**不写格**，只累积「将涂格」高亮；松手才落库。
    //    顺序很讲究：`beginPending` 要在起笔的 `ensureCoverage` **之后** —— 原点必须与
    //    本笔最终用的格点对齐（扩网格只会整体平移整数格，对齐关系不变）。
    beginPending();
    accumulateAt(wx, wy);
    // 起笔**不写格** → 只有"网格被扩了"才需要重建轮廓（几何变了）
    if (expanded) markOutlineDirty(true);
    updateBrushPreview(wx, wy);
    pushStrokePoint(wx, wy);
    markBrushDirty(null, { x: wx, y: wy });
    markPendingDirty();
    renderer.requestRender();
  }

  function moveTerrainBrush(wx, wy) {
    if (!isTerrainBrushing.value || !terrainGrid.value) return;
    const prev = { x: lastBrushX.value, y: lastBrushY.value };
    // ① 原始落点：落库回放用它（不是 L2 显示用的抽稀路径 —— 那条会丢中间点，边角必然对不上）
    const lastRaw = rawPath[rawPath.length - 1];
    if (!lastRaw || Math.hypot(wx - lastRaw.x, wy - lastRaw.y) > 1e-3) rawPath.push({ x: wx, y: wy });
    // ② 把这一段会碰到的格记进「将涂格」（不写网格）
    accumulateSegment(prev.x, prev.y, wx, wy);
    // ③ 覆盖范围拖到**松手**再统一扩（拖动中不写数据 → 没有"涂不上的真空区"）
    lastBrushX.value = wx;
    lastBrushY.value = wy;
    updateBrushPreview(wx, wy);
    pushStrokePoint(wx, wy);
    markBrushDirty(prev, { x: wx, y: wy });
    markPendingDirty();
    renderer.requestRender();
  }

  /** 沿这一笔的**原始落点**重放写格（与预览同一份枚举：逐段插值 + 逐点扫格） */
  function commitPendingStroke() {
    if (!terrainGrid.value || !rawPath.length) return;
    // ① 先把网格扩到覆盖整条笔迹（世界格对齐不变）
    for (const p of rawPath) ensureCoverage(p.x, p.y);
    // ② 回放（起点一次 paint，其余逐段 paintInterpolated —— 与 accumulate* 用的是同一对枚举）
    const type = (pendingOrigin && pendingOrigin.type !== undefined) ? pendingOrigin.type : terrainBrushType.value;
    terrainBrush.terrainType = type;
    paintAt(rawPath[0].x, rawPath[0].y);
    for (let i = 1; i < rawPath.length; i += 1) {
      terrainBrush.paintInterpolated(
        terrainGrid.value, gridWidth.value, gridHeight.value,
        rawPath[i - 1].x - gridOriginX, rawPath[i - 1].y - gridOriginY,
        rawPath[i].x - gridOriginX, rawPath[i].y - gridOriginY, cellWorldSize.value,
      );
    }
    markOutlineDirty(true);
  }

  function endTerrainBrush() {
    if (!isTerrainBrushing.value) return;
    isTerrainBrushing.value = false;
    strokePath.value = [];   // L2 笔迹层：先清数据，再整帧重画把它擦掉
    const before = strokeSnapshot;
    strokeSnapshot = null;
    // ③ 落笔：把预览过的那些格一次性写进网格（此前一格都没动）
    commitPendingStroke();
    clearPending();
    // 抬手落定：轮廓必须与最终格数据完全一致
    markOutlineDirty(true);
    // 高亮 / 轨迹都是瞬态层，只 requestRender 擦不掉（脏矩形只覆盖落点周围）
    if (typeof renderer.markFullRedraw === 'function') renderer.markFullRedraw();
    if (!before) return;
    const after = { grid: Uint8Array.from(terrainGrid.value), geom: snapshotGeometry() };
    const label = before.label;
    // execute 内部立即调 redo()：这里 redo 只是把「当前已是的结果」再写一遍（幂等），
    // 与既有 stroke 写法一致（铁律 §undo：数据修改必须落在 redo 回调里）。
    execute({
      type: 'terrain-paint',
      label,
      undo: () => applySnapshot(before),
      redo: () => applySnapshot(after),
    });
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
      // 同色描边 ≈ 外扩半线宽：既柔化轮廓，也堵住相邻区域圆角内收留下的细缝。
      // 🔴 2026-10-27（用户 B1「莫名其妙的阴影」）：旧值是 `cell*0.9`（真实图 = 13 世界单位），
      //    在 1× 下就是一圈 13px 的彩色光晕 —— 相邻色块互相叠成一团，看起来像阴影。
      //    缝只有亚像素级，所以取「≈1.2 屏幕像素」并把上限压到 0.9 格。
      const viewScale = (renderer.getViewTransform && renderer.getViewTransform().scale) || 1;
      ctx.lineWidth = Math.min(cell * 0.9, Math.max(0.4, 1.2 / Math.max(viewScale, 1e-6)));
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
    strokePath.value = [];
    clearPending();
    clearBrushPreview();
    if (typeof renderer.markFullRedraw === 'function') renderer.markFullRedraw();
  }

  watch([terrainBrushSize, terrainBrushHardness, terrainBrushType], syncBrush);
  watch(() => props.planet?.id, () => {
    terrainGridEnabled.value = false;
    terrainGrid.value = null;
    clearPending();
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
    strokePath,
    brushWorldRadius,
    initTerrainGrid,
    startTerrainBrush,
    moveTerrainBrush,
    endTerrainBrush,
    ensureCoverage,
    /** 网格几何（用例/诊断用；应用内部一律走闭包变量） */
    gridGeometry: () => ({
      cell: cellWorldSize.value, originX: gridOriginX, originY: gridOriginY,
      cols: gridWidth.value, rows: gridHeight.value,
    }),
    drawTerrainGridToCtx,
    /** L3「将涂格」高亮：拖动中叠在画布上的半透明格（第 4 件） */
    drawTerrainPendingToCtx,
    /** 诊断/用例：这一笔当前"将涂"的格（无界格点，相对这一笔的格点原点） */
    pendingCells,
    /** 诊断/用例：按行合并后的矩形段（渲染真正画的东西） */
    pendingRunsOf,
    terrainPendingCells,
    /** 这一笔的原始落点（用例做"预览格集 == 落库格集"的等价性判定用） */
    rawStrokePath: () => rawPath.slice(),
    /** 预览的格点原点（`{x,y,cell}`；与落库用的世界格对齐） */
    pendingOriginRef: () => (pendingOrigin ? { ...pendingOrigin } : null),
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
