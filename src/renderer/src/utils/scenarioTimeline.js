// utils/scenarioTimeline.js
// 历史剧本时间轴的纯函数层（无 DOM、无 Vue、无 store 依赖）
//
// 为什么需要它：
//   1. `era.startYear` / `endYear` 是**字符串且可为负**（'-1350' → '2138'），任何算术先解析。
//   2. 每个剧本的 polity id 都是全新的（pol_ou → pol_li → …），直接比 id 会得出
//      「每代 100% 省份全变」→ 差异图层零区分度。必须先把世代串成「谱系」。
//   3. 时代长度极不均（真朝 6 年 vs 炎太帝国 603 年）且**之间存在年份断层**，
//      按年线性排轨道会让短时代缩到 0.17% 宽。
//
// 谱系匹配：相邻剧本按**省份集合重叠度**降序贪心继承（一个前代集团只能被一个后代继承）。
// 人工纠正入口（优先于自动匹配）：
//   - polity.successorOf: 承自前代势力的 polity id（语义最自然）
//   - polity.lineage:     显式谱系标签（同名即同谱系）
//   - scenario.changeEvents[provId]: 显式易主**日期**列表（月日精度，见下）
//
// ⚠️ 谱系 id 一律为**字符串**。自动编号曾用数字而人工指定用字符串，
//    `'L0' !== 0` 恒真 → 人工纠正静默失效（实测踩过）。
//
// 🔴 月日精度（2026-10-05，《月日精度与切片书签》执行单）：
//    易主日期从 `changeYears[pid] = 1993`（年单值）升级为
//    `changeEvents[pid] = [{ y, m, d, owner }, …]`（**按日期升序的列表**，同省同年多次合法）。
//    `m`/`d` 可为 null，语义 = 该年 1 月 1 日。旧键 → 新键的迁移、比较、校验、格式化
//    全部在 `utils/scenarioDates.js`（**唯一实现**）——本模块只负责「谁在什么时候归谁」。
//    ⚠️ 剧本边界（startYear/endYear）仍保持**年精度**（刻意，防变更面无限扩大）。
import {
  parseYear, cmpDate, normalizeDate, normalizeScenarioDict,
  lastEventAtOrBefore, daysInMonth,
} from './scenarioDates';

export { parseYear };

/** 日精度阈值：年内插值的粒度。1/400 年 ≈ 一天，再细没有意义（且会让「同一天」判定抖动） */
const DAY_SCORE = 1 / 400;

/**
 * 数字年份（可为小数，年内插值用）→ 精确日期。
 * 小数部分按**天数线性**换算成月日 —— 与旧 `yearToU` 的年线性口径一致，
 * 只是把「半年」落到 7 月 1 日而不是继续显示成 2015.5（月日精度下后者已无意义）。
 * 负数年（公元前）不换算月日：负年没有「月份」的通用约定，给了反而是编的。
 */
export function yearValueToDate(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return { y: 0, m: null, d: null };
  const y = Math.floor(v);
  const frac = v - y;
  if (!(frac > 0) || y < 0) return { y, m: null, d: null };
  const days = Math.min(365, Math.max(1, Math.round(365.25 * frac) + 1));
  let rest = days;
  for (let m = 1; m <= 12; m++) {
    const dim = daysInMonth(y, m);
    if (rest <= dim) return { y, m, d: rest };
    rest -= dim;
  }
  return { y, m: 12, d: 31 };
}

/**
 * 日期 → 数字年份（可在年内插值）。轨道位置 / 播放进度都用它。
 * `yearValueToDate` 的逆（只到「年内第几天」的粒度，不保证逐位往返 —— 不必保证）。
 */
export function dateToYearValue(date) {
  const n = normalizeDate(date);
  if (!n) return 0;
  if (n.m === null) return n.y;
  let dayOfYear = 0;
  for (let m = 1; m < n.m; m++) dayOfYear += daysInMonth(n.y, m);
  dayOfYear += (n.d === null ? 1 : n.d);
  return n.y + Math.min(1, dayOfYear / 365.25);
}

