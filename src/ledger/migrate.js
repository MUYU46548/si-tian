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
    // `explicit` / `synthesized` 的标记形状必须与迁移写盘时**完全一致**：
    //   · 装载口按 `JSON.stringify` 比对缓存与投影（见 `normalizeLedgerDict`）——
    //     少一个 `explicit: true` 就会被判成"缓存不一致"，每次打开项目都白重写一遍；
    //   · `scenarioSlices.changeDateStats` 也靠这个标记区分"显式 / 合成"，
    //     缺标记会把用户录的日期统计成"自动推算"（导出对话框的体检会误报）。
    if (p.synthesized) rec.synthesized = true; else rec.explicit = true;
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

// ============================================================
// 归属键迁移（第 4 件第二刀续，2026-10-24）
// ============================================================
//
// 为什么必须有这一层：改省界 / 合并 / 批量铺底 / 删省 / 删势力都会动归属的**键**（省份 id）。
// 只改 `ownership` / `changeEvents`（现状）会让"账本投影 == 缓存"这条前提断掉 ——
// 之后这个剧本的归属编辑会**永远**掉进降级分支：不写假账，但也再进不了账。
//
// 所以键迁移必须同时改四处：`ownership`、`initialOwnership`、`changeEvents`、账本（基线 payload + 事件 payload）。
// 这里四个纯函数（不改入参；**没有改动时返回原引用**，调用方可据此跳过写盘）：
//   · `remapOwnershipDict`   —— 归属字典（ownership / initialOwnership）的键改名 / 删除
//   · `remapChangeEventsDict`—— v2 事件表的键改名 / 删除
//   · `remapLedgerIds`       —— 账本：基线 payload 的键、事件 payload 的 provinceId
//   · `remapScenarioOwnership` —— 上面四件事一次做完（返回新剧本对象）
// 加两个"整段搬"的函数（拆分/铺底用）：
//   · `forkScenarioProvince` —— 一省拆多省：把源省的归属、事件、账本历史复制给新省
//   · `replaceProvinceEvents`—— 易主日期面板：整列表替换某省的显式事件（账本里的同一段）

/** 归一键迁移参数归一：`{provinceRename: {旧: 新}, provinceRemove: [id]}` */
function normRemap(opts = {}) {
  const rename = (opts.provinceRename && typeof opts.provinceRename === 'object') ? opts.provinceRename : {};
  const removeList = Array.isArray(opts.provinceRemove) ? opts.provinceRemove : [];
  return { rename, remove: new Set(removeList.map(String)) };
}

/** 映射一个省份 id：返回 null = 这个省没了；否则返回（可能改过名的）新 id */
function mapPid(pid, r) {
  const key = String(pid);
  if (r.remove.has(key)) return null;
  return Object.prototype.hasOwnProperty.call(r.rename, key) ? String(r.rename[key]) : pid;
}

/** 归属字典（`{省份 id: 势力 id}`）的键改名 / 删除（无改动返回原引用） */
export function remapOwnershipDict(dict, opts = {}) {
  const r = normRemap(opts);
  if (!dict || typeof dict !== 'object') return dict;
  if (!Object.keys(r.rename).length && !r.remove.size) return dict;
  let changed = false;
  const out = {};
  for (const pid of Object.keys(dict)) {
    const np = mapPid(pid, r);
    if (np === null) { changed = true; continue; }
    if (np !== pid) changed = true;
    out[np] = dict[pid];
  }
  return changed ? out : dict;
}

/** v2 事件表（`{省份 id: [事件...]}`）的键改名 / 删除（数组与事件对象**共享**，从不原地改） */
export function remapChangeEventsDict(changeEvents, opts = {}) {
  const r = normRemap(opts);
  if (!changeEvents || typeof changeEvents !== 'object') return changeEvents;
  if (!Object.keys(r.rename).length && !r.remove.size) return changeEvents;
  let changed = false;
  const out = {};
  for (const pid of Object.keys(changeEvents)) {
    const np = mapPid(pid, r);
    if (np === null) { changed = true; continue; }
    if (np !== pid) changed = true;
    out[np] = changeEvents[pid];
  }
  return changed ? out : changeEvents;
}

