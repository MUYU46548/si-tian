// utils/basemapIdentity.js — 底图「一笔未改」判定 + 重导时的旧省→新省映射（纯函数，2026-10-25）
//
// 019 的语义（暮雨 2026-10-25 拍板）：
//   · 换新 .map = **新底图 + 旧归属迁过去**；
//   · 「同一底图只补数据」只限这张底图**一笔未改**；
//   · 只要用户动过一笔，它就和原底图不是一个东西。
//
// 所以需要两件纯函数：
//   ① `basemapFingerprint` / `isBasemapPristine` —— 用内容指纹判断"一笔未改"，
//      不依赖 updatedAt（保存一次就变），也不需要在每个写口插一行 `dirty = true`；
//   ② `mapProvinces` —— 旧省→新省：id 优先，id 对不上按"新省形心落在旧省"兜底；
//      拆省（一旧对多新）与并省（多旧对一新）都显式列出来，交调用方/人处理。
//
// 纯函数：不碰 DOM / store；Node 可直接测。

import { provinceRings } from './provinceShape';
import { pointInPolygon, polygonArea } from './geometry';
import { ringAreaCentroid } from './polityLabels';

const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : 0);

/** 规范 JSON：对象键排序，数组保序（同一份数据不因键顺序变化而不同指纹） */
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') return String(round(v));
  return JSON.stringify(v);
}

function hash32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;   // FNV-1a
  }
  return h >>> 0;
}

function pointOf(p) {
  if (!p) return null;
  const x = Array.isArray(p) ? Number(p[0]) : Number(p.x);
  const y = Array.isArray(p) ? Number(p[1]) : Number(p.y);
  return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
}

function normalizedPoints(points) {
  return (Array.isArray(points) ? points : []).map(pointOf).filter(Boolean);
}

function normalizedTerrain(terrain) {
  return (Array.isArray(terrain) ? terrain : []).map((p) => {
    if (!p) return null;
    const rings = provinceRings(p).map((r) => normalizedPoints(r.points));
    return {
      id: p.id,
      name: p.name || '',
      kind: p.kind || '',
      color: p.color || '',
      rings,
    };
  }).filter(Boolean);
}

function normalizedHeightmap(hm) {
  if (!hm || typeof hm !== 'object') return null;
  const arr = (a) => (a ? Array.from(a).map(round) : null);
  return {
    h: arr(hm.h), temp: arr(hm.temp), prec: arr(hm.prec),
    biome: arr(hm.biome), culture: arr(hm.culture), religion: arr(hm.religion),
    grid: hm.grid ? {
      cellsX: hm.grid.cellsX, cellsY: hm.grid.cellsY, spacing: round(hm.grid.spacing),
      points: normalizedPoints(hm.grid.points),
    } : null,
  };
}

/**
 * 底图内容指纹（**不含** updatedAt / source / _spatialIndex 这类元数据）。
 * 覆盖：省份几何、高度图与派生网格、河流、道路、城镇、参考图、陆地轮廓。
 */
