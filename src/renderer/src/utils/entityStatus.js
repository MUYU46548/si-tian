// utils/entityStatus.js — 实体「叙事状态」注册表（2026-09-24）
//
// ── 要解决的问题 ─────────────────────────────────────────────────────────────
// 世界观里大量东西在**叙事上已经不存在了**，但地图数据仍然需要：
// 「乐园星被毁灭了，但我要画毁灭前的它」「旧王都已荒废，但历史剧本要用」。
//
// 用户决策（2026-09-24）：
//   · **毁灭只是叙事状态**，不是数据删除 —— 实体可以保留，也可以根本不建。
//   · 保留实体时用**状态标记**表达（本模块），不建实体时走「剧本底图自持高度图」那条路
//     （见 docs/A1_DATA_MODEL_DECISION.md 第六节）。
//
// ── 两条硬约束 ──────────────────────────────────────────────────────────────
// 1. **状态只影响"怎么显示"，不影响"数据是否存在"**：无论什么状态，坐标 / 地图 / 剧本数据一律完整保留。
//    绝不能因为标了「已毁灭」就把地图数据清掉 —— 那正是历史地图赖以存在的东西。
// 2. **未知值一律回落 `active`**：数据里的脏值不能让人误以为某颗星球已经毁灭了；"存在"是最安全的默认假设。
//
// ── 本文件只放纯函数（不碰 store / Vue）→ 可在 Node 下直测 ─────────────────────

export const DEFAULT_STATUS = 'active';

/**
 * 内置状态。`faded: true` 表示「画布与列表上做淡化处理」——
 * 注意这只是**视觉降权**，不是隐藏，更不是删除数据。
 */
export const ENTITY_STATUSES = [
  {
    id: 'active', label: '存在', short: '', faded: false,
    hint: '当前时间线上正常存在',
  },
  {
    id: 'destroyed', label: '已毁灭', short: '已毁灭', faded: true,
    hint: '叙事上已毁灭 —— 地图与剧本数据仍完整保留，可用于「毁灭前」的历史地图',
  },
  {
    id: 'ruined', label: '已荒废', short: '荒废', faded: true,
    hint: '仍然存在，但已废弃 / 沦为废墟',
  },
  {
    id: 'sealed', label: '已封印', short: '封印', faded: true,
    hint: '存在，但被封闭 / 隔离，不可达',
  },
  {
    id: 'lost', label: '已失联', short: '失联', faded: true,
    hint: '失去联络，状况不明（可能仍存在）',
  },
  {
    id: 'unknown', label: '状态未知', short: '未知', faded: false,
    hint: '叙事上尚未确定',
  },
];

const BY_ID = new Map(ENTITY_STATUSES.map(s => [s.id, s]));

/** 是否是一个已知状态 id */
export function isKnownStatus(id) {
  return BY_ID.has(String(id || ''));
}

/**
 * 归一化状态 id：空 / 未知 / 非字符串一律回落 `active`。
 * ⚠️ 不抛错、不返回 undefined —— 调用方（渲染、列表）不该为脏数据写分支。
 */
export function resolveStatus(id) {
  const key = String(id == null ? '' : id);
  return BY_ID.has(key) ? key : DEFAULT_STATUS;
}

/** 取状态元数据（永远返回一个对象） */
export function statusMeta(id) {
  return BY_ID.get(resolveStatus(id)) || BY_ID.get(DEFAULT_STATUS);
}

/**
 * 是否需要在 UI 上**淡化**（不是隐藏！）。
 * `active` / `unknown` 不淡化；`destroyed` / `ruined` / `sealed` / `lost` 淡化。
 */
export function isFaded(id) {
  return !!statusMeta(id).faded;
}

// ── 画布淡化（2026-09-24）────────────────────────────────────────────────────
/**
 * 淡化时的不透明度。
 * 取值依据：**看得出「退后了」，但仍读得清标签与图标**。
 * 太低（<0.3）会让用户以为数据丢了；太高（>0.6）则与其他实体区分不开。
 * ⚠️ 这是**视觉降权**，不是隐藏，更不是删除 —— 数据一律完整保留。
 */
export const FADED_ALPHA = 0.45;

/**
 * 画布上该用多少不透明度（0~1）。
 *
 * @param {string} id 实体状态
 * @param {{focused?: boolean}} [opts] `focused: true`（选中 / 悬停 / 匹配命中 / 拖拽中）
 *        → **不淡化**。理由：淡化是为了「一眼看出一堆实体里哪些已经不在叙事里」；
 *        而你一旦选中或悬停某个实体，说明你正在关注/编辑它 —— 此时把它弄模糊只会碍事。
 *        「编辑优先于装饰」。
 */
export function fadedAlpha(id, opts = {}) {
  if (opts && opts.focused) return 1;
  return isFaded(id) ? FADED_ALPHA : 1;
}

/** 供下拉使用的选项（含一个「（无）」以外的完整列表） */
export function statusOptions() {
  return ENTITY_STATUSES.map(s => ({ id: s.id, label: s.label, hint: s.hint }));
}

/** 徽标文本（`active` 返回空串 —— 正常状态不该有徽标，否则满屏噪音） */
export function statusBadge(id) {
  return statusMeta(id).short || '';
}
