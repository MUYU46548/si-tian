// src/ledger/migrate.js — 旧档（账本 v2 形状）→ 账本事件流（2026-10-24 第 3 件）
//
// v2 的形状（现状，415 省项目已经是它）：
//   scenario.initialOwnership = { pid: owner|null }       // 本代开始时的归属
//   scenario.changeEvents     = { pid: [{y,m,d?,owner,synthesized?}] }  // 按省分组、按年月日记
//   scenario.ownership        = 派生缓存（由上面两项算出）
//
// 迁移目标（digest §3-①/②）：
//   · 一个剧本 = 一个账本段（epochId = 剧本键），day = 该剧本内的绝对日（可负）；
//   · `initialOwnership` → 一条 `epoch.baseline`（day 0，**不可撤**）；
//   · `changeEvents[i]` → `province.owner.changed`（`provenance: import`，合成事件 `migrate`；
//     groupId 按「同省 / 同日」聚合 —— 同一天同一省的多个改动本来就是一次操作的结果）。
//
// 🔴 迁移必须**无损可核对**：`projectOwnership(迁移结果)` 必须与迁移前的 `ownership` **逐省相等**，
//    不等就拒绝（宁可不动，也不写一份自相矛盾的数据）。核对函数见 `verifyMigration`。
//
// 🔴 纯数据层：不 import vue / store / 组件。

import { createLedger, dayOfDate, dateOfDay, EVENT_BASELINE, EVENT_OWNER_CHANGED, makeEvent, normalizeCalendar, PROVENANCE } from './schema';
import { eventsFromV2, projectOwnership, diffOwnership, baselineOwnership } from './replay';

/** 剧本键 → epochId（既有的剧本键就是 `底图名/剧本名`；没有键时退回 id/名字） */
export function epochIdOfScenario(scenario, fallbackKey = '') {
  const sc = scenario || {};
  return String(sc.id || sc.key || fallbackKey || sc.name || 'epoch');
}

/**
 * 把 v2 剧本迁成账本（**不改入参**）。
 *
 * @param {object} scenario v2 剧本（`{initialOwnership, changeEvents, ownership, era?}`）
 * @param {{worldId?:string, epochId?:string, calendar?:object}} [opts]
 * @returns {{ledger:object, report:object}}
 */
export function fromV2Scenario(scenario, opts = {}) {
  const sc = scenario || {};
  const cal = normalizeCalendar(opts.calendar);
  const epochId = opts.epochId || epochIdOfScenario(sc);
  const worldId = opts.worldId || 'default';
  // 没有 initialOwnership 的 v2-less 剧本：把 ownership 当基线（本代开始时就是它）
  const initial = sc.initialOwnership || (sc.ownership ? { ...sc.ownership } : {});
  const events = eventsFromV2(initial, sc.changeEvents || {}, { worldId, epochId, calendar: cal });
  const ledger = createLedger({ worldId, epochId, calendar: cal, events });
  return {
    ledger,
    report: {
      epochId,
      baseline: Object.keys(initial).length,
      events: events.length - 1,
      groups: new Set(events.filter((e) => e.groupId).map((e) => e.groupId)).size,
      dayRange: events.length > 1
        ? [Math.min(...events.slice(1).map((e) => e.day)), Math.max(...events.slice(1).map((e) => e.day))]
        : [0, 0],
      // v1（连 initialOwnership 都没有）在迁移时只能落成"基线 = 快照"，没有事件 —— 如实标记
      source: sc.initialOwnership ? 'v2' : 'v1-snapshot-as-baseline',
    },
  };
}

/**
 * 无损核对：迁移出来的账本回放出的归属 vs 剧本里那份缓存，逐省比对。
 * @returns {{ok:boolean, diffs:Array, checked:number}}
 */
export function verifyMigration(scenario, ledger) {
  const sc = scenario || {};
  const derived = projectOwnership(ledger);
  const cached = sc.ownership || {};
  const d = diffOwnership(derived, cached);
  return { ok: d.same, diffs: d.changed.slice(0, 20), diffCount: d.changed.length, checked: Object.keys(cached).length };
}

/** 两条 v2 事件是否"同一天"（月/日缺省按 1 —— 与 `scenarioDates.dateKey` 同口径） */
function sameV2Day(a, b) {
  const m = (e) => (e.m === null || e.m === undefined ? 1 : Number(e.m));
  const d = (e) => (e.d === null || e.d === undefined ? 1 : Number(e.d));
  return Number(a.y) === Number(b.y) && m(a) === m(b) && d(a) === d(b);
}

