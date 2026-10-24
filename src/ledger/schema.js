// src/ledger/schema.js — 账本事件流的**形状与校验**（唯一实现；2026-10-24 第 3 件）
//
// 为什么要有一层"事件流"，而不是继续用 `scenario.ownership` + `changeEvents`（v2 形状）：
//   v2 的事件仍然是**按省分组、按 y/m/d 记**的，于是三件事永远说不清：
//     ① 一"笔"（一次笔刷拖动）产出的多个省的变化没有共同身份 → 撤销只能逐省回滚；
//     ② 年份可负、月日可缺省，跨剧本/跨日历的排序没有唯一口径；
//     ③ "谁改的"（人？导入？AI 翻译？）没有字段可记。
//   本层把事件统一成**一条流**：
//     { id, worldId, epochId, day, type, groupId, provenance, payload }
//   `day` 是**该 epoch 内的绝对日**（可负），由 `CalendarConfig` 从 {y,m,d} 换算；
//   `groupId` 是"一笔/一次操作"的身份（同一 group 的事件必须原子地撤/重做）；
//   `provenance` 记来源（'brush' | 'import' | 'ui' | 'ai' | 'migrate'）。
//
// 🔴 本目录是**纯数据层**：不 import vue / store / 任何组件，也不碰 DOM
//    （单测 `test_ledger_core.js` 的 a6 段读源码守这一条）。
//
// 与既有 v2 账本的关系（重要，防"两份真源"）：
//   `scenario.initialOwnership` / `changeEvents` / `ownership` 在 M1 里**降级为投影缓存**，
//   由本引擎落盘后重算；`utils/scenarioLedgerV2.js` 的 `deriveFrom` 也只是把 v2 形状喂给
//   `replay.js` 的适配器（见该文件注释）—— 判定"某省某天归谁"仍然只有一份实现。

/** 账本格式版本（事件流自身；与项目文件版本 `PROJECT_VERSION` 无关） */
export const LEDGER_VERSION = 1;

/** 默认历法：一年 360 天、一月 30 天（司天既有数据就是这个口径，随项目保存，换机器不变） */
export const DEFAULT_CALENDAR = Object.freeze({ yearLength: 360, monthLength: 30 });

/** 已登记的事件类型 → 中文标签（payload 形状见各类型注释） */
export const EVENT_TYPES = {
  /** 某省易主：payload = { provinceId, fromPolityId, toPolityId }（null = 无主） */
  'province.owner.changed': '省份易主',
  /** 该代开始时的归属（不可撤；每个 epoch 恰好一条，day 恒 0） */
  'epoch.baseline': '本代基线',
  /** 一笔落库：payload = { stroke }（形状见 `stroke.js`；rawPoints 是真源，geometry 是生成物） */
  'stroke.committed': '笔画落库',
};

// ⚠️ 类型键要当**常量**用，别写 `EVENT_TYPES['epoch.baseline']` —— 那是中文标签，不是键。
//    2026-10-24 踩过：事件被判成 type="本代基线"，回放里基线一条都不认，整段归属全空。
export const EVENT_BASELINE = 'epoch.baseline';
export const EVENT_OWNER_CHANGED = 'province.owner.changed';
export const EVENT_STROKE_COMMITTED = 'stroke.committed';

export const EVENT_TYPE_LIST = Object.keys(EVENT_TYPES);

/** 来源标记（写进事件；**不许**省略 —— 没有来源的事件在审计时分不清是笔刷还是导入） */
export const PROVENANCE = Object.freeze({
  BRUSH: 'brush',
  UI: 'ui',
  IMPORT: 'import',
  AI: 'ai',
  MIGRATE: 'migrate',
});

const PROVENANCE_SET = new Set(Object.values(PROVENANCE));