/** 日期 → 展示文本（`1993` / `1993-05` / `1993-05-12`）；负数年显示「前N」 */
export { formatDate, dateKey, dateToken } from './scenarioDates';

/** 按 order 排序剧本（不改原数组） */
export function sortScenarios(scenarios) {
  return [...(scenarios || [])].sort(
    (a, b) => (a?.order ?? 0) - (b?.order ?? 0) || String(a?.id || '').localeCompare(String(b?.id || ''))
  );
}

/** 集团映射：{ polityId: [provinceId, ...] }（按 provinceId 排序，保证确定性） */
export function groupMap(scenario) {
  const g = {};
  const own = scenario?.ownership || {};
  for (const pid of Object.keys(own)) {
    const pol = own[pid];
    if (!pol) continue;
    (g[pol] || (g[pol] = [])).push(pid);
  }
  for (const k of Object.keys(g)) g[k].sort();
  return g;
}

function explicitLineageValues(scenarios) {
  const out = [];
  for (const s of scenarios) {
    for (const p of (s.polities || [])) {
      if (p && p.lineage !== undefined && p.lineage !== null && p.lineage !== '') out.push(String(p.lineage));
    }
  }
  return out;
}

/**
 * 谱系匹配。
 * @returns {{lineageOf: Array<Record<string,string>>, explicitCount: number}}
 */
export function computeLineage(scenarios) {
  const sorted = sortScenarios(scenarios);
  const lineageOf = [];
  let explicitCount = 0;
  const explicit = explicitLineageValues(sorted);
  let next = 0;

  const freshId = () => {
    let id = String(next++);
    while (explicit.includes(id)) id = String(next++);
    return id;
  };

  lineageOf[0] = {};
  for (const pol of Object.keys(groupMap(sorted[0]))) lineageOf[0][pol] = freshId();

  for (let k = 1; k < sorted.length; k++) {
    const gk = groupMap(sorted[k]);
    const gp = groupMap(sorted[k - 1]);
    lineageOf[k] = {};

    // ① 人工纠正优先
    for (const a of Object.keys(gk)) {
      const pd = (sorted[k].polities || []).find((x) => x.id === a);
      if (!pd) continue;
      if (pd.successorOf && Object.prototype.hasOwnProperty.call(lineageOf[k - 1], pd.successorOf)) {
        lineageOf[k][a] = lineageOf[k - 1][pd.successorOf];
        explicitCount++;
      } else if (pd.lineage !== undefined && pd.lineage !== null && pd.lineage !== '') {
        lineageOf[k][a] = String(pd.lineage);
        explicitCount++;
      }
    }

    // ② 其余按重叠度贪心继承
    const pairs = [];
    for (const a of Object.keys(gk)) {
      if (a in lineageOf[k]) continue;
      for (const b of Object.keys(gp)) {
        const setB = new Set(gp[b]);
        let ov = 0;
        for (const p of gk[a]) if (setB.has(p)) ov++;
        if (ov > 0) pairs.push([ov, a, b]);
      }
    }
    pairs.sort((x, y) => y[0] - x[0] || String(x[1]).localeCompare(String(y[1])));

    const usedB = new Set();
    for (const [, a, b] of pairs) {
      if (a in lineageOf[k]) continue;
      if (usedB.has(b)) continue;
      lineageOf[k][a] = lineageOf[k - 1][b];
      usedB.add(b);
    }
    for (const a of Object.keys(gk)) {
      if (!(a in lineageOf[k])) lineageOf[k][a] = freshId();
    }
  }

  return { lineageOf, explicitCount };
}