export function basemapFingerprint(bm) {
  if (!bm || typeof bm !== 'object') return 'no-basemap';
  const payload = canonical({
    terrain: normalizedTerrain(bm.terrain),
    heightmap: normalizedHeightmap(bm.heightmap),
    rivers: bm.rivers || null,
    routes: bm.routes || null,
    burgs: bm.burgs || null,
    referenceImages: bm.referenceImages || null,
    landFeatures: bm.landFeatures || null,
  });
  const a = hash32(payload, 0x811c9dc5);
  const b = hash32(payload, 0x7f4a7c15);
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** 导入/刷新时把指纹盖进 `baseMap.source`（新对象；不改入参） */
export function stampBasemapSource(bm, { file = '', at = new Date().toISOString() } = {}) {
  if (!bm || typeof bm !== 'object') return bm;
  const contentHash = basemapFingerprint(bm);
  return {
    ...bm,
    source: {
      ...(bm.source || {}),
      ...(file ? { file } : {}),
      importedAt: at,
      contentHash,
    },
  };
}

/** 「一笔未改」= 当前指纹 == 导入时指纹；没有指纹（旧数据）→ 一律视为改过（保守） */
export function isBasemapPristine(bm) {
  const stored = bm && bm.source && bm.source.contentHash;
  if (!stored) return false;
  return basemapFingerprint(bm) === stored;
}

function mainRing(prov) {
  const r = provinceRings(prov)[0];
  return r ? normalizedPoints(r.points) : [];
}

function centroidOf(prov) {
  const pts = mainRing(prov);
  if (pts.length < 3) return null;
  const { cx, cy, area } = ringAreaCentroid(pts);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  return { x: cx, y: cy, area: Number.isFinite(area) ? area : polygonArea(pts) };
}

/** 点是否落在省（主环）内；点在边界上算命中（顶点测试用 >0 面积） */
function contains(prov, pt) {
  const pts = mainRing(prov);
  if (pts.length < 3 || !pt) return false;
  return pointInPolygon(pt.x, pt.y, pts);
}

/**
 * 旧省 → 新省映射。
 *
 * 优先级：**id 完全相同** → 新省形心落在旧省 → 旧省形心落在新省。
 * 返回 `byOld[oldId] = [newId,...]`（拆省 = 一对多）与 `byNew[newId] = [oldId,...]`
 * （并省 = 多对一，进 `conflicts` 交人确认）。
 *
 * @param {Array} oldTerrain 旧底图 terrain
 * @param {Array} newTerrain 新 .map 的 terrain
 * @returns {{byOld:Object, byNew:Object, exact:string[], conflicts:Array, unmappedOld:string[], unmappedNew:string[]}}
 */
export function mapProvinces(oldTerrain, newTerrain) {
  const olds = (Array.isArray(oldTerrain) ? oldTerrain : []).filter(Boolean);
  const news = (Array.isArray(newTerrain) ? newTerrain : []).filter(Boolean);
  const byOld = {};   // oldId -> Set(newId)
  const byNew = {};   // newId -> Set(oldId)
  const add = (oldId, newId) => {
    if (!oldId || !newId) return;
    (byOld[oldId] || (byOld[oldId] = new Set())).add(newId);
    (byNew[newId] || (byNew[newId] = new Set())).add(oldId);
  };
  const oldById = new Map(olds.map((p) => [p.id, p]));
  const newById = new Map(news.map((p) => [p.id, p]));
  const exact = [];

  // ① id 完全相同
  for (const [id, np] of newById) {
    const op = oldById.get(id);
    if (op) {
      add(id, id);
      exact.push(id);
    }
  }

  // ② 新省形心落在旧省（拆省：一旧对多新）
  for (const np of news) {
    if (byNew[np.id]) continue;
    const c = centroidOf(np);
    if (!c) continue;
    const hit = olds.find((op) => contains(op, c));
    if (hit) add(hit.id, np.id);
  }

  // ③ 旧省形心落在新省（并省 / 新省形心不落在旧省的情况）
  for (const op of olds) {
    if (byOld[op.id] && byOld[op.id].size) continue;
    const c = centroidOf(op);
    if (!c) continue;
    const hit = news.find((np) => contains(np, c));
    if (hit) add(op.id, hit.id);
  }

  const conflicts = [];
  for (const [newId, set] of Object.entries(byNew)) {
    if (set.size > 1) conflicts.push({ newId, oldIds: [...set] });
  }
  const unmappedOld = olds.filter((p) => !byOld[p.id] || !byOld[p.id].size).map((p) => p.id);
  const unmappedNew = news.filter((p) => !byNew[p.id] || !byNew[p.id].size).map((p) => p.id);

  return {
    byOld: Object.fromEntries(Object.entries(byOld).map(([k, v]) => [k, [...v]])),
    byNew: Object.fromEntries(Object.entries(byNew).map(([k, v]) => [k, [...v]])),
    exact,
    conflicts,
    unmappedOld,
    unmappedNew,
  };
}

/**
 * 把「属于旧底图」的剧本迁到新底图 key，并按 `mapping.byOld` 重映射归属/易主。
 *
 * 语义（见 REIMPORT_019_20261025.md）：
 *   · 只动 `ownerKey === oldKey` 的剧本；其它底图的剧本原样返回（同引用）。
 *   · `scenario.id` **保持**（外部引用不断）；`ownerKey` 改新。
 *   · 拆省（一旧对多新）→ 归属复制到每个新省；事件逐条复制。
 *   · 未映射的旧省 → 该省归属丢弃，并在 `droppedOldProvinces` 里列出来（不静默）。
 *   · 并省冲突由调用方先检查 `mapping.conflicts`（本函数不替用户选）。
 *
 * @returns {{scenarios:Object, moved:string[], droppedOldProvinces:string[]}}
 */
export function remapScenariosForReimport(scenarios, oldKey, newKey, mapping) {
  const src = (scenarios && typeof scenarios === 'object') ? scenarios : {};
  const byOld = (mapping && mapping.byOld) || {};
  const out = {};
  const moved = [];
  const dropped = new Set();

  const targetsOf = (pid) => (Array.isArray(byOld[pid]) ? byOld[pid] : []);

  for (const [id, s] of Object.entries(src)) {
    if (!s || typeof s !== 'object' || s.ownerKey !== oldKey) {
      out[id] = s;
      continue;
    }
    const next = { ...s, ownerKey: newKey };

    if (s.ownership && typeof s.ownership === 'object') {
      const own = {};
      for (const [pid, owner] of Object.entries(s.ownership)) {
        const targets = targetsOf(pid);
        if (!targets.length) { dropped.add(pid); continue; }
        for (const np of targets) own[np] = owner;
      }
      next.ownership = own;
    }

    if (s.initialOwnership && typeof s.initialOwnership === 'object') {
      const init = {};
      for (const [pid, owner] of Object.entries(s.initialOwnership)) {
        const targets = targetsOf(pid);
        if (!targets.length) { dropped.add(pid); continue; }
        for (const np of targets) init[np] = owner;
      }
      next.initialOwnership = init;
    }

    if (s.changeEvents && typeof s.changeEvents === 'object') {
      const ev = {};
      for (const [pid, list] of Object.entries(s.changeEvents)) {
        const targets = targetsOf(pid);
        if (!targets.length) { dropped.add(pid); continue; }
        if (!Array.isArray(list)) continue;
        for (const np of targets) {
          ev[np] = (ev[np] || []).concat(list.map((e) => ({ ...e })));
        }
      }
      next.changeEvents = ev;
    }

    out[id] = next;
    moved.push(id);
  }

  return { scenarios: out, moved, droppedOldProvinces: [...dropped] };
}
