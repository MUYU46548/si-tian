// utils/projectSchema.js — `.sitian` 项目文件的结构定义 / 校验修复 / 版本迁移 / 就地快照
//
// ⚠️ 纯函数模块：无 DOM、无 IPC、无 Pinia 依赖（Node 侧也能读；测试用例直接 dynamic import）。
//
// Phase 1（独立运行基础）的**单一真值来源**：
//   主进程 `src/main/handlers/projectHandler.js` 只负责文件读写，不解释内容；
//   渲染进程 `src/renderer/src/store/projectStore.js` 只调用本模块。
//   改项目文件结构 → 只改这里（+ 升 PROJECT_VERSION + 补 MIGRATIONS）。
//
// `.sitian` 文件结构（version 1.0.0）：
//   {
//     version: '1.0.0',
//     meta:      { id, name, created, updated },          // 项目元信息
//     entities:  { [entityId]: Entity },                  // 实体树（与 GeoNode 同形，见下）
//     hyperlanes:[ { id, fromId, toId, type } ],          // 星系间航道
//     scenarios: { version: 2, baseMaps, scenarios },     // 历史剧本（复用既有结构，勿改）
//     maps:      { [planetId]: { …mapData } },            // 每行星地图数据（Phase 2 从 .sitian/mapdata.json 迁入）
//     snapshots: [ { at, label, base?, patch, changes } ] // 自动备份环形缓冲（最近 50 份）
//   }
//
// Entity 与 `GeoNode`（AGENTS.md）同形，额外两个字段：
//   origin: 'project' | 'obsidian'   —— 该实体是司天内创建的，还是从 Obsidian 词条导入的
//   sourcePath: string               —— origin='obsidian' 时的库内相对路径（导出来源，只读回溯用）
//
// 🔴 实体上还有一批**本模块不登记、但必须原样往返**的字段（此前头注释只登记了上面的标准字段，
//    与实体真实形态不符 —— 注释欠账，2026-09-20 补齐）：
//   · 提取器写入：`wikilinks`（本仓真实数据 120/121 带）、`placeType`（117/121 带）、`draft`（1/121）
//   · 七层编辑器写入：`population` / `cultureId` / `sizeScale` / `locked` / `description` …
//   这些是**画布侧的编辑数据**，不属于项目结构契约，但丢了**一个字都不会报错、能力静默退化**：
//   丢 placeType → 聚落/地点图标与配色退化；丢 wikilinks → 搜索「提及」整块消失；
//   丢 population → 聚落图标不按人口分级。
//   契约边界（改动前先读这两条）：
//     · 本模块天然透传 —— `validateProject` 用 `{ ...value, … }` 展开，未知字段一律原样保留。
//       **禁止**把它改成白名单挑拣，否则一打开项目就静默丢数据。
//     · 唯一的"已知字段"判定点在 `store/geodata.js`：`ENTITY_SHAPE_KEYS` 白名单 + `entityExtras()`。
//       新增此类字段**不需要动本模块**，只需确认它没被加进 `ENTITY_SHAPE_KEYS`。
//     · 例外：`draft` 由 `sourcePath` 派生，不随实体往返（见 `entityToNode`）。
//
// 为什么快照用「就地 diff 环形缓冲」而不是整份 JSON 拷贝：
//   地图数据是 MB 级（实测 mapdata.json ~2MB）。50 份整拷贝 = 100MB 级别，不可接受。
//   所以 snapshots 只存 SNAPSHOT_DIFF_KEYS（entities/scenarios/hyperlanes/meta，KB 级）的差异：
//     第 0 份存完整 base（= 快照时刻的状态），第 i 份存 patch_i = diff(state_{i-1}, state_i)。
//     恢复第 i 份 = base 依次应用 patch_1..patch_i。
//     缓冲溢出丢最旧的 1 份时，把它的 patch 折进新 base（state_1 = apply(base_0, p_1)），
//     所以缓冲恒定是「1 份 base + ≤keep 份 diff」。
//   重量级 `maps` **不进快照** —— 它另有兜底：projectHandler 每次落盘的整文件备份（保留 10 份）。
//   需要把 maps 也纳入快照时，调用方显式传 keys（并自行承担体积）。

import { normalizeId } from './normalizeId';