/**
 * 逐省谱系变化 + 变化**日期**（月日精度）。
 *
 * 变化省份 = 该省在本剧本继承到的谱系 ≠ 上一剧本的谱系
 * 变化事件 = `changeEvents[pid]`（显式，按日期升序、可多条）；
 *            缺省时在本剧本内**均匀铺开**一个合成日期（确定性，`{y, m:1, d:1}`）——
 *            「入库即显式、缺省运行时合成」这条语义不变，合成的日期在 `explicit[pid]` 上为 false。
 *
 * @returns {Array<{changed:string[], events:Array, firstDate:Object, lastDate:Object,
 *                  explicit:Record<string,boolean>, years:Array}>}
 *   `events` 元素 = `{ provinceId, y, m, d, owner, explicit, synthesized }`（**按日期升序**，
 *   同一天多条按 provinceId 稳定排序）。`lastDate[pid]` = 该省最后一条事件的日期
 *   （合成时就是那条合成日期）—— 旧代码里的 `e.year[pid]` 一律改读这里，
 *   **不再保留年份 map**（保留 = 第二事实源，月日精度会在两条路径上漂移）。
 */
export function computeEraChanges(scenarios, lineageOf, years) {
  const sorted = sortScenarios(scenarios);
  return sorted.map((s, k) => {
    const changed = [];
    const explicit = {};
    /** 省 → 该省在本剧本内的事件列表（升序） */
    const byProvince = {};
    const firstDate = {};
    const lastDate = {};
    if (k === 0) return { changed, events: [], byProvince, firstDate, lastDate, explicit };

    for (const pid of Object.keys(s.ownership || {})) {
      const lin = lineageOf[k][s.ownership[pid]];
      const prev = lineageOf[k - 1][sorted[k - 1].ownership?.[pid]];
      if (lin !== prev) changed.push(pid);
    }
    changed.sort();

    const y = years[k] || { start: 0, end: 0 };
    const span = y.end - y.start;
    const src = s.changeEvents || {};
    changed.forEach((pid, i) => {
      const raw = Array.isArray(src[pid]) ? src[pid] : null;
      const list = [];
      if (raw && raw.length) {
        for (const ev of raw) {
          const n = normalizeDate(ev);
          if (!n) continue;
          list.push({
            provinceId: pid,
            y: n.y, m: n.m, d: n.d,
            owner: ev.owner !== undefined && ev.owner !== null ? ev.owner : (s.ownership?.[pid] ?? null),
            explicit: true,
            synthesized: false,
          });
        }
      }
      if (!list.length) {
        // 合成值：与旧口径完全一致（区间内均匀铺开，只有年）→ 语义 = 该年 1 月 1 日
        const yv = y.start + Math.round(((i + 1) / (changed.length + 1)) * span);
        list.push({
          provinceId: pid, y: yv, m: null, d: null,
          owner: s.ownership?.[pid] ?? null, explicit: false, synthesized: true,
        });
      } else {
        explicit[pid] = true;
      }
      list.sort(cmpDate);
      byProvince[pid] = list;
      firstDate[pid] = list[0];
      lastDate[pid] = list[list.length - 1];
      for (const ev of list) {
        if (ev.explicit) explicit[pid] = true;
      }
    });

    // 帧索引要的是「所有事件按日期排序」的扁平表（同一天多省合并由 scenarioSlices 负责）
    const events = [];
    for (const pid of changed) for (const ev of (byProvince[pid] || [])) events.push(ev);
    events.sort((a, b) => cmpDate(a, b) || String(a.provinceId).localeCompare(String(b.provinceId)));

    return { changed, events, byProvince, firstDate, lastDate, explicit };
  });
}

/** 各剧本的年代区间（缺失/非法年份顺延前一个剧本的结束年，保证轨道连续） */
export function computeYears(scenarios) {
  const sorted = sortScenarios(scenarios);
  const years = [];
  let cursor = NaN;
  for (const s of sorted) {
    let a = parseYear(s?.era?.startYear);
    let b = parseYear(s?.era?.endYear);
    if (!Number.isFinite(a)) a = Number.isFinite(cursor) ? cursor : 0;
    if (!Number.isFinite(b) || b < a) b = a;
    years.push({ start: a, end: b, missing: !Number.isFinite(parseYear(s?.era?.startYear)) });
    cursor = b;
  }
  return years;
}

