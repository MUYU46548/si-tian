// src/ledger/index.js — 账本引擎的公开面（2026-10-24 第 3 件）
//
// 使用顺序（M1）：
//   const { ledger } = fromV2Scenario(scenario, { epochId: key })   // 装载/迁移
//   const own = projectOwnership(ledger, { atDay })                 // 回放（唯一实现）
//   const { ledger: after, removed } = removeGroup(ledger, groupId) // 撤销一笔
//   insertGroup(after, removed)                                     // 重做一笔
//
// 🔴 纯数据层：不 import vue / store / 组件（`test_ledger_core.js` a6 段读源码守）。
// 🔴 判定"某省某天归谁"只有 `replay.projectOwnership` 一份实现；
//    `utils/scenarioLedgerV2.deriveFrom` 是它的 v2 形状适配器（见该文件注释）。

export {
  LEDGER_VERSION,
  DEFAULT_CALENDAR,
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  EVENT_BASELINE,
  EVENT_OWNER_CHANGED,
  PROVENANCE,
  normalizeCalendar,
  dayOfDate,
  dateOfDay,
  makeEvent,
  makeEventId,
  validateEvent,
  createLedger,
} from './schema';

export {
  baselineOwnership,
  projectOwnership,
  ownerAt,
  diffOwnership,
  eventsFromV2,
} from './replay';

export {
  groupIds,
  groupInfo,
  listGroups,
  removeGroup,
  insertGroup,
} from './groups';

export {
  epochIdOfScenario,
  fromV2Scenario,
  verifyMigration,
  toV2Projection,
  planMigration,
  makeOwnerChanged,
} from './migrate';

import { createLedger, validateEvent } from './schema';

/**
 * 账本形状自检（装载/落盘前调用）：返回 `{ok, problems[]}`，**不抛错**。
 * 判据只查"结构能不能用"：有 epochId、基线恰好一条、事件形状合法。
 */
export function assertLedgerShape(ledger) {
  const problems = [];
  if (!ledger || typeof ledger !== 'object') return { ok: false, problems: ['账本不是对象'] };
  if (!ledger.epochId) problems.push('缺 epochId');
  const events = Array.isArray(ledger.events) ? ledger.events : null;
  if (!events) problems.push('events 不是数组');
  else {
    const baselines = events.filter((e) => e && e.type === 'epoch.baseline');
    if (baselines.length !== 1) problems.push(`epoch.baseline 必须恰好一条（实际 ${baselines.length}）`);
    events.forEach((ev, i) => {
      const v = validateEvent(ev);
      if (!v.ok) problems.push(`第 ${i} 条：${v.errors.join('；')}`);
    });
  }
  return { ok: problems.length === 0, problems };
}

/** 空账本（新剧本从零开始；基线为空 = 谁都不属于任何人） */
export function makeEmptyLedger({ worldId = 'default', epochId = '', calendar = null } = {}) {
  const base = createLedger({ worldId, epochId, calendar });
  base.events.push({
    id: 'ev-baseline', worldId: base.worldId, epochId: base.epochId, day: 0,
    type: 'epoch.baseline', groupId: '', provenance: 'migrate',
    payload: { ownership: {} }, ledgerVersion: base.ledgerVersion,
  });
  return base;
}