export const PROJECT_VERSION = '1.0.0';
export const PROJECT_EXT = '.sitian';
export const SNAPSHOT_KEEP = 50;

// 快照覆盖的顶层键（不含 maps：MB 级，另有磁盘整文件备份兜底）
export const SNAPSHOT_DIFF_KEYS = ['meta', 'entities', 'hyperlanes', 'scenarios'];

// 实体层级 → 中文标签。与 `store/geodata.js` 的 layerLabels（约 209 行）保持一致：
// 两处都是「层级 → 显示名」的只读映射，新增层级时两处都要加（有测试用例守）。
export const LAYER_LABELS = {
  world: '世界', star_domain: '星域', galaxy: '星系', star: '恒星',
  planet: '行星', moon: '卫星', region: '区域', city: '城市',
  town: '城镇', village: '村庄', building: '建筑', facility: '设施',
  location: '地点', unknown: '未知',
};

// 层级深度顺序（父子合法性校验 / 树排序用）。
// 与 `store/geodata.js` 的 LAYER_ORDER、`scripts/extract-data.js` 的 LAYER_ORDER 语义一致。
export const LAYER_ORDER = [
  'world', 'star_domain', 'galaxy', 'star', 'planet', 'moon',
  'region', 'city', 'town', 'village', 'building', 'facility', 'location', 'unknown',
];

// 版本号比较：a > b → 1，a === b → 0，a < b → -1（只按数字段，忽略非数字尾缀）
export function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 版本迁移表：目标版本 → (project) => project。当前是首个版本，表为空（保留结构，勿删）。
// 将来加版本时的写法：
//   '1.1.0': (p) => ({ ...p, version: '1.1.0', newField: {} }),
const MIGRATIONS = {};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 深拷贝（项目数据只含 JSON-safe 值；structuredClone 优先，退化 JSON 往返）
export function deepClone(value) {
  if (value === undefined) return undefined;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (e) { /* 含不可克隆值 → 退 JSON */ }
  return JSON.parse(JSON.stringify(value));
}