/** 年份断层：[{after, from, to}] */
export function computeGaps(years) {
  const gaps = [];
  for (let k = 1; k < years.length; k++) {
    if (years[k].start > years[k - 1].end) {
      gaps.push({ after: k - 1, from: years[k - 1].end, to: years[k].start });
    }
  }
  return gaps;
}

/** 谱系汇总（给 P2 面板用）：{id, name, eras:[k], provinces, explicit} */
export function summarizeLineages(scenarios, lineageOf) {
  const sorted = sortScenarios(scenarios);
  const byId = {};
  sorted.forEach((s, k) => {
    const names = {};
    for (const p of (s.polities || [])) names[p.id] = p.name || p.id;
    const g = groupMap(s);
    for (const polId of Object.keys(g)) {
      const lid = lineageOf[k][polId];
      if (lid === undefined) continue;
      const e = byId[lid] || (byId[lid] = {
        id: lid, name: '', eras: [], provinces: [], explicit: false, firstEra: k,
      });
      e.name = names[polId] || e.name;      // 取最后一次出现的名字
      e.eras.push(k);
      for (const pid of g[polId]) if (!e.provinces.includes(pid)) e.provinces.push(pid);
      const pd = (s.polities || []).find((x) => x.id === polId);
      if (pd && (pd.successorOf || (pd.lineage !== undefined && pd.lineage !== null && pd.lineage !== ''))) {
        e.explicit = true;
      }
    }
  });
  return Object.values(byId).sort((a, b) =>
    a.firstEra - b.firstEra || String(a.id).localeCompare(String(b.id)));
}

/**
 * 一次性构建时间轴模型。所有下游（组件 / 画布 / 面板）都吃这个对象。
 *
 * 🔴 入参先过 `normalizeScenarioDict`（`utils/scenarioDates.js` 的**唯一迁移实现**）：
 *    即使某个入口忘了迁移，时间轴自己也不会把旧 `changeYears` 当成新键读漏
 *    （表现为「明明录过易主日期，时间轴上却全是合成值」—— 静默、不报错）。
 *    无改动的剧本保持原引用，不会把整表换新对象。
 */
export function buildTimeline(scenarios) {
  const { scenarios: list } = normalizeScenarioDict(scenarios || []);
  const sorted = sortScenarios(list);
  const years = computeYears(sorted);
  const { lineageOf, explicitCount } = computeLineage(sorted);
  const eraChg = computeEraChanges(sorted, lineageOf, years);
  const gaps = computeGaps(years);
  const minYear = years.length ? years[0].start : 0;
  const maxYear = years.length ? years[years.length - 1].end : 0;
  const exEv = eraChg.reduce((a, e) => a + Object.keys(e.explicit || {}).length, 0);
  const evTotal = eraChg.reduce((a, e) => a + (e.events ? e.events.length : 0), 0);
  return {
    scenarios: sorted,
    years,
    lineageOf,
    eraChg,
    gaps,
    minYear,
    maxYear,
    explicitLineageCount: explicitCount,
    lineages: summarizeLineages(sorted, lineageOf),
    stats: {
      scenarios: sorted.length,
      provinces: sorted.length ? Object.keys(sorted[0].ownership || {}).length : 0,
      changes: eraChg.reduce((a, e) => a + e.changed.length, 0),
      changeEvents: evTotal,
      explicitChangeEvents: exEv,
      // 兼容别名（旧名字；含义已从「显式易主年份数」变为「有显式日期的省份数」）
      explicitChangeYears: exEv,
      missingYears: years.filter((y) => y.missing).length,
    },
  };
}

// ============================================================
// 年份 ↔ 轨道位置（两种轴向）
// ============================================================

/** 年份落在第几个剧本（最后一个 start <= year 的剧本；早于全部则 0） */
export function eraIndexOfYear(tl, year) {
  let k = 0;
  for (let i = 0; i < tl.years.length; i++) if (year >= tl.years[i].start) k = i;
  return k;
}

/** 年份是否落在断层里 */
export function findGap(tl, year) {
  for (const g of tl.gaps) if (year > g.from && year < g.to) return g;
  return null;
}

