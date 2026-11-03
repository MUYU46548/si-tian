// utils/genProvenance.js — **生成即录账本**（provenance）：把“这次生成了什么、用什么参数”
// 记成一条可回放、可对拍的小记录（N3a-1 / A8，2026-11-02）
//
// ── 为什么需要它（问题本身）─────────────────────────────────────────────────
//   造陆 / 地形推演 / 文化·宗教派生都已经进 undo 栈（一次 Ctrl+Z 退回），但撤销只回得去
//   **状态**，回不去“这是怎么生成的”—— 种子、参数、口径一个都没留下。后果三条：
//     ① **复现不了**：用户想“再出一张差不多的大陆”只能靠记忆；
//     ② **对拍不了**：同一份地形到底是不是同一组参数生成的，只能靠眼睛看；
//     ③ **缺口只会越来越大**：每加一个生成器（侵蚀 / 河流重排…）就多一处“没账”。
//   所以账本必须跟数据**同一条命令**写（见 store 里 `generate-landmass` / `derive-culture` /
//   `synthesize-terrain` 的 undo/redo）—— 一次 Ctrl+Z 数据与账一起退回，**不会**出现
//   “数据没了账还在”或“账没了数据还在”这种半截状态。
//
// ── 纪律（改这个文件前先读）─────────────────────────────────────────────────
//   · **纯函数**：零 DOM / 零 Vue / 零依赖 / 不用 crypto（Node 与浏览器同一份，用例直接 import）；
//   · **只记标量**：`summary` 只收计数与占比，**绝不收 heightmap / terrain / 多边形数组**
//     （账本是给人和回放读的，不是第二份数据 —— 几十 KB 的账会把每次保存都拖慢）；
//   · **确定性 id**：`id = gen_<kind>_<digest>`，digest 只由 kind + 参数 + seed + summary 决定
//     → **同一组参数生成两次，id 与 digest 完全相同**（这正是“可对拍”的前提：保存后重开
//     再生成一次，看 id 就知道是不是同一张图）。所以 id 里**绝不能**掺时间戳/随机数；
//   · `at`（ISO 时间）只给人看与排序，**不进 digest**（否则同一参数两次生成就对不上了）；
//   · 参数指纹只认“**影响生成结果**”的键（见 `GEN_PARAM_IGNORE`）——
//     `force` / `keepHandEdits` / 整份高度图 这类执行期输入混进指纹会让"同参数"永远不同。

/**
 * 生成种类（键 = 记录里的 `kind`，值 = 中文标签）。新增生成器时先在这里登记 kind。
 *
 * 现状（2026-11-02）：
 *   · `landmass` —— 造陆（store/generateLandmass，**有重放**）
 *   · `terrain`  —— 地形推演（store/synthesizeTerrainInto：底图 + 行星两条容器都记）
 *   · `culture` / `religion` —— 文化·宗教派生（store/applyCultureDerive，一次派生两条账）
 *   · `rivers`   —— 目前**没有生产写口**：画布“自动河流”只算不写（结果留在
 *     `ScenarioMap` 的 `autoRivers` 里，用户看得到但没落库），落库的河流只来自造陆
 *     （已并入 `landmass` 记录的 summary）。等河流生成有了自己的落库入口，再补 kind。
 */
export const GEN_KINDS = Object.freeze({
  landmass: '造陆',
  terrain: '地形生成',
  rivers: '河流生成',
  culture: '文化派生',
  religion: '宗教派生',
});

export const GEN_KIND_KEYS = Object.freeze(Object.keys(GEN_KINDS));

/** kind → 中文标签（未知 kind 原样返回，绝不抛：回执文案不该因为一条旧记录炸掉） */
export function genKindLabel(kind) {
  return Object.prototype.hasOwnProperty.call(GEN_KINDS, kind) ? GEN_KINDS[kind] : String(kind || '');
}

/**
 * **执行期参数**：只影响“怎么写”、不影响“生成什么”→ 不进指纹。
 *   · `force` / `keepHandEdits`：覆盖确认与手绘保留开关（同一组参数、两种写法，结果数据相同）；
 *   · `onProgress` / `token`：UI 回调与取消令牌；
 *   · `heightmap`：FMG 分支会把**整份高度图**塞进 opts.params（2 万格数组，不是参数）。
 *     ⚠️ 它一旦进 canonicalParams，账本就变成第二份数据 —— 这条是硬约束，不是优化。
 */
export const GEN_PARAM_IGNORE = Object.freeze(['force', 'keepHandEdits', 'onProgress', 'token', 'heightmap']);