/**
 * 反向投影：账本 → v2 形状（`{initialOwnership, changeEvents, ownership}`）。
 *
 * 为什么需要：M1 阶段 UI 仍读 v2 缓存（`initialOwnership`/`changeEvents`/`ownership`），
 * 归属写口落完账本要用这个函数把缓存**重算**一遍 —— 保证"缓存是投影，不是第二本账"。
 *
 * 三条口径（2026-10-24 第 4 件第二刀补齐）：
 *   ① **月日不能丢**：事件里优先用 `payload.at`（写口当时给的 `{y,m,d}`；
 *      账本自己的 `day` 只到"年内第几天"，`m/d` 缺省与否要还原成 v2 的原形）；
 *      没有 `at` 的（迁移出来的）按账本的历法用 `dateOfDay` 换算 —— **不再写死 360**。
 *   ② **合成事件照旧保留**（`synthesized: true`）：v2 的事实源是"基线 + 事件"，
 *      把合成事件丢掉会让重载后的时间轴少掉"这一代这个省变过"（终态碰巧一样，切片不一样）。
 *   ③ **同一天只留最后一条**：v2 的 `findEventIndex` 认"同日即同一条"，
 *      而账本允许同日多条（一条流里都诚实保留）—— 投影到 v2 时按 v2 的口径收成一条。
 */
export function toV2Projection(ledger) {
  const events = (ledger && Array.isArray(ledger.events)) ? ledger.events : [];
  const cal = normalizeCalendar(ledger && ledger.calendar);
  const initialOwnership = baselineOwnership(ledger);
  const changeEvents = {};
  for (const ev of events) {
    if (!ev || ev.type !== EVENT_OWNER_CHANGED) continue;
    const p = ev.payload || {};
    if (!p.provinceId) continue;
    const at = p.at && Number.isFinite(Number(p.at.y)) ? p.at : (dateOfDay(ev.day, cal) || { y: 0, m: null, d: null });
    const rec = {
      y: Number(at.y),
      m: at.m === undefined ? null : at.m,
      d: at.d === undefined ? null : at.d,
      owner: p.toPolityId === undefined ? null : p.toPolityId,
    };
    if (p.synthesized) rec.synthesized = true;   // 显式事件**不加**标志（与新旧写口的历史形状一致）
    const list = changeEvents[p.provinceId] || (changeEvents[p.provinceId] = []);
    const at2 = list.findIndex((e) => sameV2Day(e, rec));
    if (at2 >= 0) list[at2] = rec; else list.push(rec);
  }
  for (const pid of Object.keys(changeEvents)) {
    const m = (e) => (e.m === null || e.m === undefined ? 1 : Number(e.m));
    const d = (e) => (e.d === null || e.d === undefined ? 1 : Number(e.d));
    changeEvents[pid].sort((a, b) => (Number(a.y) - Number(b.y)) || (m(a) - m(b)) || (d(a) - d(b)));
  }
  return { initialOwnership, changeEvents, ownership: projectOwnership(ledger) };
}

/**
 * 整份剧本字典的迁移计划（dry-run 用；**不写盘**）。
 * @returns {{ledgers:Object, report:Object}} report 里每段带 mismatch 数
 */
export function planMigration(dict, opts = {}) {
  const out = {};
  const eras = [];
  let mismatchTotal = 0;
  for (const key of Object.keys(dict || {})) {
    const sc = dict[key];
    if (!sc || (!sc.initialOwnership && !sc.ownership)) continue;
    const { ledger, report } = fromV2Scenario(sc, { ...opts, epochId: opts.epochId || key });
    const v = verifyMigration(sc, ledger);
    mismatchTotal += v.diffCount;
    out[key] = ledger;
    eras.push({ key, ...report, mismatch: v.diffCount, samples: v.diffs.slice(0, 3) });
  }
  return { ledgers: out, report: { eras, mismatchTotal } };
}

/** 生成"某省某天归谁"的一条事件（写口用；groupId 由调用方给 = 这一笔的身份） */
export function makeOwnerChanged({ worldId = 'default', epochId = '', date = null, day = null, provinceId, fromPolityId = null, toPolityId = null, groupId = '', provenance = PROVENANCE.UI, calendar = null, existingIds = null, id = '' } = {}) {
  const d = Number.isFinite(day) ? Math.trunc(day) : dayOfDate(date, calendar);
  // `payload.at` = 写口当时给的**月日原形**（`m/d` 缺省就留 null）。为什么要留：
  // `day` 只到"年内第几天"，反投影回 v2 时把 `{y:1050,m:null,d:null}` 还原成
  // "1050 年 1 月 1 日"会让事件表显示成用户没录过的月日（口径没变、观感变脏）。
  const at = (date && typeof date === 'object' && Number.isFinite(Number(date.y)))
    ? { y: Number(date.y), m: date.m === undefined ? null : date.m, d: date.d === undefined ? null : date.d }
    : null;
  return makeEvent({
    id,
    worldId,
    epochId,
    day: Number.isFinite(d) ? d : 0,
    type: EVENT_OWNER_CHANGED,
    groupId,
    provenance,
    payload: { provinceId, fromPolityId, toPolityId, ...(at ? { at } : {}) },
  }, { calendar, existingIds: existingIds || [] });
}