/** 年份 → 轨道位置 0..1。axisMode: 'year' 按年线性 | 'equal' 等宽 */
export function yearToU(tl, year, axisMode = 'year') {
  const n = tl.years.length;
  if (!n) return 0;
  if (axisMode === 'equal') {
    const k = eraIndexOfYear(tl, year);
    const { start, end } = tl.years[k];
    const t = Math.max(0, Math.min(1, (year - start) / Math.max(1, end - start)));
    return (k + t) / n;
  }
  const span = tl.maxYear - tl.minYear;
  return span > 0 ? Math.max(0, Math.min(1, (year - tl.minYear) / span)) : 0;
}

/** 轨道位置 0..1 → 年份（yearToU 的逆） */
export function uToYear(tl, u, axisMode = 'year') {
  const n = tl.years.length;
  if (!n) return 0;
  const uu = Math.max(0, Math.min(1, u));
  if (axisMode === 'equal') {
    const f = uu * n;
    const k = Math.min(n - 1, Math.floor(f));
    let t = f - k;
    if (k === n - 1) t = Math.min(1, t);
    const { start, end } = tl.years[k];
    return start + t * (end - start);
  }
  return tl.minYear + uu * (tl.maxYear - tl.minYear);
}

/** 轨道刻度：给出「好看」的年份步长（1/2/5×10^n） */
export function axisTicks(minYear, maxYear, target = 8) {
  const span = maxYear - minYear;
  if (!(span > 0)) return [minYear];
  const raw = span / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const rem = raw / pow;
  const step = (rem <= 1 ? 1 : rem <= 2 ? 2 : rem <= 5 ? 5 : 10) * pow;
  const out = [];
  for (let y = Math.ceil(minYear / step) * step; y <= maxYear; y += step) out.push(y);
  if (!out.length || out[out.length - 1] !== maxYear) out.push(maxYear);
  return out;
}

// ============================================================
// 归属查询（含「演变铺开」与 EU4 斜线占领）—— **月日精度**
// ============================================================
// 🔴 `atDate` 一律是 `{y, m?, d?}`（`m`/`d` 可缺省 = 该年 1 月 1 日）。
//    为兼容既有调用点，数字年份会被当作 `{y, m:null, d:null}` 处理（见 `asDate`）。
//    年份比较与日期比较在**缺省月日**时结果完全一致 —— 旧调用点的行为一行不变。

/** 宽松入参 → 日期对象：数字/字符串当年份，对象原样规整 */
function asDate(v) {
  if (v && typeof v === 'object') return normalizeDate(v);
  return normalizeDate({ y: v });
}

/**
 * 当前**实际**持有者的 {owner, era}（未落定 → 仍算旧主；era 用于在该剧本里查颜色）。
 *
 * 三态（月日精度带来的**新**语义，旧实现只有年份所以只有两态）：
 *   ① 该省在本剧本**有事件、且至少一条已落定** → 新主（`era = k`，颜色去本剧本查）；
 *   ② 有事件但**一条都还没落定**（查询日期早于第一条易主日）→ 仍是**上一代**的主
 *      （`era = k - 1`）。这一态是月日精度独有的：同一年里 6 月之前，6 月那次易主还没发生。
 *   ③ 本剧本没有该省的事件（无易主 / 无谱系变化）→ 本剧本的归属。
 * ⚠️ 同一省可能有多条事件（同省同年多次易主）→ 取**最后一条已落定**的 owner。
 */