/** 历法归一：非法/缺省一律回默认；只认正整数 */
export function normalizeCalendar(calendar) {
  const src = calendar && typeof calendar === 'object' ? calendar : {};
  const yearLength = Number.isInteger(src.yearLength) && src.yearLength > 0
    ? src.yearLength : DEFAULT_CALENDAR.yearLength;
  const monthLength = Number.isInteger(src.monthLength) && src.monthLength > 0
    ? src.monthLength : Math.max(1, Math.round(yearLength / 12)) || DEFAULT_CALENDAR.monthLength;
  return { yearLength, monthLength };
}

/**
 * {y, m?, d?} → **epoch 内绝对日**（可负）。
 *
 * 口径（与 `utils/scenarioDates.toOrdinal` 同序，但落成"日"而不是"y*10000+m*100+d"）：
 *   · `m`/`d` 缺省按 1 月 1 日（与 `normalizeDate` 一致：`m` 为 null 时 `d` 一律归 null）；
 *   · 一年 = `yearLength` 天，一月 = `monthLength` 天；月/日越界**夹进当年当年内**（不抛错：
 *     脏数据不该让整本账读不出来，但调用方可用 `validateEvent` 拦在写口）。
 *   · 年份可负：`day = y*yearLength + …` 对负年份同样单调。
 */
export function dayOfDate(date, calendar) {
  const cal = normalizeCalendar(calendar);
  const src = (typeof date === 'number' || typeof date === 'string') ? { y: date } : (date || {});
  const y = Number(src.y !== undefined ? src.y : src.year);
  if (!Number.isFinite(y)) return null;
  const rawM = src.m !== undefined ? src.m : src.month;
  const rawD = src.d !== undefined ? src.d : src.day;
  // ⚠️ 这里必须先判"有没有值"再做数字归一：`Number(null) === 0` 且 `Number.isInteger(0)` 为真，
  //    直接归一会把"没给月份"当成"1 月"、再让 d 生效（曾把 {y:5,m:null,d:9} 算成 5 年 9 日）。
  const mNum = (rawM === null || rawM === undefined || rawM === '') ? null : Number(rawM);
  const m = Number.isInteger(mNum) ? mNum : null;
  const dNum = (rawD === null || rawD === undefined || rawD === '') ? null : Number(rawD);
  const d = (m === null) ? null : (Number.isInteger(dNum) ? dNum : null);
  const mi = Math.min(Math.max(1, m === null ? 1 : m), 12);
  const di = Math.min(Math.max(1, d === null ? 1 : d), cal.monthLength);
  return Math.trunc(y) * cal.yearLength + (mi - 1) * cal.monthLength + (di - 1);
}

/** 绝对日 → {y, m, d}（给 UI/导出用；`day` 必须是整数） */
export function dateOfDay(day, calendar) {
  const cal = normalizeCalendar(calendar);
  if (!Number.isFinite(day)) return null;
  const n = Math.trunc(day);
  // 负数取模要落回 [0, yearLength)：用 floor 语义
  const y = Math.floor(n / cal.yearLength);
  const rem = n - y * cal.yearLength;
  const m = Math.floor(rem / cal.monthLength) + 1;
  const d = (rem % cal.monthLength) + 1;
  return { y, m, d };
}

/** 生成事件 id（同一账本内唯一即可；不用随机数，保持可复现） */
export function makeEventId(existing, prefix = 'ev') {
  const used = existing instanceof Set ? existing : new Set(Array.isArray(existing) ? existing : []);
  let i = used.size + 1;
  let id = `${prefix}-${i}`;
  while (used.has(id)) { i += 1; id = `${prefix}-${i}`; }
  return id;
}

/**
 * 造一条事件（**唯一的构造入口**：形状只在这里定）。
 *
 * @param {object} draft {worldId, epochId, day|date, type, groupId, provenance, payload}
 * @param {{calendar?:object, existingIds?:Set|Array, id?:string}} [opts]
 * @returns {object} 归一后的事件（**不校验业务含义**，那是 `validateEvent` 的事）
 */