/** 规范标量 → JSON 片段（对象键**排序**、数组保序；数字必须是有限数） */
function canonValue(v, path) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    // 🔴 非有限数（NaN / ±Infinity）必须**当场拒绝**：它们 JSON 化后是 `null`，
    //    两条完全不同的失败参数会得到同一个指纹 —— 那是"看着记了账、其实对不上"。
    if (!Number.isFinite(v)) throw new TypeError(`canonicalParams: ${path} 不是有限数（${String(v)}）`);
    // -0 与 0 语义相同 → 走 JSON.stringify 归一成 `0`
    return JSON.stringify(v);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x, i) => canonValue(x, `${path}[${i}]`)).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonValue(v[k], `${path}.${k}`)).join(',') + '}';
  }
  // undefined 已在对象/数组里跳过；到这里是 symbol / bigint / function —— 不能进指纹
  throw new TypeError(`canonicalParams: ${path} 类型不支持（${t}）`);
}

/**
 * 参数 → **稳定**的规范 JSON（键排序，与对象字面量顺序无关）。
 * 只收生成相关子集（`GEN_PARAM_IGNORE` 里的执行期键跳过）；非有限数**抛 TypeError**。
 *
 * 为什么不用 `JSON.stringify(params)`：对象键顺序由字面量决定，`{a,b}` 与 `{b,a}`
 * 会得到两个指纹 —— 同一次生成换个写法就"不是同一次生成"了。
 */
export function canonicalParams(params) {
  if (params === undefined || params === null) return '{}';
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('canonicalParams: params 必须是普通对象');
  }
  const picked = {};
  for (const k of Object.keys(params)) {
    if (GEN_PARAM_IGNORE.indexOf(k) >= 0) continue;
    const v = params[k];
    if (v === undefined || typeof v === 'function') continue;
    picked[k] = v;
  }
  return canonValue(picked, 'params');
}

/**
 * FNV-1a 32 位（十六进制，8 位定宽）。
 * `parts` 是数组时用 `\u0001` 连接（分隔符不会出现在正常参数里）——
 * 这样 `['ab','c']` 与 `['a','bc']` 不会是同一个指纹。
 * 按 UTF-16 码元的**两个字节**混入（中文标签同样稳定）；不用 crypto：浏览器与 Node 同一份。
 */
export function digestOf(parts) {
  const s = Array.isArray(parts)
    ? parts.map((p) => (p === undefined || p === null ? '' : String(p))).join('\u0001')
    : String(parts === undefined || parts === null ? '' : parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (c >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 摘要归一：**只留标量**（计数 / 占比 / 枚举名）。
 *   · 非有限数丢弃（`landRatio` 之类偶尔是 NaN，不该让整条记录写不进去）；
 *   · 数组 / 对象 / 函数**直接抛** —— 这是“payload 要小”的硬闸门：
 *     有人把 heightmap 塞进 summary 的那一刻就应该炸，而不是悄悄生成一份几十 KB 的账。
 * 键排序 → 指纹与插入顺序无关。
 */
export function summaryOf(src) {
  if (src === undefined || src === null) return {};
  if (typeof src !== 'object' || Array.isArray(src)) {
    throw new TypeError('summaryOf: summary 必须是普通对象（只收标量计数）');
  }
  const out = {};
  for (const k of Object.keys(src).sort()) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) continue;      // 丢掉坏标量，不丢整条记录
      out[k] = v;
      continue;
    }
    if (t === 'string' || t === 'boolean') { out[k] = v; continue; }
    throw new TypeError(`summaryOf: ${k} 不是标量（${Array.isArray(v) ? 'array' : t}）`
      + ' —— 账本只记计数，不记数据本体');
  }
  return out;
}

/**
 * 合法的图幅？四个有限数、且两条边都 > 10。
 * 与 store 的 `recordedLandBBox` 同口径 —— 造陆/推演的图幅是**生成输入**，
 * 记录里带的就是它，重放前必须验一遍（坏图幅重放出来的是另一块大陆，不是"同一张图"）。
 */
export function isValidBBox(b) {
  if (!b || typeof b !== 'object') return false;
  const vals = [b.minX, b.minY, b.maxX, b.maxY].map(Number);
  if (!vals.every((v) => Number.isFinite(v))) return false;
  return vals[2] - vals[0] > 10 && vals[3] - vals[1] > 10;
}

