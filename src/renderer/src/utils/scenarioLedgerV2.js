// utils/scenarioLedgerV2.js — 剧本账本 v2 的**纯函数层**（2026-10-21，大修 B 第二块）
//
// v1 的形状：每代一份 `ownership`（终态快照）+ 少量 `changeEvents`（显式事件）。
// 回放要同时读两套结构；"事件是不是唯一事实源"永远说不清。
//
// v2 的形状（本模块负责推导，落盘由 `scripts/migrate-ledger-v2.mjs` 做）：
//   scenario.initialOwnership = { pid: owner|null }   // 本代**开始时**的归属
//   scenario.changeEvents     = { pid: [事件...] }    // 本代内事件（显式/合成）
//   scenario.ownership        = 派生缓存（加载时可从上面两项重建）
//
// 口径与 `scenarioTimeline.buildLedger` 完全一致：
//   · 有本代事件的省：initial = 上一代终态（era 0 = null 无主）；
//   · 没有事件的省：initial = 本代快照（本代开始时就是这个人）；
//   · 派生终态：initial 去掉 null，再逐省应用最后一条事件（owner=null 删除该键）。
//
// ⚠️ 本模块只做纯计算：不读盘、不碰 store、不改入参。
import { buildTimeline } from './scenarioTimeline';
import { cmpDate, normalizeDate } from './scenarioDates';

/**
 * 为整串剧本计算 v2 的 `initialOwnership`（不修改入参）。
 * @param {Array|Object} scenarios 数组或字典（`{id: scenario}`）
 * @returns {{list: Array, dict: Object|null, byId: Map, report: Object}}
 *   `list` = 新数组（每个剧本带 `initialOwnership` + `ledgerVersion: 2`）；
 *   `dict` = 输入是字典时同形返回；`report` = 清点（每代多少个 initial / 派生是否等于快照）。
 */
export function planLedgerV2(scenarios) {
  const isDict = !Array.isArray(scenarios) && scenarios && typeof scenarios === 'object';
  const input = isDict
    ? Object.keys(scenarios).map((k) => ({ ...(scenarios[k] || {}), __key: k }))
    : (scenarios || []).slice();
  const tl = buildTimeline(input.map((s) => {
    const { __key, ...rest } = s;   // eslint-disable-line no-unused-vars
    return rest;
  }));
  const list = [];
  const byId = new Map();
  let mismatchTotal = 0;
  const eras = [];
  tl.scenarios.forEach((s, k) => {
    const era = tl.ledger.eras[k];
    const initial = { ...era.initial };
    // v2 的事件表必须**包含合成事件**（没有显式日期、但谱系变了的省）——
    // 否则 initial + changeEvents 到不了快照。synthesized 标记随事件落盘，重载后仍是合成。
    const eventsV2 = {};
    for (const pid of Object.keys(era.byPid)) {
      eventsV2[pid] = era.byPid[pid].map((ev) => ({
        y: ev.y, m: ev.m, d: ev.d, owner: ev.owner,
        ...(ev.synthesized ? { synthesized: true } : { explicit: true }),
      }));
    }
    // 派生终态与快照比对（迁移前必须 0 mismatch）
    const derived = deriveFrom(initial, eventsV2);
    const stored = s.ownership || {};
    const pids = new Set([...Object.keys(derived), ...Object.keys(stored)]);
    const diffs = [];
    for (const pid of pids) {
      const a = derived[pid] === undefined ? null : derived[pid];
      const b = stored[pid] === undefined ? null : stored[pid];
      if (a !== b) diffs.push({ pid, derived: a, stored: b });
    }
    mismatchTotal += diffs.length;
    const out = { ...s, initialOwnership: initial, changeEvents: eventsV2, ledgerVersion: 2 };
    list.push(out);
    if (s.id) byId.set(s.id, out);
    eras.push({ id: s.id, name: s.name, initial: Object.keys(initial).length,
      events: Object.keys(eventsV2).length, mismatch: diffs.length, samples: diffs.slice(0, 3) });
  });
  const dict = isDict ? list.reduce((acc, s) => { acc[s.id] = s; return acc; }, {}) : null;
  return { list, dict, byId, report: { eras, mismatchTotal } };
}

/** 从 initial + changeEvents 派生 ownership（纯函数；owner=null 表示无主 → 删键） */
export function deriveFrom(initial, changeEvents) {
  const out = {};
  for (const pid of Object.keys(initial || {})) {
    if (initial[pid] !== null && initial[pid] !== undefined) out[pid] = initial[pid];
  }
  for (const pid of Object.keys(changeEvents || {})) {
    const arr = Array.isArray(changeEvents[pid]) ? changeEvents[pid].slice() : [];
    if (!arr.length) continue;
    arr.sort(cmpDate);
    const last = arr[arr.length - 1];
    if (last.owner === null || last.owner === undefined) delete out[pid];
    else out[pid] = last.owner;
  }
  return out;
}

/**
 * 从 v2 剧本派生 `ownership`（加载时用；返回新对象，不改入参）。
 * 没有 `initialOwnership` 的旧剧本原样返回 `ownership`（零迁移兼容）。
 */
export function deriveScenarioOwnership(scenario) {
  if (!scenario || !scenario.initialOwnership) {
    return scenario && scenario.ownership ? { ...scenario.ownership } : {};
  }
  return deriveFrom(scenario.initialOwnership, scenario.changeEvents || {});
}

/** 校验一个 v2 剧本：派生的 ownership 与落盘快照是否一致（返回冲突清单） */
export function verifyScenarioLedger(scenario) {
  if (!scenario || !scenario.initialOwnership) return { ok: false, reason: 'not-v2', diffs: [] };
  const derived = deriveScenarioOwnership(scenario);
  const stored = scenario.ownership || {};
  const pids = new Set([...Object.keys(derived), ...Object.keys(stored)]);
  const diffs = [];
  for (const pid of pids) {
    const a = derived[pid] === undefined ? null : derived[pid];
    const b = stored[pid] === undefined ? null : stored[pid];
    if (a !== b) diffs.push({ pid, derived: a, stored: b });
  }
  return { ok: diffs.length === 0, reason: diffs.length ? 'mismatch' : 'ok', diffs };
}

/** 事件日期是否会落在本剧本区间内（迁移/写口共用的边界提示，不参与判定） */
export function eventDateInEra(scenario, ev) {
  const n = normalizeDate(ev);
  if (!n) return false;
  const a = Number(scenario?.era?.startYear);
  const b = Number(scenario?.era?.endYear);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return n.y >= a && n.y <= b;
}
