// src/ledger/groups.js — 「一笔」的原子撤销（2026-10-24 第 3 件）
//
// 为什么账本需要"组"：一次笔刷拖动会碰很多省，产出很多条 `province.owner.changed`。
// 撤销必须是**整笔一起退**（用户视角：我刚才涂的那一下没了），而不是退最后一条事件。
// 所以每条事件都带 `groupId`（= 这一笔的身份），撤销 = 把这一组事件从流里**整组摘下**。
//
// 两条硬口径（digest §3-①）：
//   ① **基线永不可撤**：`epoch.baseline` 没有 groupId，`removeGroup` 永远摘不到它 ——
//      这不是"约定"，是结构上没有入口（`groupIds` 只收有 groupId 的事件）。
//   ② **两栈不互相回滚**：账本组撤销只动账本；几何/河流/道路那些工具继续走 `store/undo.js`
//      的快照栈。本模块**不碰**那个栈（也不 import 它）。
//
// 🔴 纯数据层：不 import vue / store / 组件。

/** 账本里出现过的 groupId（按首次出现顺序；空 groupId 的事件 —— 基线、旧档单事件 —— 不算组） */
export function groupIds(ledger) {
  const out = [];
  const seen = new Set();
  for (const ev of (ledger && ledger.events) || []) {
    if (!ev || !ev.groupId || ev.type === 'epoch.baseline') continue;
    if (seen.has(ev.groupId)) continue;
    seen.add(ev.groupId);
    out.push(ev.groupId);
  }
  return out;
}

/** 某一组的事件（保持流内顺序）与它们第一次出现的位置 */
export function groupInfo(ledger, groupId) {
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  const picked = [];
  let index = -1;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || ev.groupId !== groupId) continue;
    if (index < 0) index = i;
    picked.push(ev);
  }
  const days = picked.map((e) => e.day).filter((d) => Number.isFinite(d));
  return {
    groupId,
    events: picked,
    index,
    count: picked.length,
    fromDay: days.length ? Math.min(...days) : null,
    toDay: days.length ? Math.max(...days) : null,
    provinces: [...new Set(picked.map((e) => e.payload && e.payload.provinceId).filter(Boolean))],
  };
}

/**
 * 摘下整组（撤销一笔）。返回新账本 + 被摘下的快照（redo 用）。
 * @returns {{ledger:object, removed:{groupId:string, events:Array, index:number}|null}}
 */
export function removeGroup(ledger, groupId) {
  if (!ledger || !groupId) return { ledger, removed: null };
  const info = groupInfo(ledger, groupId);
  if (!info.count) return { ledger, removed: null };
  const events = ledger.events.filter((ev) => ev && ev.groupId !== groupId);
  return {
    ledger: { ...ledger, events },
    removed: { groupId, events: info.events, index: info.index },
  };
}

/**
 * 把摘下的组放回去（重做一笔）。位置按 `index` 插（保持"流里的先后 = 事实的先后"）。
 * ⚠️ 位置越界会夹到末尾 —— 但只要撤销/重做是**成对**用的，index 一定落在原位。
 */
export function insertGroup(ledger, removed) {
  if (!ledger || !removed || !Array.isArray(removed.events) || !removed.events.length) return ledger;
  const events = ledger.events.slice();
  const at = Math.max(0, Math.min(Number.isInteger(removed.index) ? removed.index : events.length, events.length));
  events.splice(at, 0, ...removed.events);
  return { ...ledger, events };
}

/** 整个账本的分组清单（UI 的"最近做了什么"与诊断用） */
export function listGroups(ledger) {
  return groupIds(ledger).map((gid) => groupInfo(ledger, gid));
}
