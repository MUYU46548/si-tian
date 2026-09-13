/**
 * usePlanetHeightBrush.js — PlanetMap 高度图笔刷 composable
 *
 * 提供高度笔刷（抬高/降低/平滑）、生物群系笔刷。
 * 接线模式遵循 PlanetMap 既有 composable 工厂模式。
 *
 * 数据模型（与 ScenarioMap / heightMath 一致）：
 *   mapData[planetId].heightmap = {
 *     h: Float32Array, temp: Float32Array, prec: Float32Array, biome: Uint8Array,
 *     grid: { points: [[x,y], ...], spacing, cellsX, cellsY, count }
 *   }
 *
 * 两条硬约束（2026-09-13 踩坑）：
 * 1. 写入必须走「stroke 快照」：按下时快照 + 换新数组，拖动期间就地改，
 *    抬起时压一条 undo。逐帧 execute 会把一次拖动拆成几百条撤销记录。
 * 2. 持久化的是普通数组（TypedArray 过 JSON 会退化成无 length 的对象），
 *    因此 load 后必须校验并重建，否则高度图会静默变成空数组。
 */

import { ref, toRaw } from 'vue';
import { execute } from '../store/undo';
import {
  SEA_LEVEL, BIOME_KEYS,
  temperatureAtIndex, precipitationAtIndex, biomeIndex, brushFalloff,
} from '../utils/heightMath';

const DEFAULT_SPACING = 14.4;
const ELEV_MAP = { '深海': 5, '浅海': 15, '平原': 30, '丘陵': 50, '高原': 70, '山地': 85, '高山': 95 };
const round3 = (v) => Math.round(v * 1000) / 1000;

// 取「原始对象」（双层 unwrap）：
// - 只 toRaw 一次，遇到「容器的原始对象里存着代理值」的场景（{...reactiveObj} 保存过）
//   拿到的仍是代理 → 重循环里逐点 proxy get，2 万点级别直接卡死十几秒
// - toRaw 幂等，双调用对已是原始对象的值无副作用
const unwrap = (v) => (v && typeof v === 'object') ? toRaw(toRaw(v)) : v;

