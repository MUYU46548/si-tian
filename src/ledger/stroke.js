// src/ledger/stroke.js — 笔画对象模型（第 3 件，2026-10-24）
//
// 为什么要有它（digest §一-C 三处改法的落码位）：
//   M1 要"落事件不落状态"——一笔的**结果**（一片省的归属、一圈边界、一堆图标）不该是唯一存档，
//   否则下次想改笔刷参数/重新简化/换生成器，旧笔都变成不可重算的死数据。
//   所以一笔落成 {strokeId, kind, generator, params, rawPoints, geometry}：
//     · **rawPoints 是手指路径**（回放/重调参的依据，永不丢）；
//     · geometry 只是**生成物**（渲染/导出直接用，省一次重算；但它必须能被重算出来）；
//     · params 里放全所有输入（含 `seed` —— 散布笔不记 seed 就不可复现）。
//
// 三个"名字必须拆开"的 kind（共用对象模型，但生成器与验收标准不同）：
//   · outline 轮廓勾画：矢量路径（RDP 简化 + 可选骨架吸附）→ 一条闭/开路径；
//   · terrain 地形笔刷：笔画**填充**（涂哪些格、涂成什么）；
//   · scatter 散布笔刷：沿路径的**实例分布**（图标/标记，带 seed 的不重叠散布）。
//
// 🔴 生成器**不在本层实现**：`replayStroke(stroke, generate)` 由调用方传进来（渲染层那几份
//    `simplifyPath` / `scatterAlongPath` / 网格填充）。这样"同一能力只有一份实现"照样成立，
//    本层只管**对象形状 + 可复现性判定**（digest 判据：原始点→简化→回放逐点一致）。
//
// 🔴 纯数据层：不 import vue / store / 组件（`test_ledger_core.js` a6 段读源码守）。

import { makeEvent } from './schema';

/** 笔画种类（**命名必须拆开**：三者共用对象模型，但生成器/验收各不相同） */
export const STROKE_KINDS = {
  outline: '轮廓勾画',
  terrain: '地形笔刷',
  scatter: '散布笔刷',
};

export const STROKE_KIND_LIST = Object.keys(STROKE_KINDS);

const STROKE_KIND_SET = new Set(STROKE_KIND_LIST);

/** 取整（几何校验和用；3 位小数足够区分"重算出来是不是同一份"） */
function r3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/**
 * 几何指纹：对点列/嵌套结构做**顺序敏感**的稳定校验和。
 * 用于判"重算出来的 geometry 与落盘的那份是不是同一份"（不比较浮点逐位相等 —— 生成器可能
 * 有极小的浮点漂移，3 位小数是司天全仓的体积/精度口径，见 `jsonSafeReplacer`）。
 */
export function digestGeometry(geometry) {
  let h = 2166136261 >>> 0;
  const mix = (n) => { h ^= (n >>> 0); h = Math.imul(h, 16777619) >>> 0; };
  const walk = (v) => {
    if (v === null || v === undefined) { mix(0); return; }
    if (typeof v === 'number') { mix(Math.round(r3(v) * 1000) >>> 0); return; }
    if (typeof v === 'boolean') { mix(v ? 1 : 2); return; }
    if (typeof v === 'string') {
      for (let i = 0; i < v.length; i += 1) mix(v.charCodeAt(i));
      mix(0xffff);
      return;
    }
    if (Array.isArray(v)) { mix(v.length + 7); for (const it of v) walk(it); return; }
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      mix(keys.length + 13);
      for (const k of keys) { walk(k); walk(v[k]); }
      return;
    }
    mix(1);
  };
  walk(geometry);
  return h >>> 0;
}

/**
 * 笔画的**几何指纹**：按 kind 取"真正决定观感"的字段，剔掉运行时标识。
 *
 * 为什么不能对整份 geometry 直接 digest：散布笔的每个实例带 `id`（`nextReliefId()` 生成，
 * 每次调用都不同）—— 那是运行时标识，不是几何。若不剔除，"同一笔回放两次指纹不同"，
 * 模型会永远判不可复现（假红）。所以这里按 kind 定义投影：
 *   · scatter：`[{type,x,y,size,rotation}]`（顺序即落点先后，顺序敏感）
 *   · outline / terrain：几何本身就是点列/格列，原样 digest
 */
export function strokeGeometryView(kind, geometry) {
  if (kind !== 'scatter') return geometry;
  if (!Array.isArray(geometry)) return geometry;
  return geometry.map((it) => (it && typeof it === 'object'
    ? { type: it.type, x: r3(it.x), y: r3(it.y), size: r3(it.size), rotation: r3(it.rotation) }
    : it));
}

/** 一笔的几何指纹（= `digestGeometry(strokeGeometryView(kind, geometry))`，别在别处另算一套） */
export function digestStroke(stroke) {
  return digestGeometry(strokeGeometryView(stroke && stroke.kind, stroke && stroke.geometry));
}