export function makeEvent(draft = {}, opts = {}) {
  const cal = normalizeCalendar(opts.calendar);
  const day = Number.isFinite(draft.day) ? Math.trunc(draft.day) : dayOfDate(draft.date, cal);
  const ev = {
    id: draft.id || makeEventId(opts.existingIds ? opts.existingIds : [], 'ev'),
    worldId: String(draft.worldId || 'default'),
    epochId: String(draft.epochId || ''),
    day: Number.isFinite(day) ? day : 0,
    type: String(draft.type || ''),
    groupId: draft.groupId ? String(draft.groupId) : '',
    provenance: String(draft.provenance || PROVENANCE.MIGRATE),
    payload: draft.payload && typeof draft.payload === 'object' ? { ...draft.payload } : {},
    ledgerVersion: LEDGER_VERSION,
  };
  return ev;
}

/**
 * 校验一条事件。返回 `{ok, errors[]}`（**不抛错**：装载路径要把坏事件挑出来而不是整本账读不出）。
 *
 * 为什么校验放在 schema 而不是写口：写口很多（笔刷/UI/导入/AI 翻译），
 * 而"形状对不对"必须只有一套判据 —— 各写口自己 if 一遍迟早漂移。
 */
export function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object') return { ok: false, errors: ['事件不是对象'] };
  if (!ev.id) errors.push('缺 id');
  if (!ev.epochId) errors.push('缺 epochId');
  if (!Number.isFinite(ev.day)) errors.push('day 不是有限数（可负，必须是整数日）');
  if (!Number.isInteger(ev.day)) errors.push('day 必须是整数');
  if (!EVENT_TYPES[ev.type]) errors.push(`未登记的事件类型：${ev.type || '(空)'}`);
  if (!PROVENANCE_SET.has(ev.provenance)) errors.push(`来源标记非法：${ev.provenance || '(空)'}`);
  if (ev.type === 'province.owner.changed') {
    const p = ev.payload || {};
    if (!p.provinceId) errors.push('province.owner.changed 缺 provinceId');
    if (p.fromPolityId === undefined) errors.push('province.owner.changed 缺 fromPolityId（无主写 null）');
    if (p.toPolityId === undefined) errors.push('province.owner.changed 缺 toPolityId（无主写 null）');
    if (p.fromPolityId !== null && typeof p.fromPolityId !== 'string') errors.push('fromPolityId 必须是字符串或 null');
    if (p.toPolityId !== null && typeof p.toPolityId !== 'string') errors.push('toPolityId 必须是字符串或 null');
  }
  if (ev.type === 'epoch.baseline' && ev.day !== 0) errors.push('epoch.baseline 的 day 必须是 0（基线不可撤、不可挪）');
  if (ev.type === 'stroke.committed') {
    const st = ev.payload && ev.payload.stroke;
    if (!st || typeof st !== 'object') errors.push('stroke.committed 缺 payload.stroke');
    else {
      if (!st.strokeId) errors.push('stroke.committed 的笔画缺 strokeId');
      if (!st.kind) errors.push('stroke.committed 的笔画缺 kind');
      if (!Array.isArray(st.rawPoints) || st.rawPoints.length < 2) errors.push('stroke.committed 的 rawPoints 不足 2 点（原始点必须留）');
      if (st.geometry === undefined) errors.push('stroke.committed 的笔画缺 geometry');
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 一个 epoch 的账本容器：`{worldId, epochId, calendar, events[]}`。
 * 事件**只追加不改写**（改 = 追加一条相反事件；撤销 = `groups.removeGroup` 摘下整组，见 groups.js）。
 */
export function createLedger({ worldId = 'default', epochId = '', calendar = null, events = [] } = {}) {
  const cal = normalizeCalendar(calendar);
  return {
    ledgerVersion: LEDGER_VERSION,
    worldId: String(worldId || 'default'),
    epochId: String(epochId || ''),
    calendar: cal,
    events: (Array.isArray(events) ? events : []).slice(),
  };
}