export function usePlanetHeightBrush({ store, renderer, currentMapData }) {
  const brushRadius = ref(80);
  const brushStrength = ref(3);
  const brushBiome = ref('grassland');
  const isBrushing = ref(false);
  const brushPreview = ref(null); // { x, y, radius }
  const brushMode = ref('raise'); // 'raise' | 'lower' | 'smooth' | 'biome'

  const BIOME_KEY_INDEX = {};
  BIOME_KEYS.forEach((k, i) => { BIOME_KEY_INDEX[k] = i; });

  // stroke 状态
  let strokeBefore = null; // { h, temp, prec, biome } 本 stroke 之前的数据副本
  let strokeLabel = '高度笔刷';
  let strokeDirty = false;
  let indexCache = null; // 空间索引缓存（只依赖 grid.points，与高度值无关）

  function planetId() { return currentMapData.value?.planetId; }
  function liveHeightmap() {
    const id = planetId();
    return id ? (store.mapData?.[id]?.heightmap || null) : null;
  }
  // 重循环必须读原始对象：网格点数动辄 2 万+，逐点读 Vue 响应式代理
  // （每点数次 proxy get）会让建立高度图从毫秒级变成几十秒（实测卡死 CDP 15s）。
  // 注意两级 toRaw：store.mapData 的容器里可能存着「代理」值（{...proxy} 保存过），
  // 只对容器做 toRaw 拿到的仍是代理 → 优化静默失效。
  function rawEntry() {
    const id = planetId();
    if (!id) return null;
    const map = unwrap(store.mapData);
    const entry = map && map[id];
    return entry ? unwrap(entry) : null;
  }

  // 判断高度图各层是否是「长度正确的数值序列」
  function arraysValid(hm, count) {
    const ok = (a) => a && typeof a.length === 'number' && a.length === count;
    return ok(hm.h) && ok(hm.temp) && ok(hm.prec) && ok(hm.biome);
  }

  /**
   * 取当前行星的高度图；缺失或被历史版本写坏时重建。
   * 历史坑：TypedArray 经 JSON 往返后退化为 {0:..}（无 length），
   * 直接 new Float32Array(obj) 得到空数组 → 笔刷涂不出任何东西。
   */
  function ensureHeightmap() {
    const id = planetId();
    if (!id || !store.mapData?.[id]) return null;
    const md = store.mapData[id];
    const hm = md.heightmap;
    const grid = hm?.grid;
    const gridOk = !!grid && Array.isArray(grid.points) && grid.points.length > 0
      && Number.isInteger(grid.cellsX) && Number.isInteger(grid.cellsY)
      && grid.cellsX * grid.cellsY === grid.points.length;

    if (!gridOk) {
      const rebuilt = buildFromTerrain(rawEntry()?.terrain || []);
      md.heightmap = rebuilt;
      indexCache = null;
      return rebuilt;
    }

    const count = grid.points.length;
    if (!arraysValid(hm, count)) {
      // 高度数据可用但派生层缺失/损坏 → 只重算派生层（保留已涂的高度）
      if (hm.h && hm.h.length === count) {
        const h = hm.h instanceof Float32Array ? hm.h : new Float32Array(hm.h);
        hm.h = h;
        hm.temp = new Float32Array(count);
        hm.prec = new Float32Array(count);
        hm.biome = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
          const t = temperatureAtIndex(h[i], 0);
          const p = precipitationAtIndex(t, 100);
          hm.temp[i] = t;
          hm.prec[i] = p;
          hm.biome[i] = h[i] < SEA_LEVEL ? 0 : biomeIndex(h[i], t, p);
        }
      } else {
        const rebuilt = buildFromTerrain(rawEntry()?.terrain || [], toRaw(grid));
        md.heightmap = rebuilt;
        indexCache = null;
        return rebuilt;
      }
    } else if (!(hm.h instanceof Float32Array)) {
      // JSON 读回的是普通数组 → 统一成 TypedArray（内存约定）
      hm.h = new Float32Array(hm.h);
      hm.temp = new Float32Array(hm.temp);
      hm.prec = new Float32Array(hm.prec);
      hm.biome = new Uint8Array(hm.biome);
    }
    return hm;
  }

  // 新建网格；传入 existingGrid 时保留原网格坐标（只重建数据）
  function buildFromTerrain(terrain, existingGrid = null) {
    let pts, spacing, cellsX, cellsY;
    if (existingGrid) {
      pts = unwrap(existingGrid.points) || existingGrid.points;
      spacing = existingGrid.spacing || DEFAULT_SPACING;
      cellsX = existingGrid.cellsX;
      cellsY = existingGrid.cellsY;
    } else {
      spacing = DEFAULT_SPACING;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const poly of terrain) {
        for (const p of poly?.points || []) {
          const px = p.x ?? p[0] ?? 0;
          const py = p.y ?? p[1] ?? 0;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
      }
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }
      const pad = spacing * 2;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      cellsX = Math.ceil((maxX - minX) / spacing) + 1;
      cellsY = Math.ceil((maxY - minY) / spacing) + 1;
      pts = new Array(cellsX * cellsY);
      for (let j = 0; j < cellsY; j++) {
        for (let i = 0; i < cellsX; i++) {
          pts[j * cellsX + i] = [round3(minX + i * spacing), round3(minY + j * spacing)];
        }
      }
    }

    const count = pts.length;
    const h = new Float32Array(count);
    h.fill(20);
    for (let i = 0; i < count; i++) {
      const p = pts[i];
      const px = Array.isArray(p) ? p[0] : p.x;
      const py = Array.isArray(p) ? p[1] : p.y;
      for (const poly of terrain) {
        if (!poly?.points || poly.points.length < 3) continue;
        if (isPointInPolygon(px, py, poly.points)) {
          h[i] = ELEV_MAP[poly.elevation] ?? 30;
          break;
        }
      }
    }
    const temp = new Float32Array(count);
    const prec = new Float32Array(count);
    const biome = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const t = temperatureAtIndex(h[i], 0);
      const p = precipitationAtIndex(t, 100);
      temp[i] = t;
      prec[i] = p;
      biome[i] = h[i] < SEA_LEVEL ? 0 : biomeIndex(h[i], t, p);
    }
    return { h, temp, prec, biome, grid: { points: pts, spacing, cellsX, cellsY, count } };
  }

  function isPointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x ?? points[i][0];
      const yi = points[i].y ?? points[i][1];
      const xj = points[j].x ?? points[j][0];
      const yj = points[j].y ?? points[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // 空间索引：只依赖 grid.points（笔刷逐帧调用，不能每次重建）
  function getIndex(hm) {
    const grid = unwrap(unwrap(hm)?.grid);
    if (!grid) return null;
    const pts = unwrap(grid.points) || grid.points; // 原始数组：热循环里避免 proxy 开销
    const spacing = grid.spacing || DEFAULT_SPACING;
    const cellSize = spacing * 2;
    if (indexCache && indexCache.pts === pts && indexCache.cellSize === cellSize) return indexCache;
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
    }
    const cellMap = new Map();
    for (let i = 0; i < pts.length; i++) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const key = `${Math.floor((px - minX) / cellSize)},${Math.floor((py - minY) / cellSize)}`;
      const bucket = cellMap.get(key);
      if (bucket) bucket.push(i); else cellMap.set(key, [i]);
    }
    indexCache = { pts, spacing, cellSize, minX, minY, cellMap };
    return indexCache;
  }

  // 收集笔刷半径内的索引（世界坐标 → 网格桶）
  function collectInRadius(idx, worldX, worldY, radius) {
    const { cellSize, minX, minY, cellMap } = idx;
    const c0 = Math.floor((worldX - radius - minX) / cellSize);
    const c1 = Math.floor((worldX + radius - minX) / cellSize);
    const r0 = Math.floor((worldY - radius - minY) / cellSize);
    const r1 = Math.floor((worldY + radius - minY) / cellSize);
    const out = [];
    for (let ci = c0; ci <= c1; ci++) {
      for (let cj = r0; cj <= r1; cj++) {
        const bucket = cellMap.get(`${ci},${cj}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  // ===== stroke 生命周期（一次拖动 = 一条 undo 记录） =====
  function beginHeightStroke() {
    const hm = ensureHeightmap();
    strokeBefore = null;
    strokeDirty = false;
    strokeLabel = brushMode.value === 'biome' ? '涂抹生物群系'
      : brushMode.value === 'lower' ? '降低地形'
        : brushMode.value === 'smooth' ? '平滑地形' : '抬高地形';
    if (!hm) return false;
    strokeBefore = {
      h: new Float32Array(hm.h),
      temp: new Float32Array(hm.temp),
      prec: new Float32Array(hm.prec),
      biome: new Uint8Array(hm.biome),
    };
    // 换新数组：本 stroke 就地改的都是新数组，历史栈里的引用不会被后续涂抹篡改
    hm.h = new Float32Array(hm.h);
    hm.temp = new Float32Array(hm.temp);
    hm.prec = new Float32Array(hm.prec);
    hm.biome = new Uint8Array(hm.biome);
    return true;
  }

  function endHeightStroke() {
    const before = strokeBefore;
    const dirty = strokeDirty;
    strokeBefore = null;
    strokeDirty = false;
    const id = planetId();
    if (!before || !dirty || !id) return;
    const after = {
      h: new Float32Array(liveHeightmap()?.h || before.h),
      temp: new Float32Array(liveHeightmap()?.temp || before.temp),
      prec: new Float32Array(liveHeightmap()?.prec || before.prec),
      biome: new Uint8Array(liveHeightmap()?.biome || before.biome),
    };
    const label = strokeLabel;
    const apply = (snap) => {
      const hm = liveHeightmap();
      if (!hm) return;
      // 整体替换引用：TypedArray 元素级写入不触发响应式，替换字段才可靠
      hm.h = snap.h;
      hm.temp = snap.temp;
      hm.prec = snap.prec;
      hm.biome = snap.biome;
    };
    execute({
      type: 'height-brush',
      label,
      undo: () => { apply(before); renderer?.requestRender(); },
      redo: () => { apply(after); renderer?.requestRender(); },
    });
    store.scheduleAutoSaveMap(id);
  }

  function strokeAborted() { strokeBefore = null; strokeDirty = false; }

  // ===== 高度笔刷 =====
  function paintHeight(hm, worldX, worldY) {
    const radius = brushRadius.value;
    const strength = brushStrength.value;
    const mode = brushMode.value;
    if (mode === 'biome') return 0;
    const idx = getIndex(hm);
    if (!idx) return 0;
    const pts = idx.pts;
    const candidates = collectInRadius(idx, worldX, worldY, radius);
    const srcH = mode === 'smooth' ? new Float32Array(hm.h) : hm.h;
    const pending = [];
    for (const i of candidates) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.hypot(px - worldX, py - worldY);
      if (dist >= radius) continue;
      const falloff = brushFalloff(radius, dist);
      if (mode === 'raise' || mode === 'lower') {
        const cur = hm.h[i];
        const delta = strength * falloff;
        const v = round3(mode === 'raise' ? Math.min(100, cur + delta) : Math.max(0, cur - delta));
        if (v !== cur) pending.push([i, v]);
      } else if (mode === 'smooth') {
        // 邻域均值（读本帧稳定快照，避免"边算边改"产生方向性拖影）
        let sum = 0, count = 0;
        for (const j of collectInRadius(idx, px, py, idx.spacing * 1.5)) {
          const qx = Array.isArray(pts[j]) ? pts[j][0] : pts[j].x;
          const qy = Array.isArray(pts[j]) ? pts[j][1] : pts[j].y;
          if (Math.abs(qx - px) < idx.spacing * 1.5 && Math.abs(qy - py) < idx.spacing * 1.5) {
            sum += srcH[j]; count++;
          }
        }
        const v = round3(count > 0 ? sum / count : srcH[i]);
        if (v !== hm.h[i]) pending.push([i, v]);
      }
    }
    if (!pending.length) return 0;
    for (const [i, v] of pending) {
      hm.h[i] = v;
      const t = temperatureAtIndex(v, 0);
      const p = precipitationAtIndex(t, 100);
      hm.temp[i] = round3(t);
      hm.prec[i] = round3(p);
      hm.biome[i] = v < SEA_LEVEL ? 0 : biomeIndex(v, t, p);
    }
    return pending.length;
  }

  function applyHeightBrush(_planetId, worldX, worldY) {
    const hm = ensureHeightmap();
    if (!hm) return false;
    const touched = paintHeight(hm, worldX, worldY);
    if (!touched) return false;
    strokeDirty = true;
    renderer?.requestRender();
    return true;
  }

  // ===== 生物群系笔刷 =====
  function applyBiomeBrush(_planetId, worldX, worldY) {
    const hm = ensureHeightmap();
    if (!hm) return false;
    const idx = getIndex(hm);
    if (!idx) return false;
    const pts = idx.pts;
    const radius = brushRadius.value;
    const target = BIOME_KEY_INDEX[brushBiome.value] ?? 0;
    let touched = 0;
    for (const i of collectInRadius(idx, worldX, worldY, radius)) {
      const px = Array.isArray(pts[i]) ? pts[i][0] : pts[i].x;
      const py = Array.isArray(pts[i]) ? pts[i][1] : pts[i].y;
      const dist = Math.hypot(px - worldX, py - worldY);
      if (dist >= radius) continue;
      if (brushFalloff(radius, dist) < 0.1) continue;
      if (hm.biome[i] !== target) { hm.biome[i] = target; touched++; }
    }
    if (!touched) return false;
    strokeDirty = true;
    renderer?.requestRender();
    return true;
  }

  function updateBrushPreview(wx, wy) {
    brushPreview.value = { x: wx, y: wy, radius: brushRadius.value };
  }

  function clearBrushPreview() { brushPreview.value = null; }

  return {
    brushRadius,
    brushStrength,
    brushBiome,
    isBrushing,
    brushPreview,
    brushMode,
    BIOME_KEY_INDEX,
    ensureHeightmap,
    beginHeightStroke,
    endHeightStroke,
    strokeAborted,
    applyHeightBrush,
    applyBiomeBrush,
    updateBrushPreview,
    clearBrushPreview,
  };
}