const roundTo = (v, dp) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * **造陆**结果的标量摘要（账本 `summary` 的唯一来源；重放也读它 → 同一口径）。
 * 只留计数与占比：环数 / 洞数 / 顶点数 / 河流数 / 河点数 / 陆地占比 / 网格格数。
 * ⚠️ 绝不收 `terrain`（2 万点的对象数组）或 `rings`（上万点）—— 那是数据本体，不是账。
 * ⚠️ 也不收 `stats.timings`：耗时每次都不一样，进了摘要就"同参数永远对不上"。
 */
export function landmassSummary(gen) {
  const g = gen || {};
  const stats = g.stats || {};
  const rings = Array.isArray(g.rings) ? g.rings : [];
  const rivers = Array.isArray(g.rivers) ? g.rivers : [];
  let holes = 0;
  let verts = 0;
  for (const r of rings) {
    holes += ((r && r.holes) || []).length;
    verts += ((r && r.points) || []).length;
  }
  let riverPoints = 0;
  for (const r of rivers) riverPoints += ((r && r.points) || []).length;
  return {
    rings: rings.length,
    holes,
    verts,
    rivers: rivers.length,
    riverPoints,
    // 占比是"这块大陆长什么样"的最强单值指纹：多一个海湾就变
    landPct: roundTo((Number(stats.landRatio) || 0) * 100, 4),
    targetPct: roundTo((Number(stats.targetRatio) || 0) * 100, 4),
    cells: Number(stats.cells) || 0,
  };
}

/** **地形推演**结果的标量摘要（格数 / 格距）—— 与造陆同一套口径，只收标量 */
export function terrainSummary(syn) {
  const g = syn || {};
  const cells = Number.isFinite(g.cellCount) ? g.cellCount : (g.h ? g.h.length : 0);
  const spacing = Number.isFinite(g.effectiveCellSize)
    ? g.effectiveCellSize
    : (Number(g.grid && g.grid.spacing) || 0);
  return { cells: Number(cells) || 0, spacing: roundTo(spacing, 3) };
}

const seedText = (seed) => {
  if (seed === undefined || seed === null || seed === '') return 'auto';
  const n = Number(seed);
  if (!Number.isFinite(n)) throw new TypeError(`seed 不是有限数（${String(seed)}）`);
  return String(n);
};

/**
 * 一条记录（或一次重跑）的指纹 —— **唯一实现**：`makeGenRecord` 与 `verifyRecord`
 * 都走这里，绝不允许两处各拼一次（两份实现 = 重放永远对不上，且不会报错）。
 *
 * digest 覆盖：`kind + canonicalParams(params) + seed + summary`。
 * ⚠️ 不覆盖 `key`（哪张底图）：同一组参数在两张底图上生成的是**同一张图**，
 *    它们本就该是同一个 id —— 过滤归属靠 `key` 字段，不靠 id。
 */
export function recordDigest({ kind, params, seed, summary } = {}) {
  const kindText = String(kind || '');
  let summaryText;
  try {
    summaryText = JSON.stringify(summaryOf(summary));
  } catch (err) {
    throw new TypeError(`recordDigest: ${(err && err.message) || err}`);
  }
  return digestOf([kindText, canonicalParams(params), seedText(seed), summaryText]);
}

/**
 * 生成一条账本记录。
 *
 * @param {object} p
 * @param {string} p.kind     见 `GEN_KINDS`（`landmass` / `terrain` / `rivers` / `culture` / `religion`）
 * @param {string} [p.key]    容器键（底图 key / `planet:<id>`）；**不进 digest**
 * @param {object} [p.params] 生成参数（已归一化的那份，**原样传**，不要再拼第二份）
 * @param {number} [p.seed]   种子（缺省取 `params.seed`；都没有 → `auto`）
 * @param {string} [p.at]     ISO 时间（**不进 digest**，只给人看）
 * @param {object} [p.result] 生成结果里的标量计数（与 `summary` 二选一，`summary` 优先）
 * @param {object} [p.summary] 同上（显式写法）
 * @returns {{id:string, kind:string, key:string, at:string, seed:number|null,
 *            params:object, digest:string, summary:object}}
 *
 * 🔴 `id` 是**确定性**的：同 kind + 同参数 + 同 seed + 同 summary → 同 id + 同 digest。
 *    所以“同一组参数生成两次”在账本里是同一条（`appendGenRecord` 会原位替换，不叠加）。
 */