/** 点列是否合法（有限数；允许数组形式 `[x,y]` 与对象形式 `{x,y}` —— 两者在仓里都出现过） */
export function isValidPoint(p) {
  if (Array.isArray(p)) return p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  return !!p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 造一笔（**唯一构造入口**；不做业务校验，校验见 `validateStroke`） */
export function makeStroke(draft = {}, opts = {}) {
  const raw = Array.isArray(draft.rawPoints) ? draft.rawPoints : [];
  const stroke = {
    strokeId: String(draft.strokeId || opts.strokeId || `st-${opts.index || 1}`),
    kind: String(draft.kind || ''),
    generator: String(draft.generator || ''),
    params: draft.params && typeof draft.params === 'object' ? { ...draft.params } : {},
    // 原始点**原样保留**（不在这里去重/抽稀：那属于生成器，且原始点是后悔药）
    rawPoints: raw.map((p) => (Array.isArray(p) ? [p[0], p[1]] : { x: p && p.x, y: p && p.y })),
    geometry: draft.geometry === undefined ? null : draft.geometry,
    epochId: String(draft.epochId || opts.epochId || ''),
    day: Number.isFinite(draft.day) ? Math.trunc(draft.day) : (Number.isFinite(opts.day) ? Math.trunc(opts.day) : 0),
    provenance: String(draft.provenance || opts.provenance || 'brush'),
    createdAt: String(draft.createdAt || opts.createdAt || ''),
  };
  stroke.geometryDigest = draft.geometryDigest !== undefined ? draft.geometryDigest : digestStroke(stroke);
  return stroke;
}

/**
 * 校验一笔。返回 `{ok, errors[]}`（不抛错：装载路径要把坏笔画挑出来，而不是整本账读不出）。
 * 判据只查"能不能重算"：kind 登记过、有 generator、rawPoints 合法且 ≥2、params 是对象、
 * scatter 必须带 seed（没 seed 的散布不可复现 —— 这一条单独列出来，因为它是静默的）。
 */
export function validateStroke(stroke) {
  const errors = [];
  if (!stroke || typeof stroke !== 'object') return { ok: false, errors: ['笔画不是对象'] };
  if (!stroke.strokeId) errors.push('缺 strokeId');
  if (!STROKE_KIND_SET.has(stroke.kind)) errors.push(`未登记的笔画种类：${stroke.kind || '(空)'}`);
  if (!stroke.generator) errors.push('缺 generator（没有生成器就无法重算）');
  if (!stroke.params || typeof stroke.params !== 'object') errors.push('params 不是对象');
  const raw = Array.isArray(stroke.rawPoints) ? stroke.rawPoints : null;
  if (!raw) errors.push('rawPoints 不是数组');
  else {
    if (raw.length < 2) errors.push(`rawPoints 太少（${raw.length} < 2）`);
    const badIdx = raw.findIndex((p) => !isValidPoint(p));
    if (badIdx >= 0) errors.push(`rawPoints[${badIdx}] 不是合法点`);
  }
  if (stroke.geometry === undefined) errors.push('缺 geometry（哪怕是空数组也要显式给）');
  if (stroke.kind === 'scatter' && !Number.isFinite(Number(stroke.params && stroke.params.seed))) {
    errors.push('散布笔没记 seed（不可复现）');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 回放一笔：用**调用方给的生成器**从 rawPoints + params 重算 geometry，并与落盘的指纹比对。
 *
 * @param {object} stroke
 * @param {(rawPoints:Array, params:object, stroke:object)=>any} generate 真实生成器（渲染层那一份）
 * @returns {{ok:boolean, matches:boolean, digest:number, geometry:any, error?:string}}
 */
export function replayStroke(stroke, generate) {
  const v = validateStroke(stroke);
  if (!v.ok) return { ok: false, matches: false, digest: 0, geometry: null, error: v.errors.join('；') };
  if (typeof generate !== 'function') return { ok: false, matches: false, digest: 0, geometry: null, error: '没有生成器' };
  let geometry = null;
  try {
    geometry = generate(stroke.rawPoints, stroke.params, stroke);
  } catch (e) {
    return { ok: false, matches: false, digest: 0, geometry: null, error: String((e && e.message) || e) };
  }
  const digest = digestGeometry(strokeGeometryView(stroke.kind, geometry));
  const stored = Number.isFinite(stroke.geometryDigest) ? stroke.geometryDigest : digestStroke(stroke);
  return { ok: true, matches: digest === stored, digest, geometry };
}

/** 落事件用的载荷：**只带这笔本身**（不带任何运行时对象），保证 JSON 往返 */
export function strokePayload(stroke) {
  return {
    stroke: {
      strokeId: stroke.strokeId,
      kind: stroke.kind,
      generator: stroke.generator,
      params: { ...stroke.params },
      rawPoints: stroke.rawPoints.map((p) => (Array.isArray(p) ? [p[0], p[1]] : { x: p.x, y: p.y })),
      geometry: stroke.geometry,
      geometryDigest: stroke.geometryDigest,
      epochId: stroke.epochId,
      day: stroke.day,
      provenance: stroke.provenance,
      createdAt: stroke.createdAt,
    },
  };
}

/** 造一条「笔画落库」事件（type = stroke.committed；groupId 建议 = strokeId，一笔一组便于撤销） */
export function strokeEvent(stroke, opts = {}) {
  return makeEvent({
    worldId: opts.worldId || 'default',
    epochId: opts.epochId || stroke.epochId || '',
    day: Number.isFinite(opts.day) ? opts.day : stroke.day,
    type: 'stroke.committed',
    groupId: opts.groupId !== undefined ? opts.groupId : stroke.strokeId,
    provenance: opts.provenance || stroke.provenance || 'brush',
    payload: strokePayload(stroke),
  }, { calendar: opts.calendar, existingIds: opts.existingIds || [] });
}
