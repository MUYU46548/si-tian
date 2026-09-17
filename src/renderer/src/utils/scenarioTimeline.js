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
//   - polity.successorOf: 承自某前代势力的 polity id（语义最自然）
//   - polity.lineage:     显式谱系标签（同名即同谱系）
//   - scenario.changeYears[provId]: 显式易主年份
//
// ⚠️ 谱系 id 一律为**字符串**。自动编号曾用数字而人工指定用字符串，
//    `'L0' !== 0` 恒真 → 人工纠正静默失效（实测踩过）。

/** 解析年份：字符串/数字/负值都吃，失败返回 NaN */
export function parseYear(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

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
 * 逐省谱系变化 + 变化年份。
 * 变化省份 = 该省在本剧本继承到的谱系 ≠ 上一剧本的谱系
 * 变化年份 = 显式 changeYears[provId] 优先；缺省时在本剧本内均匀铺开（确定性）
 */
export function computeEraChanges(scenarios, lineageOf, years) {
  const sorted = sortScenarios(scenarios);
  return sorted.map((s, k) => {
    const changed = [];
    const year = {};
    const explicit = {};
    if (k === 0) return { changed, year, explicit };

    for (const pid of Object.keys(s.ownership || {})) {
      const lin = lineageOf[k][s.ownership[pid]];
      const prev = lineageOf[k - 1][sorted[k - 1].ownership?.[pid]];
      if (lin !== prev) changed.push(pid);
    }
    changed.sort();

    const y = years[k] || { start: 0, end: 0 };
    const span = y.end - y.start;
    const byId = s.changeYears || {};
    changed.forEach((pid, i) => {
      const v = byId[pid];
      if (typeof v === 'number' && Number.isFinite(v)) {
        year[pid] = v;
        explicit[pid] = true;
      } else {
        year[pid] = y.start + Math.round(((i + 1) / (changed.length + 1)) * span);
      }
    });

    return { changed, year, explicit };
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
 */
export function buildTimeline(scenarios) {
  const sorted = sortScenarios(scenarios);
  const years = computeYears(sorted);
  const { lineageOf, explicitCount } = computeLineage(sorted);
  const eraChg = computeEraChanges(sorted, lineageOf, years);
  const gaps = computeGaps(years);
  const minYear = years.length ? years[0].start : 0;
  const maxYear = years.length ? years[years.length - 1].end : 0;
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
      explicitChangeYears: eraChg.reduce((a, e) => a + Object.keys(e.explicit).length, 0),
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
// 归属查询（含「演变铺开」与 EU4 斜线占领）
// ============================================================

/** 当前**实际**持有者的 {owner, era}（未落定 → 仍算旧主；era 用于在该剧本里查颜色） */
export function currentOwnerRef(tl, k, pid, year) {
  if (k <= 0) return { owner: tl.scenarios[0]?.ownership?.[pid], era: 0 };
  const e = tl.eraChg[k];
  if (e && e.year[pid] !== undefined && year < e.year[pid]) {
    return { owner: tl.scenarios[k - 1].ownership?.[pid], era: k - 1 };
  }
  return { owner: tl.scenarios[k].ownership?.[pid], era: k };
}

/** 该省在当前年份的**真实**归属（变化落定后为新主） */
export function currentOwnerAt(tl, k, pid, year) {
  return currentOwnerRef(tl, k, pid, year).owner;
}

/** EU4 斜线占领态：本剧本易主且已落定 → 底色保持旧主色，新主由斜线表达 */
export function isStriped(tl, k, pid, year) {
  if (k <= 0) return false;
  const e = tl.eraChg[k];
  return !!e && e.year[pid] !== undefined && year >= e.year[pid];
}

/**
 * 底色归属的 **{owner, era}**：颜色必须在 owner 所属的那个剧本里查！
 * 真实数据每个剧本的 polity id 全新（pol_ou → pol_li），跨剧本用当前剧本查旧主
 * 会查不到 → 落到回退灰（实测：EU4 斜线变成「灰底 + 新主斜线」，观感全废）。
 */
export function baseOwnerRef(tl, k, pid, year) {
  if (k <= 0) return { owner: tl.scenarios[0]?.ownership?.[pid], era: 0 };
  const e = tl.eraChg[k];
  if (e && e.year[pid] !== undefined) {
    // 未落定 → 仍是旧主；已落定（斜线占领）→ 底色刻意保持旧主
    if (year < e.year[pid]) return { owner: tl.scenarios[k - 1].ownership?.[pid], era: k - 1 };
    return { owner: tl.scenarios[k - 1].ownership?.[pid], era: k - 1 };
  }
  return { owner: tl.scenarios[k].ownership?.[pid], era: k };
}

/** 画布底色用的归属 id（斜线占领态下刻意返回旧主） */
export function baseOwnerAt(tl, k, pid, year) {
  return baseOwnerRef(tl, k, pid, year).owner;
}

/** 该省在本剧本是否属于「谱系变化」集合 */
export function isChangedInEra(tl, k, pid) {
  const e = tl.eraChg[k];
  return !!e && e.changed.includes(pid);
}

/** 剧本内已落定的变化数（HUD 用） */
export function settledCount(tl, k, year) {
  const e = tl.eraChg[k];
  if (!e) return { settled: 0, total: 0 };
  let settled = 0;
  for (const pid of e.changed) if (year >= e.year[pid]) settled++;
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