// 随机 id（不用 crypto.randomUUID：file:// 非安全上下文下可能缺失）
export function randomId(rand = Math.random) {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (rand() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

/**
 * 由「实体名」推导实体 id。
 * 复用 normalizeId（与提取器同一实现），并做**同项目内去重**（重名 → name_2 / name_3）。
 * @param {string} name 实体显示名
 * @param {Iterable<string>} [existingIds] 已占用的 id 集合
 */
export function entityIdFromName(name, existingIds = []) {
  const base = normalizeId(name);
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** 创建空项目 */
export function createEmptyProject({ name = '未命名项目', id = '', now = '' } = {}) {
  const ts = now || new Date().toISOString();
  return {
    version: PROJECT_VERSION,
    meta: { id: id || randomId(), name: String(name || '未命名项目'), created: ts, updated: ts },
    entities: {},
    hyperlanes: [],
    scenarios: { version: 2, baseMaps: {}, scenarios: {} },
    maps: {},
    snapshots: [],
  };
}

/**
 * 创建实体（与 GeoNode 同形）。
 * @param {{ id?: string, name: string, layer?: string, parentId?: string|null,
 *           tags?: string[], coordinate?: {x:number|null,y:number|null},
 *           origin?: string, sourcePath?: string, existingIds?: Iterable<string>,
 *           now?: string, uuid?: string }} input
 */
export function createEntity(input = {}) {
  const {
    id, name, layer = 'unknown', parentId = null, tags = [], coordinate = null,
    origin = 'project', sourcePath = '', existingIds = [], now = '', uuid = '',
  } = input;
  const ts = now || new Date().toISOString();
  const x = coordinate && typeof coordinate.x === 'number' && isFinite(coordinate.x) ? coordinate.x : null;
  const y = coordinate && typeof coordinate.y === 'number' && isFinite(coordinate.y) ? coordinate.y : null;
  // ⚠️ 必须先归一化 layer，再用归一化后的值取 layerLabel。
  //    直接用入参 layer 会让未知层级写出 `layerLabel: 'nope'`（实测被 test_46 抓到）。
  const normLayer = LAYER_ORDER.includes(layer) ? layer : 'unknown';
  return {
    id: id || entityIdFromName(name, existingIds),
    name: String(name || '未命名'),
    layer: normLayer,
    layerLabel: LAYER_LABELS[normLayer] || normLayer,
    parentId: parentId || null,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    coordinate: { x, y },
    origin,
    sourcePath: sourcePath || '',
    uuid: uuid || randomId(),
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * 实体是否可作为 `parentId` 目标的候选（排除自身与后代 —— 防循环的 UI 侧入口）。
 * @returns {string[]} 不允许作为父级的 id 列表
 */
export function forbiddenParentIds(entities, entityId) {
  const out = new Set([entityId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of Object.values(entities || {})) {
      if (e && e.parentId && out.has(e.parentId) && !out.has(e.id)) {
        out.add(e.id);
        grew = true;
      }
    }
  }
  return [...out];
}

/**
 * 校验并**就地修复**项目对象（不抛异常，问题全部收集进 problems）。
 * 修复原则：能确定语义的自动修（缺键补默认、悬空 parentId 置空、自引用置空、循环打破），
 * 不能确定的丢弃该条目并记问题（缺 id 的实体、类型完全不对的容器）。
 * @returns {{ ok: boolean, project: object|null, problems: string[] }}
 */
export function validateProject(raw) {
  const problems = [];
  if (!isPlainObject(raw)) {
    return { ok: false, project: null, problems: ['项目内容不是对象'] };
  }

  const version = typeof raw.version === 'string' && raw.version ? raw.version : PROJECT_VERSION;
  if (version !== raw.version) problems.push(`缺少 version，按 ${PROJECT_VERSION} 处理`);
  if (compareVersion(version, PROJECT_VERSION) > 0) {
    return { ok: false, project: null, problems: [`项目文件版本 ${version} 高于当前支持的 ${PROJECT_VERSION}（请升级司天）`] };
  }

  const now = new Date().toISOString();
  const meta = isPlainObject(raw.meta) ? { ...raw.meta } : {};
  if (!meta.id) { meta.id = randomId(); problems.push('meta.id 缺失，已补写'); }
  if (!meta.name) { meta.name = '未命名项目'; problems.push('meta.name 缺失，已补写'); }
  if (!meta.created) meta.created = now;
  if (!meta.updated) meta.updated = meta.created;

  // ---- entities ----
  const entities = {};
  const srcEntities = isPlainObject(raw.entities)
    ? raw.entities
    : (Array.isArray(raw.entities) ? Object.fromEntries(raw.entities.filter(e => e && e.id).map(e => [e.id, e])) : {});
  if (!isPlainObject(raw.entities) && !Array.isArray(raw.entities)) {
    problems.push('entities 不是对象/数组，已重置为空');
  }
  for (const [key, value] of Object.entries(srcEntities)) {
    if (!isPlainObject(value)) { problems.push(`实体 ${key} 不是对象，已丢弃`); continue; }
    const id = typeof value.id === 'string' && value.id ? value.id : key;
    if (typeof id !== 'string' || !id) { problems.push('存在缺 id 的实体，已丢弃'); continue; }
    const layer = LAYER_ORDER.includes(value.layer) ? value.layer : 'unknown';
    if (layer !== value.layer) problems.push(`实体 ${id} 的 layer「${value.layer}」未知，已按 unknown 处理`);
    const coord = isPlainObject(value.coordinate) ? value.coordinate : {};
    entities[id] = {
      ...value,
      id,
      name: typeof value.name === 'string' && value.name ? value.name : id,
      layer,
      layerLabel: LAYER_LABELS[layer] || layer,
      parentId: typeof value.parentId === 'string' && value.parentId ? value.parentId : null,
      tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
      coordinate: {
        x: typeof coord.x === 'number' && isFinite(coord.x) ? coord.x : null,
        y: typeof coord.y === 'number' && isFinite(coord.y) ? coord.y : null,
      },
      origin: value.origin === 'obsidian' ? 'obsidian' : 'project',
      sourcePath: typeof value.sourcePath === 'string' ? value.sourcePath : '',
    };
  }
  // 悬空 / 自引用 parentId
  for (const e of Object.values(entities)) {
    if (e.parentId && !entities[e.parentId]) {
      problems.push(`实体 ${e.id} 的 parentId「${e.parentId}」不存在，已置空`);
      e.parentId = null;
    }
    if (e.parentId === e.id) {
      problems.push(`实体 ${e.id} 的 parentId 指向自身，已置空`);
      e.parentId = null;
    }
  }
  // 循环（A→B→A）：把环上最后一条边的起点置空（与 store.detectCycles 同策略）
  {
    const state = new Map(); // id -> 0 未访问 / 1 在栈 / 2 完成
    const visit = (id) => {
      if (state.get(id) === 1) return id;      // 环起点
      if (state.get(id) === 2) return null;
      state.set(id, 1);
      const parent = entities[id].parentId;
      const hit = parent ? visit(parent) : null;
      state.set(id, 2);
      return hit;
    };
    for (const id of Object.keys(entities)) {
      if (state.has(id)) continue;
      const cyc = visit(id);
      if (cyc && entities[cyc]) {
        problems.push(`实体 ${cyc} 处于父子循环中，parentId 已置空`);
        entities[cyc].parentId = null;
      }
    }
  }

  // ---- hyperlanes ----
  let hyperlanes = [];
  if (Array.isArray(raw.hyperlanes)) {
    hyperlanes = raw.hyperlanes.filter(h => {
      if (!isPlainObject(h)) return false;
      if (typeof h.id !== 'string' || !h.id) { problems.push('存在缺 id 的航道，已丢弃'); return false; }
      if (!h.fromId || !h.toId) { problems.push(`航道 ${h.id} 端点缺失，已丢弃`); return false; }
      if (!entities[h.fromId] || !entities[h.toId]) { problems.push(`航道 ${h.id} 端点实体不存在，已丢弃`); return false; }
      return true;
    }).map(h => ({ ...h, type: h.type || 'local' }));
  } else if (raw.hyperlanes !== undefined) {
    problems.push('hyperlanes 不是数组，已重置为空');
  }

  // ---- scenarios（沿用既有 version 2 结构；这里只保证容器形状，内容由 scenarioEditing 负责）----
  let scenarios;
  if (isPlainObject(raw.scenarios) && isPlainObject(raw.scenarios.baseMaps) && isPlainObject(raw.scenarios.scenarios)) {
    scenarios = { version: raw.scenarios.version || 2, ...raw.scenarios };
  } else {
    if (raw.scenarios !== undefined) problems.push('scenarios 结构不完整，已重置为空白剧本容器');
    scenarios = { version: 2, baseMaps: {}, scenarios: {} };
  }

  // ---- maps ----
  let maps = {};
  if (isPlainObject(raw.maps)) maps = raw.maps;
  else if (raw.maps !== undefined) problems.push('maps 不是对象，已重置为空');

  // ---- snapshots ----
  const snapshots = [];
  if (Array.isArray(raw.snapshots)) {
    for (const s of raw.snapshots) {
      if (!isPlainObject(s) || !isPlainObject(s.patch)) { problems.push('存在损坏的快照条目，已丢弃'); continue; }
      snapshots.push({
        at: typeof s.at === 'string' ? s.at : now,
        label: typeof s.label === 'string' ? s.label : '',
        changes: typeof s.changes === 'number' ? s.changes : 0,
        ...(s.base !== undefined ? { base: s.base } : {}),
        patch: { set: Array.isArray(s.patch.set) ? s.patch.set : [], del: Array.isArray(s.patch.del) ? s.patch.del : [] },
      });
    }
    while (snapshots.length > SNAPSHOT_KEEP) dropOldestSnapshot(snapshots);
    // 第 0 份必须带 base，否则无法回放
    if (snapshots.length && snapshots[0].base === undefined) {
      problems.push('快照缓冲缺少基准（base），已整体丢弃');
      snapshots.length = 0;
    }
  } else if (raw.snapshots !== undefined) {
    problems.push('snapshots 不是数组，已重置为空');
  }

  return {
    ok: true,
    project: { version: PROJECT_VERSION, meta, entities, hyperlanes, scenarios, maps, snapshots },
    problems,
  };
}

/**
 * 版本迁移：把任意可识别的旧版本项目升到 PROJECT_VERSION。
 * 当前只有 1.0.0（无迁移步骤），函数保留以便将来「只改 MIGRATIONS、不动调用方」。
 * @returns {{ ok: boolean, project: object|null, from: string, to: string, steps: string[], problems: string[] }}
 */
export function migrateProject(raw) {
  const from = (isPlainObject(raw) && typeof raw.version === 'string') ? raw.version : PROJECT_VERSION;
  const steps = [];
  if (compareVersion(from, PROJECT_VERSION) > 0) {
    return { ok: false, project: null, from, to: PROJECT_VERSION, steps, problems: [`项目文件版本 ${from} 高于当前支持的 ${PROJECT_VERSION}`] };
  }
  // 🔴 迁移/校验**任何一步抛错都必须变成「拒绝加载」，绝不能让异常冒泡上去：
  //    异常冒出去 = 加载中断 = 画布空 = 用户以为文件坏了（更糟：接着一存就覆盖磁盘上的好数据）。
  //    拒绝加载时磁盘文件一个字节都不动，用户随时能用备份/基线回退。
  let cur = null;
  try {
    cur = deepClone(raw);
  } catch (err) {
    return { ok: false, project: null, from, to: PROJECT_VERSION, steps, problems: [`项目文件无法解析（${(err && err.message) || err}）`] };
  }
  if (compareVersion(from, PROJECT_VERSION) < 0) {
    for (const ver of Object.keys(MIGRATIONS).sort(compareVersion)) {
      if (compareVersion(ver, from) <= 0) continue;
      try {
        cur = MIGRATIONS[ver](cur);
      } catch (err) {
        return {
          ok: false, project: null, from, to: PROJECT_VERSION, steps,
          problems: [`从 ${from} 迁移到 ${ver} 失败：${(err && err.message) || err}（已拒绝加载，磁盘文件未被改动）`],
        };
      }
      cur.version = ver;
      steps.push(`迁移至 ${ver}`);
    }
  }
  let validated = null;
  try {
    validated = validateProject(cur);
  } catch (err) {
    return { ok: false, project: null, from, to: PROJECT_VERSION, steps, problems: [`项目内容校验异常：${(err && err.message) || err}（已拒绝加载，磁盘文件未被改动）`] };
  }
  return { ok: validated.ok, project: validated.project, from, to: PROJECT_VERSION, steps, problems: validated.problems };
}

// ============================================================
// 就地 diff / 回放 / 快照环形缓冲
// ============================================================

// 取出项目中被快照覆盖的那部分状态
export function snapshotState(project, keys = SNAPSHOT_DIFF_KEYS) {
  const out = {};
  for (const k of keys) out[k] = deepClone(project ? project[k] : undefined);
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// 递归 diff：对象递归到键级；数组/原始值整体替换（路径式 diff 不索引数组，
// 否则「省份数组插入一项」会产出几十条索引位移改动，diff 比整份拷贝还大）
function diffWalk(prev, next, path, set, del) {
  if (isPlainObject(prev) && isPlainObject(next)) {
    const pk = Object.keys(prev);
    const nk = new Set(Object.keys(next));
    for (const k of Object.keys(next)) {
      diffWalk(prev[k], next[k], [...path, k], set, del);
    }
    for (const k of pk) {
      if (!nk.has(k)) del.push({ path: [...path, k] });
    }
    return;
  }
  if (deepEqual(prev, next)) return;
  set.push({ path, value: deepClone(next) });
}

/**
 * 计算两个状态之间的补丁。
 * @param {object} prev @param {object} next
 * @param {string[]} [keys] 参与比较的顶层键（默认 SNAPSHOT_DIFF_KEYS）
 * @returns {{ set: {path:string[],value:any}[], del: {path:string[]}[] }}
 */
export function diffStates(prev, next, keys = SNAPSHOT_DIFF_KEYS) {
  const set = [];
  const del = [];
  const all = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  const scope = keys && keys.length ? keys : [...all];
  for (const k of scope) {
    const inPrev = prev && Object.prototype.hasOwnProperty.call(prev, k);
    const inNext = next && Object.prototype.hasOwnProperty.call(next, k);
    if (!inNext) { if (inPrev) del.push({ path: [k] }); continue; }
    diffWalk(inPrev ? prev[k] : undefined, next[k], [k], set, del);
  }
  return { set, del };
}

/** 把补丁应用到状态上（返回新对象，不改入参） */
export function applyPatch(base, patch) {
  const out = deepClone(base || {});
  const { set = [], del = [] } = patch || {};
  for (const { path } of del) {
    if (!Array.isArray(path) || !path.length) continue;
    const parent = path.slice(0, -1).reduce((acc, k) => (isPlainObject(acc) || Array.isArray(acc)) ? acc[k] : undefined, out);
    if (isPlainObject(parent)) delete parent[path[path.length - 1]];
  }
  for (const { path, value } of set) {
    if (!Array.isArray(path) || !path.length) continue;
    let node = out;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isPlainObject(node[k]) && !Array.isArray(node[k])) node[k] = {};
      node = node[k];
    }
    node[path[path.length - 1]] = deepClone(value);
  }
  return out;
}

// 快照缓冲：重放第 i 份快照对应的状态
function replayTo(snapshots, index) {
  let state = deepClone(snapshots[0].base || {});
  for (let i = 1; i <= index; i++) state = applyPatch(state, snapshots[i].patch);
  return state;
}

// 缓冲溢出：丢弃最旧的 1 份，把它的状态折进新的第 0 份（保持「1 base + N diff」不变式）
function dropOldestSnapshot(snapshots) {
  if (snapshots.length < 2) { snapshots.shift(); return; }
  const base = applyPatch(deepClone(snapshots[0].base || {}), snapshots[1].patch);
  snapshots.shift();
  snapshots[0] = { ...snapshots[0], base, patch: { set: [], del: [] } };
}

/**
 * 快照计数（顶层键级）：用于 UI 展示「本份快照改了多少东西」
 */
export function countChanges(patch) {
  return ((patch && patch.set) ? patch.set.length : 0) + ((patch && patch.del) ? patch.del.length : 0);
}

/**
 * 追加一份快照（返回新 project，不改入参）。落盘前调用。
 * @param {object} project
 * @param {{ label?: string, at?: string, keep?: number, keys?: string[] }} [opts]
 */
export function pushSnapshot(project, opts = {}) {
  const { label = '', at = '', keep = SNAPSHOT_KEEP, keys = SNAPSHOT_DIFF_KEYS } = opts;
  const snapshots = (project.snapshots || []).map(s => ({ ...s }));
  const state = snapshotState(project, keys);
  const ts = at || new Date().toISOString();

  if (!snapshots.length) {
    snapshots.push({ at: ts, label, base: state, patch: { set: [], del: [] }, changes: 0 });
  } else {
    const prevState = replayTo(snapshots, snapshots.length - 1);
    const patch = diffStates(prevState, state, keys);
    snapshots.push({ at: ts, label, patch, changes: countChanges(patch) });
  }

  while (snapshots.length > Math.max(1, keep)) dropOldestSnapshot(snapshots);
  return { ...project, snapshots };
}

/**
 * 恢复到第 index 份快照的状态（只返回被快照覆盖的那部分键，由调用方合并进 project）。
 * @returns {{ ok: boolean, state?: object, at?: string, label?: string, error?: string }}
 */
export function restoreSnapshot(project, index) {
  const snapshots = project.snapshots || [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= snapshots.length) {
    return { ok: false, error: `快照下标越界：${index}（共 ${snapshots.length} 份）` };
  }
  return {
    ok: true,
    state: replayTo(snapshots, i),
    at: snapshots[i].at,
    label: snapshots[i].label,
  };
}

/** 快照摘要（UI 列表用；不含 base/patch 正文） */
export function snapshotSummaries(project) {
  return (project.snapshots || []).map((s, index) => ({
    index,
    at: s.at,
    label: s.label,
    changes: s.changes || 0,
    hasBase: s.base !== undefined,
  }));
}

/**
 * 统计（UI 标题栏 / 测试断言用）
 */
export function projectStats(project) {
  const entities = project && isPlainObject(project.entities) ? project.entities : {};
  const byLayer = {};
  for (const e of Object.values(entities)) byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
  return {
    entities: Object.keys(entities).length,
    hyperlanes: Array.isArray(project && project.hyperlanes) ? project.hyperlanes.length : 0,
    scenarios: Object.keys((project && project.scenarios && project.scenarios.scenarios) || {}).length,
    maps: Object.keys((project && project.maps) || {}).length,
    snapshots: Array.isArray(project && project.snapshots) ? project.snapshots.length : 0,
    byLayer,
  };
}

/** 序列化（统一缩进；主进程负责写盘） */
export function serializeProject(project) {
  return JSON.stringify(project, null, 2);
}
