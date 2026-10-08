// utils/heightmapChannels.js — 高度图上「逐格 Uint8 通道」（文化 / 宗教）的**纯逻辑**
//
// ── 为什么要有这一层（2026-10-08）─────────────────────────────────────────────
// 文化 / 宗教在数据上就是与 `biome` 同构的「每格一个下标」（`Uint8Array`，0 = 无主），
// 但此前只有剧本侧能涂（`scenarioEditing.applyCultureBrush`），行星主编辑器没有入口。
// 把能力搬到行星侧时，有三个口径必须在**一处**定义，否则就会分叉：
//   ① 落盘/读回后数组的**归一化**（TypedArray ↔ 普通数组 ↔ JSON 退化的 `{0:..}`）
//   ② 通道 ↔ 元数据列表（`mapData[pid].cultures` / `.religions`）的对应关系
//   ③ 「无主」（下标 0）该显示成什么颜色
//
// ⚠️ 本文件**只放纯函数**（不碰 Vue / 不碰 store），Node 侧可直接单测
//    （`scripts/tests/unit/test_heightmap_channels.js`）。

/** 通道名。顺序即通道在元数据里的对应顺序（与 `mapData[pid]` 的列表键一一对应） */
export const CHANNEL_KEYS = ['culture', 'religion'];

/** 通道 → 人类可读名（UI / 提示文案的**唯一**来源，不要在组件里再写一遍） */
export const CHANNEL_LABELS = {
  culture: '文化',
  religion: '宗教',
};

/** 通道 → 行星侧元数据列表所在的键 */
export const CHANNEL_LIST_KEY = {
  culture: 'cultures',
  religion: 'religions',
};

/** 「无主」（下标 0）的底色 —— 中性灰，便于与有主区域区分但又不抢视线 */
export const CHANNEL_UNASSIGNED_HEX = '#e8e6e0';

/** 通道下标的硬上限（Uint8Array 装得下，但列表不该无限长） */
export const CHANNEL_MAX_INDEX = 255;

export function isChannelKey(key) {
  return CHANNEL_KEYS.indexOf(key) >= 0;
}

/**
 * 把 `hm[channel]` 归一化成长度正确的 `Uint8Array`。
 *
 * 🔴 为什么不能只判 `instanceof Uint8Array`：`jsonSafeReplacer` 落盘时把 TypedArray 转成
 *    **普通数组**（读回是 `Array`），而历史事故里还出现过结构化克隆后的 `{"0":..}`（**无 length**）——
 *    后者直接 `new Uint8Array(obj)` 得到空数组，等于静默丢光整层数据。
 *    这里三态都收：TypedArray / Array / 数字键对象，**能救就救，救不了才返回 null**
 *    （返回 null 让调用方决定是报错还是重建，绝不在这一层悄悄造零值）。
 *
 * @param {*} raw 落盘/读回的原始值
 * @param {number} count 期望长度（= `grid.points.length`）
 * @returns {Uint8Array|null}
 */
export function normalizeChannel(raw, count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!raw) return null;

  if (typeof raw.length === 'number') {
    if (raw.length !== n) return null;
    return (raw instanceof Uint8Array) ? raw : Uint8Array.from(raw, (v) => (Number(v) || 0) & 0xff);
  }

  if (typeof raw === 'object') {
    // JSON 往返退化形态 `{0:..}`：键数对得上就能原样救回，不必丢数据
    const keys = Object.keys(raw);
    if (keys.length !== n) return null;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      out[i] = v & 0xff;
    }
    return out;
  }

  return null;
}

/** 读某一格的通道值（越界/缺失一律 0 = 无主，不抛） */
export function channelValueAt(hm, channel, index) {
  const arr = hm && hm[channel];
  if (!arr || index < 0 || index >= arr.length) return 0;
  return arr[index] | 0;
}

/**
 * 列表里「下一个可用的**位置**」—— 通道值就是**位置**（1 起），不是元数据的 `id`。
 *
 * 🔴 为什么不能用 `id`：`mapData[pid].cultures` 里的 `id` 是 `Date.now()`（`NodeDetailPanel`
 *    建文化时就是这么写的，见该组件 `createCulture`）。时间戳 1.7e12 塞进 `Uint8Array`
 *    会被截成低 8 位 —— 那是**静默的数据错乱**（两个文化抢同一个下标、颜色名字全乱、不报错）。
 *    所以通道值一律取「列表位置」，并且上限 255（`CHANNEL_MAX_INDEX`）。
 */
export function nextChannelIndex(list) {
  const n = Array.isArray(list) ? list.length : 0;
  return Math.min(n + 1, CHANNEL_MAX_INDEX);
}

/** 通道值（位置，1 起）→ 元数据条目；0 或越界返回 null */
export function channelEntryAt(list, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 1) return null;
  const items = Array.isArray(list) ? list : [];
  return items[v - 1] || null;
}

