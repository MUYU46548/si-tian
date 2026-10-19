// utils/interactionGate.js — 手势闸门：**人在画布上按住/拖动的时候，自动保存不许抢主线程**
//
// 为什么要有这个文件（第十九修·一，2026-10-19；数字见 docs/SITIAN_HANDOFF_20261019.md）：
//   实测（真实 `desite` 底图 / 200 省 / 载荷 2.07MB）：一次编辑之后，800ms 防抖到点时
//   主线程被**整块占住 519ms**；若那一刻用户还在拖鼠标，最长帧 **596ms**。
//   于是"连续拖笔已经从 29ms/事件 修到 2ms/事件"，手感**仍然会一顿** —— 那一顿就是它。
//   而这次保存**没有任何理由必须立刻发生**：它是防抖保存，不是用户按下的 Ctrl+S。
//   所以：**手势期间一律顺延**，抬手（+ 一点静默）后立刻补上。
//
// 三条口径（改这里之前必读）：
//   ① **闸门只影响"自动"保存**：用户显式保存 / 退出前 `flushSave()` / 关项目一律**不经过它**
//      —— 数据安全承诺（退出前落盘）优先于手感。
//   ② **必须有上限**（`SAVE_MAX_DEFER_MS`）：万一某个手势没配对（丢 mouseup、组件卸载、
//      程序化按下）把闸门卡在"进行中"，不能让保存**永远**顺延 —— 到点强制保存一次，
//      并记 `forced` 计数（用例据此判"真的会兜底"，而不是靠人记得）。
//   ③ **抬手后有静默窗口**（`INTERACTION_QUIET_MS`）：mouseup 那一刻还要提交这一笔
//      （压叠闸门 → undo → 全量写口），保存若恰好在同一拍插进去，等于把卡顿叠在收笔上。
//
// 判定不依赖墙钟时间语义（`defers` / `forced` / `maxDeferSeen` 是机械计数），
// 用例按计数判"闸门真的在生效"，不按"快了多少毫秒"判 —— 慢机器上时间断言会假红。

/** 抬手后静默这么久才允许保存（与 mouseup 里的收笔工作错开） */
export const INTERACTION_QUIET_MS = 60;
/** 被顺延后，隔多久再看一眼（也是抬手后补保存的最大延迟） */
export const SAVE_DEFER_RETRY_MS = 150;
/** 顺延上限：超过就强制保存一次（防"手势没配对"把保存饿死） */
export const SAVE_MAX_DEFER_MS = 5000;

let active = 0;             // 进行中的手势数（begin/end 必须配对）
let lastEndAt = 0;          // 最后一次抬手时刻（静默窗口用）
let peakActive = 0;         // 并发峰值（诊断用：>1 说明有嵌套手势）

const reasons = new Map();  // 进行中的手势来源（诊断用，只记计数）

export const interactionGateStats = {
  begins: 0,        // beginInteraction 次数
  ends: 0,          // endInteraction 次数
  unmatchedEnds: 0, // 没有对应 begin 的 end（说明配对错了，属实现缺陷信号）
  defers: 0,        // 自动保存被顺延的次数
  forced: 0,        // 顺延到上限后强制保存的次数
  maxDeferSeen: 0,  // 单次顺延的最长时长（ms）
};

/** 手势开始（按住/拖动）。reason 只用于诊断，例：'scenario-canvas' */
export function beginInteraction(reason = 'gesture') {
  active += 1;
  interactionGateStats.begins += 1;
  if (active > peakActive) peakActive = active;
  reasons.set(reason, (reasons.get(reason) || 0) + 1);
  return active;
}

/** 手势结束。没有对应 begin 时返回 false 并记 `unmatchedEnds`（不抛：别把收笔流程炸掉） */
export function endInteraction(reason = 'gesture') {
  lastEndAt = Date.now();
  if (active <= 0) {
    interactionGateStats.unmatchedEnds += 1;
    return false;
  }
  active -= 1;
  interactionGateStats.ends += 1;
  const n = (reasons.get(reason) || 0) - 1;
  if (n > 0) reasons.set(reason, n); else reasons.delete(reason);
  return true;
}

/** 现在是否"人手还在画布上"（含抬手后的静默窗口） */
export function isInteractionActive(now = Date.now()) {
  if (active > 0) return true;
  return now - lastEndAt < INTERACTION_QUIET_MS;
}

/** 进行中的手势数（不含静默窗口） */
export function activeInteractionCount() {
  return active;
}

/** 供用例/诊断复位（不要在业务代码里调用：那会让闸门失去意义） */
export function resetInteractionGate() {
  active = 0;
  lastEndAt = 0;
  peakActive = 0;
  reasons.clear();
  interactionGateStats.begins = 0;
  interactionGateStats.ends = 0;
  interactionGateStats.unmatchedEnds = 0;
  interactionGateStats.defers = 0;
  interactionGateStats.forced = 0;
  interactionGateStats.maxDeferSeen = 0;
}

export function describeInteractionGate(now = Date.now()) {
  return {
    active,
    peakActive,
    lastEndAt,
    quietLeftMs: Math.max(0, INTERACTION_QUIET_MS - (now - lastEndAt)),
    reasons: [...reasons.entries()],
    stats: { ...interactionGateStats },
  };
}

/**
 * 自动保存的「顺延判定器」。每个保存链一份（geodata / projectStore）。
 *
 * 用法（定时器到点时调用一次）：
 * ```js
 * const verdict = deferrer.check();
 * if (verdict === 'wait') { timer = setTimeout(run, SAVE_DEFER_RETRY_MS); return; }
 * // 'run' 正常保存；'forced' 顺延到上限了，**照常保存**（并已记 forced 计数）
 * ```
 * @param {{ maxDeferMs?: number }} [opts]
 */
export function createSaveDeferrer(opts = {}) {
  const maxDeferMs = opts.maxDeferMs || SAVE_MAX_DEFER_MS;
  let dueSince = 0;   // 首次"该保存了但被顺延"的时刻；0 = 没有在顺延中

  return {
    /** @returns {'run'|'wait'|'forced'} */
    check(now = Date.now()) {
      if (!isInteractionActive(now)) {
        dueSince = 0;
        return 'run';
      }
      if (!dueSince) dueSince = now;
      const waited = now - dueSince;
      if (waited >= maxDeferMs) {
        dueSince = 0;
        interactionGateStats.forced += 1;
        return 'forced';
      }
      interactionGateStats.defers += 1;
      if (waited > interactionGateStats.maxDeferSeen) interactionGateStats.maxDeferSeen = waited;
      return 'wait';
    },
    /** 已顺延多久（0 = 没在顺延） */
    get waitedMs() { return dueSince ? Date.now() - dueSince : 0; },
    /** 放弃当前顺延状态（真正保存过 / 没有东西要保存时调用） */
    reset() { dueSince = 0; },
  };
}