/**
 * 账本 → 键迁移后的账本（无改动返回原引用）。
 * 规则：
 *   · 基线 payload 的 ownership 键跟着改名 / 删除（"省没了"就不该在起点里）；
 *   · `province.owner.changed` 的 provinceId 跟着改名；省没了 → **整条事件摘掉**
 *     （留着的后果是：投影里那个省永不消失，缓存里却已经删了键）；
 *   · 其它事件类型一律原样（笔画事件不引用省份）。
 */
export function remapLedgerIds(ledger, opts = {}) {
  const r = normRemap(opts);
  if (!ledger || !Array.isArray(ledger.events)) return ledger;
  if (!Object.keys(r.rename).length && !r.remove.size) return ledger;
  let changed = false;
  const events = [];
  for (const ev of ledger.events) {
    if (!ev) { events.push(ev); continue; }
    if (ev.type === EVENT_BASELINE) {
      const own = (ev.payload && ev.payload.ownership) || {};
      const nextOwn = remapOwnershipDict(own, opts);
      if (nextOwn === own) { events.push(ev); continue; }
      changed = true;
      events.push({ ...ev, payload: { ...(ev.payload || {}), ownership: nextOwn } });
      continue;
    }
    if (ev.type === EVENT_OWNER_CHANGED) {
      const pid = ev.payload && ev.payload.provinceId;
      if (pid === undefined || pid === null) { events.push(ev); continue; }
      const np = mapPid(pid, r);
      if (np === null) { changed = true; continue; }
      if (np !== pid) {
        changed = true;
        events.push({ ...ev, payload: { ...ev.payload, provinceId: np } });
      } else events.push(ev);
      continue;
    }
    events.push(ev);
  }
  return changed ? { ...ledger, events } : ledger;
}

/** 四件事一次做完：`ownership` / `initialOwnership` / `changeEvents` / `ledger`（无改动返回原剧本） */
export function remapScenarioOwnership(scenario, opts = {}) {
  const sc = scenario || {};
  let out = sc;
  const put = (key, val) => {
    if (val === undefined || val === out[key]) return;
    if (out === sc) out = { ...sc };
    out[key] = val;
  };
  put('ownership', remapOwnershipDict(sc.ownership, opts));
  put('initialOwnership', remapOwnershipDict(sc.initialOwnership, opts));
  put('changeEvents', remapChangeEventsDict(sc.changeEvents, opts));
  put('ledger', remapLedgerIds(sc.ledger, opts));
  return out;
}

/**
 * 一省拆多省：把源省的归属 / 初始归属 / v2 事件 / 账本历史**复制**给新省。
 * 语义（与 `provinceEditing.buildOwnershipAfter` 一直以来的做法一致）：
 * 新省"继承"源省在拆分之前的全部历史；源省随后由 `remapScenarioOwnership(remove)` 摘掉。
 */
export function forkScenarioProvince(scenario, newId, srcId) {
  const sc = scenario || {};
  if (!newId || !srcId || String(newId) === String(srcId)) return sc;
  let out = sc;
  const touch = () => { if (out === sc) out = { ...sc }; };
  const has = (d, k) => !!d && Object.prototype.hasOwnProperty.call(d, k);
  if (has(sc.ownership, srcId)) { touch(); out.ownership = { ...sc.ownership, [newId]: sc.ownership[srcId] }; }
  if (has(sc.initialOwnership, srcId)) { touch(); out.initialOwnership = { ...sc.initialOwnership, [newId]: sc.initialOwnership[srcId] }; }
  if (has(sc.changeEvents, srcId) && Array.isArray(sc.changeEvents[srcId]) && sc.changeEvents[srcId].length) {
    touch();
    out.changeEvents = { ...sc.changeEvents, [newId]: sc.changeEvents[srcId].map((e) => ({ ...e })) };
  }
  const L = sc.ledger;
  if (L && Array.isArray(L.events)) {
    const events = [];
    let touched = false;
    for (const ev of L.events) {
      if (!ev) { events.push(ev); continue; }
      if (ev.type === EVENT_BASELINE) {
        const own = (ev.payload && ev.payload.ownership) || {};
        if (has(own, srcId) && !has(own, newId)) {
          touched = true;
          events.push({ ...ev, payload: { ...(ev.payload || {}), ownership: { ...own, [newId]: own[srcId] } } });
        } else events.push(ev);
        continue;
      }
      if (ev.type === EVENT_OWNER_CHANGED && ev.payload && String(ev.payload.provinceId) === String(srcId)) {
        // ⚠️ **保留源事件 + 追加副本**：一省拆多省时每个新省都要拿到这份历史。
        //    第一版写成"改名"（只 push 副本）→ 第一次 fork 就把源事件吃掉了，
        //    后面几个新省"没有历史"（投影里少一条，缓存里却有一份拷贝）。
        //    源省的事件随后由 `remapScenarioOwnership(remove)` 摘掉；副本必须换 id（同一账本内唯一）。
        touched = true;
        events.push(ev);
        events.push({ ...ev, id: `${ev.id}@${newId}`, payload: { ...ev.payload, provinceId: newId } });
        continue;
      }
      events.push(ev);
    }
    if (touched) { touch(); out.ledger = { ...L, events }; }
  }
  return out;
}

