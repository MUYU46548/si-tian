// src/ledger/replay.js — 回放：事件流 → 「某天每个省归谁」（**唯一实现**；2026-10-24）
//
// 口径（与 `utils/scenarioLedgerV2.deriveFrom` 逐省一致，由 `test_ledger_core.js` 的 a5 段对拍）：
//   · 基线：`epoch.baseline` 事件（day 0）里的 ownership 就是"本代开始时谁归谁"；
//   · 其后每条 `province.owner.changed` 覆盖该省的归属，`toPolityId: null` = **删键**（无主）；
//   · 同日多事件：按**流里的先后**（稳定排序只按 day），后写的赢 —— 与 v2 的 `cmpDate` + 稳定排序同义；
//   · `atDay` 缺省 = 回放到最后（终态）。
//
// 性能（判据：400 省 × 2000 事件 < 50ms）：单趟扫描、无深拷贝、只在需要时物化。
//   本仓调用点（装载 415 省 / 时间切片）都在毫秒级 —— 别在这里加"每事件重建副本"的写法。
//
// 🔴 纯数据层：不 import vue / store / 组件，不碰 DOM。

import { EVENT_BASELINE, EVENT_OWNER_CHANGED, dayOfDate, makeEvent, PROVENANCE } from './schema';

/** 取基线归属（`epoch.baseline` 是唯一一条；缺省返回空对象） */
export function baselineOwnership(ledger) {
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  for (const ev of events) {
    if (ev && ev.type === 'epoch.baseline') return { ...((ev.payload && ev.payload.ownership) || {}) };
  }
  return {};
}

/**
 * 把账本回放到某一天，返回 `{provinceId: polityId}`（**新对象**；无主的省不出现在结果里）。
 * @param {{events:Array}} ledger
 * @param {{atDay?:number}} [opts]
 */
export function projectOwnership(ledger, opts = {}) {
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  const atDay = Number.isFinite(opts.atDay) ? opts.atDay : Infinity;
  const out = {};
  // 1) 基线（day 0；即使 atDay < 0 也照样算 —— "本代开始时的状态"不是事件结果，是前提）
  for (const ev of events) {
    if (!ev || ev.type !== 'epoch.baseline') continue;
    const own = (ev.payload && ev.payload.ownership) || {};
    for (const pid of Object.keys(own)) {
      if (own[pid] !== null && own[pid] !== undefined) out[pid] = own[pid];
    }
  }
  // 2) 变更（只按 day 稳定排序：同日保持流内先后）
  const changes = [];
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || ev.type !== EVENT_OWNER_CHANGED) continue;
    if (Number.isFinite(ev.day) && ev.day > atDay) continue;
    changes.push({ ev, i });
  }
  changes.sort((a, b) => (a.ev.day - b.ev.day) || (a.i - b.i));
  for (const { ev } of changes) {
    const p = ev.payload || {};
    if (!p.provinceId) continue;
    if (p.toPolityId === null || p.toPolityId === undefined) delete out[p.provinceId];
    else out[p.provinceId] = p.toPolityId;
  }
  return out;
}

/** 某省在某天的归属（无主返回 null） */
export function ownerAt(ledger, provinceId, atDay) {
  if (!provinceId) return null;
  const own = projectOwnership(ledger, { atDay });
  return own[provinceId] === undefined ? null : own[provinceId];
}

/**
 * 两个归属表的差值（诊断/迁移核对用）：`{changed: [{provinceId, from, to}], onlyA, onlyB, same}`。
 * 口径："无主"= null（键不存在与值为 null 视为同一件事 —— 与 `deriveFrom` 的 delete 语义一致）。
 */
export function diffOwnership(a, b) {
  const A = a || {};
  const B = b || {};
  const pids = new Set([...Object.keys(A), ...Object.keys(B)]);
  const changed = [];
  for (const pid of pids) {
    const from = A[pid] === undefined ? null : A[pid];
    const to = B[pid] === undefined ? null : B[pid];
    if (from !== to) changed.push({ provinceId: pid, from, to });
  }
  const onlyA = Object.keys(A).filter((p) => !(p in B));
  const onlyB = Object.keys(B).filter((p) => !(p in A));
  return { changed, onlyA, onlyB, same: changed.length === 0 };
}

/**
 * **v2 形状适配器**：`initialOwnership + changeEvents` → 账本事件流。
 *
 * 为什么要有它：v2 的 `deriveFrom` 与本模块必须**同一条判定**。让 `deriveFrom` 走这里，
 * 就不会出现"回放两套实现、改一处另一处不变"的静默分裂（本仓最怕的那类事故）。
 * 事件的 `day` 由 `dayOfDate` 换算；`groupId` 记成 `v2:<pid>:<idx>`（便于追溯来源）。
 */
export function eventsFromV2(initialOwnership, changeEvents, opts = {}) {
  const { worldId = 'default', epochId = '', calendar = null } = opts;
  const used = new Set();                       // 同一账本内 id 必须唯一（makeEvent 用它递增）
  const mk = (draft) => {
    const ev = makeEvent(draft, { calendar, existingIds: used });
    used.add(ev.id);
    return ev;
  };
  const events = [
    mk({
      worldId, epochId, day: 0, type: EVENT_BASELINE, provenance: PROVENANCE.MIGRATE,
      payload: { ownership: { ...(initialOwnership || {}) } },
    }),
  ];
  for (const pid of Object.keys(changeEvents || {})) {
    const list = Array.isArray(changeEvents[pid]) ? changeEvents[pid] : [];
    list.forEach((ev, idx) => {
      const day = dayOfDate(ev, calendar);
      events.push(mk({
        worldId,
        epochId,
        day: day === null ? 0 : day,
        type: EVENT_OWNER_CHANGED,
        groupId: `v2:${pid}:${idx}`,
        provenance: (ev && ev.synthesized) ? PROVENANCE.MIGRATE : PROVENANCE.IMPORT,
        payload: {
          provinceId: pid,
          // from 在 v2 里没记（v2 只记"最后一条赢"），这里如实写 null 而不是编造
          fromPolityId: null,
          toPolityId: (ev && ev.owner !== undefined) ? ev.owner : null,
          synthesized: !!(ev && ev.synthesized),
        },
      }));
    });
  }
  return events;
}