export function currentOwnerRef(tl, k, pid, atDate) {
  if (k <= 0) return { owner: tl.scenarios[0]?.ownership?.[pid], era: 0 };
  const e = tl.eraChg[k];
  const at = asDate(atDate);
  if (e && e.byProvince && e.byProvince[pid]) {
    // `lastEventAtOrBefore` 已保证「事件日期 ≤ 查询日期」，所以只要非 null 就是已落定。
    // （早先这里多写了一次 `cmpDate(ev, at) <= 0`，等于重复判定；真正的漏洞是**漏了 null 分支**
    //   —— 没有任何事件落定时会直接返回本剧本的归属，于是「6 月易主、查 5 月」返回新主。
    //   纯函数用例 e1 抓到：期望旧主、实际新主。）
    const ev = lastEventAtOrBefore(e.byProvince[pid], at);
    if (ev) return { owner: ev.owner, era: k };
    // 有事件但都还没到 → 旧主（颜色必须去上一代查，跨代 polity id 不通用）
    return { owner: tl.scenarios[k - 1].ownership?.[pid], era: k - 1 };
  }
  return { owner: tl.scenarios[k].ownership?.[pid], era: k };
}

/** 该省在给定**日期**的真实归属（变化落定后为新主） */
export function currentOwnerAt(tl, k, pid, atDate) {
  return currentOwnerRef(tl, k, pid, atDate).owner;
}

/** EU4 斜线占领态：本剧本易主且已落定 → 底色保持旧主色，新主由斜线表达 */
export function isStriped(tl, k, pid, atDate) {
  if (k <= 0) return false;
  const e = tl.eraChg[k];
  if (!e || !e.byProvince || !e.byProvince[pid]) return false;
  return !!lastEventAtOrBefore(e.byProvince[pid], asDate(atDate));
}

/**
 * 底色归属的 **{owner, era}**：颜色必须在 owner 所属的那个剧本里查！
 * 真实数据每个剧本的 polity id 全新（pol_ou → pol_li），跨剧本用当前剧本查旧主
 * 会查不到 → 落到回退灰（实测：EU4 斜线变成「灰底 + 新主斜线」，观感全废）。
 */
export function baseOwnerRef(tl, k, pid, atDate) {
  if (k <= 0) return { owner: tl.scenarios[0]?.ownership?.[pid], era: 0 };
  const e = tl.eraChg[k];
  if (e && e.byProvince && e.byProvince[pid]) {
    // 未落定 → 仍是旧主；已落定（斜线占领）→ 底色刻意保持旧主
    return { owner: tl.scenarios[k - 1].ownership?.[pid], era: k - 1 };
  }
  return { owner: tl.scenarios[k].ownership?.[pid], era: k };
}

/** 画布底色用的归属 id（斜线占领态下刻意返回旧主） */
export function baseOwnerAt(tl, k, pid, atDate) {
  return baseOwnerRef(tl, k, pid, atDate).owner;
}

/** 该省在本剧本是否属于「谱系变化」集合 */
export function isChangedInEra(tl, k, pid) {
  const e = tl.eraChg[k];
  return !!e && e.changed.includes(pid);
}

/**
 * 该省在本剧本内的易主事件条数（HUD / 面板用）。
 * 同省同年多次易主是月日精度带来的新能力 → UI 要能说出「这个省在这一代换了 3 次」。
 */
export function eventCountInEra(tl, k, pid) {
  const e = tl.eraChg[k];
  return (e && e.byProvince && e.byProvince[pid]) ? e.byProvince[pid].length : 0;
}

/** 剧本内已落定的变化数（HUD 用） */
export function settledCount(tl, k, atDate) {
  const e = tl.eraChg[k];
  if (!e) return { settled: 0, total: 0 };
  const at = asDate(atDate);
  let settled = 0;
  for (const pid of e.changed) {
    const list = (e.byProvince && e.byProvince[pid]) || null;
    if (list && lastEventAtOrBefore(list, at)) settled++;
  }
  return { settled, total: e.changed.length };
}

/** 势力 → 色/名 查表（容错：缺失时给稳定回退值） */
export function polityOf(scenario, polityId) {
  return (scenario?.polities || []).find((p) => p.id === polityId) || null;
}

export function polityColor(scenario, polityId) {
  const p = polityOf(scenario, polityId);
  return p?.color || '#4a5568';
}

export function polityName(scenario, polityId) {
  const p = polityOf(scenario, polityId);
  return p?.name || (polityId || '（无主）');
}