/**
 * 改写基线里**某一个省**的归属（`owner = null` = 从基线里摘掉）。
 *
 * 用途：易主日期面板的"清除显式日期"。v2 的语义是"这个省本代不再有显式易主，
 * 归属仍是当前这个（时间轴上改由谱系推算）" —— 账本里对应的唯一诚实表示就是
 * **本代开始时它就是这个主人**（`buildLedger` 对没有事件的省也是这个口径）。
 * ⚠️ 这不是"组撤销"能撤的东西：调用方必须自带整本账的引用快照（日期面板就是这么做的）。
 */
export function setLedgerBaselineOwner(ledger, provinceId, owner) {
  const L = ledger || {};
  const events = Array.isArray(L.events) ? L.events : [];
  const idx = events.findIndex((e) => e && e.type === EVENT_BASELINE);
  if (idx < 0) return L;
  const base = events[idx];
  const own = (base.payload && base.payload.ownership) || {};
  const has = Object.prototype.hasOwnProperty.call(own, provinceId);
  if (owner === null || owner === undefined) {
    if (!has) return L;
    const nextOwn = { ...own };
    delete nextOwn[provinceId];
    const nextEvents = events.slice();
    nextEvents[idx] = { ...base, payload: { ...(base.payload || {}), ownership: nextOwn } };
    return { ...L, events: nextEvents };
  }
  if (has && own[provinceId] === owner) return L;
  const nextEvents = events.slice();
  nextEvents[idx] = { ...base, payload: { ...(base.payload || {}), ownership: { ...own, [provinceId]: owner } } };
  return { ...L, events: nextEvents };
}

/**
 * 整列表替换某省的**显式**易主事件（易主日期面板 / 批量定日期的落库口）。
 * 账本口径：先摘掉这个省的全部 `province.owner.changed`（含合成/笔刷来源），
 * 再按 `list` 逐条追加（provenance 由调用方给，groupId = 这次编辑）。
 * 返回 `{ ledger, added }`；`list` 为空 = 这个省回到"只有基线"（= 无易主）。
 */
export function replaceProvinceEvents(ledger, provinceId, list, opts = {}) {
  const L = ledger || {};
  const events = Array.isArray(L.events) ? L.events : [];
  const keep = events.filter((ev) => !(ev && ev.type === EVENT_OWNER_CHANGED
    && ev.payload && String(ev.payload.provinceId) === String(provinceId)));
  const ids = new Set(keep.map((ev) => ev && ev.id).filter(Boolean));
  const cal = opts.calendar || L.calendar;
  const out = [];
  for (const item of (Array.isArray(list) ? list : [])) {
    const day = dayOfDate(item, cal);
    const ev = makeOwnerChanged({
      worldId: L.worldId,
      epochId: L.epochId,
      day,
      date: item,
      provinceId,
      fromPolityId: null,          // 面板只给"那天归谁"，不给"从谁手里"——不编造
      toPolityId: (item && item.owner !== undefined) ? item.owner : null,
      groupId: String(opts.groupId || ''),
      provenance: opts.provenance || PROVENANCE.UI,
      calendar: cal,
      existingIds: ids,
    });
    ids.add(ev.id);
    out.push(ev);
  }
  return { ledger: { ...L, events: keep.concat(out) }, added: out.length };
}