export function makeGenRecord({ kind, key = '', params = {}, seed, at, result, summary } = {}) {
  const kindText = String(kind || '');
  if (!Object.prototype.hasOwnProperty.call(GEN_KINDS, kindText)) {
    throw new TypeError(`makeGenRecord: 未知 kind（${kindText || '空'}），合法值：${GEN_KIND_KEYS.join(' / ')}`);
  }
  const sum = summaryOf(summary === undefined ? result : summary);
  const rawSeed = seed === undefined || seed === null
    ? (params && params.seed)
    : seed;
  const seedVal = (rawSeed === undefined || rawSeed === null || rawSeed === '')
    ? null
    : Number(rawSeed);
  if (seedVal !== null && !Number.isFinite(seedVal)) {
    throw new TypeError(`makeGenRecord: seed 不是有限数（${String(rawSeed)}）`);
  }
  const digest = recordDigest({ kind: kindText, params, seed: seedVal, summary: sum });
  return {
    id: `gen_${kindText}_${digest}`,
    kind: kindText,
    key: String(key || ''),
    at: at || new Date().toISOString(),
    seed: seedVal,
    params: { ...params },
    digest,
    summary: sum,
  };
}

/**
 * 追加一条记录（**返回新数组，绝不改入参**）。
 * 同 id 已存在 → **原位替换**（不叠加）：同一组参数重复生成不该长出两条一模一样的账。
 */
export function appendGenRecord(list, rec) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (!rec || typeof rec !== 'object' || !rec.id) return out;
  const i = out.findIndex((r) => r && r.id === rec.id);
  if (i >= 0) out[i] = rec;
  else out.push(rec);
  return out;
}

/** 按 key 取记录（**返回新数组**；key 省略 = 整个列表的副本） */
export function provenanceOf(list, key) {
  const arr = Array.isArray(list) ? list : [];
  if (key === undefined || key === null || key === '') return arr.slice();
  const k = String(key);
  return arr.filter((r) => !!r && String(r.key) === k);
}

/** 按 id 删一条（**返回新数组**；id 不存在 = 原样复制一份） */
export function dropGenRecord(list, id) {
  const arr = Array.isArray(list) ? list : [];
  const target = String(id);
  return arr.filter((r) => !!r && r.id !== target);
}

/**
 * 校验“记录 vs 重跑结果”：用**同一条** `recordDigest` 重算，与存下来的 digest 比。
 *
 * @param {object} rec 账本里那条记录
 * @param {object} replayed `{ kind?, params?, seed?, summary? }` 或 `{ result? }`
 *        （缺省字段回落到记录自身的值 → 只验"summary 是否对得上"也是合法用法）
 * @returns {{ok:boolean, reason:string, expected?:string, actual?:string}}
 *          reason ∈ ok / no-record / bad-kind / no-digest / kind-mismatch / seed-mismatch /
 *                   bad-params / bad-summary / digest-mismatch / id-mismatch
 */
export function verifyRecord(rec, replayed = {}) {
  if (!rec || typeof rec !== 'object') return { ok: false, reason: 'no-record' };
  if (!Object.prototype.hasOwnProperty.call(GEN_KINDS, String(rec.kind))) {
    return { ok: false, reason: 'bad-kind' };
  }
  if (!rec.digest) return { ok: false, reason: 'no-digest' };
  const r = replayed && typeof replayed === 'object' ? replayed : {};
  const kind = r.kind === undefined || r.kind === null || r.kind === '' ? rec.kind : r.kind;
  if (String(kind) !== String(rec.kind)) return { ok: false, reason: 'kind-mismatch' };
  const params = r.params === undefined ? rec.params : r.params;
  const seed = r.seed === undefined ? rec.seed : r.seed;
  // 记录自洽：重跑用的 seed 必须就是记录里写的那个（只改顶层 seed 不改参数 = 半截篡改）
  const seedMatches = (a, b) => {
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
    if (b === null || b === undefined || b === '') return false;
    return Number(a) === Number(b);
  };
  if (r.seed !== undefined && !seedMatches(rec.seed, r.seed)) {
    return { ok: false, reason: 'seed-mismatch', expected: rec.seed, actual: r.seed };
  }
  let summary;
  if (r.summary !== undefined) summary = r.summary;
  else if (r.result !== undefined) summary = r.result;
  else summary = rec.summary;
  let actual;
  try {
    actual = recordDigest({ kind: String(kind), params, seed, summary });
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, reason: msg.indexOf('summary') >= 0 ? 'bad-summary' : 'bad-params', detail: msg };
  }
  if (actual !== rec.digest) {
    return { ok: false, reason: 'digest-mismatch', expected: rec.digest, actual };
  }
  // id 必须能从 digest 推回来（防"改了摘要没改 id"的半截篡改）
  if (rec.id && rec.id !== `gen_${String(kind)}_${actual}`) {
    return { ok: false, reason: 'id-mismatch', expected: `gen_${String(kind)}_${actual}`, actual: rec.id };
  }
  return { ok: true, reason: 'ok' };
}
