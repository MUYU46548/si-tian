// utils/scenarioSlices.js
// 历史剧本「逐年切片导出」的纯函数层（无 DOM、无 Vue、无 store 依赖）
//
// 为什么需要它：
//   ① 「哪些时刻各出一帧」是一个**判定**，不是遍历结果 —— 真实数据 12 剧本 / 3488 年，
//      按年出帧 = 3488 张（没人要）；按「状态真的变了」出帧 ≈ 十张出头。
//      这个判定若写在组件里，导出对话框与导出链就各有一份（本仓已三次踩到「改一处另一处不变」）。
//   ② 切片能不能信，取决于**日期是不是真的**：`computeEraChanges` 在缺显式值时会在本剧本
//      区间内**均匀铺开**一个合成日期（确定性、看起来很像真的）。于是「切片很漂亮」与
//      「这些日期是编的」可以同时成立 —— 必须能把两者分开计数并摆在用户面前。
//   ③ 帧文件名要**确定性**（同一份数据重复导出得到同一批名字），主进程写入与渲染层载荷
//      必须用同一条命名规则，否则对不上账。
//
// 数据语义（与 utils/scenarioTimeline.js 严格一致，本模块**不重新实现**归属判定）：
//   - scenario[k].ownership[pid]    = 第 k 个剧本快照里该省的归属（= 该剧本**结束**时的状态）
//   - scenario[k].changeEvents[pid] = 该省在**本剧本内**易主的日期列表（显式；缺省则合成）
//   ⇒ 任意**日期**的状态：该日期 < 本剧本易主日期 ? 上一剧本的归属 : 本剧本的归属
//     这条判定见 `currentOwnerRef` / `baseOwnerRef`；切片只是**挑时刻**，不碰状态推导。
//
// 🔴 月日精度 + 切片书签（2026-10-05，《月日精度与切片书签》执行单）：
//   帧从「一年一张」变成「一个日期一张」，且由**两类来源**组成：
//     · **书签帧**（`slicePoints`，人指定、有名字、可增删改）—— 默认必出；
//     · **自动帧**（剧本起点 + 每次易主）—— 逐帧可勾选。
//   两者**同一天合并展示**（一条时间点不出两张图）。日期比较一律走 `utils/scenarioDates.js`。
import { eraIndexOfYear, formatDate } from './scenarioTimeline';
import { cmpDate, normalizeDate, dateKey, dateToken, daysInMonth } from './scenarioDates';

/** 一帧一张图，帧数超过这个量级就不是「切片」而是「逐帧动画」了 —— 导不动也不该导 */
export const MAX_SLICE_FRAMES = 400;

/** 帧来源标记（frames.json 与对话框都用它说明「这一帧为什么存在」） */
export const FRAME_SOURCE = { BOOKMARK: 'bookmark', ERA: 'era', CHANGE: 'change' };

/** 日期 → 扁平三元组（外部载荷 / 用例断言用；`m`/`d` 缺省为 null） */
export function dateTriple(date) {
  const n = normalizeDate(date);
  if (!n) return { y: 0, m: null, d: null };
  return { y: n.y, m: n.m, d: n.d };
}

/** 书签/帧的展示文本：有名字用名字，没名字退回日期文本 */
export function frameLabel(frame) {
  if (frame && frame.label) return frame.label;
  return formatDate(frame && frame.date ? frame.date : frame);
}

/**
 * 易主**日期**体检：显式录入 vs 自动推算各多少，以及落在本剧本区间外的。
 * 分账口径（`explicit` / `synthesized` / `outOfRange`）与 2026-10-02 那版一致，
 * 只是单位从「年份」变成「事件」—— 同省同年多次易主现在会各算一条。
 *
 * @returns {{total:number, explicit:number, synthesized:number,
 *            explicitProvinces:number, outOfRange:Array, multiPerProvince:Array}}
 */
export function changeDateStats(tl) {
  const out = {
    total: 0, explicit: 0, synthesized: 0, explicitProvinces: 0,
    outOfRange: [], multiPerProvince: [],
  };
  const years = (tl && tl.years) || [];
  const n = years.length;
  for (let k = 1; k < n; k++) {
    const e = (tl.eraChg || [])[k];
    if (!e || !Array.isArray(e.changed)) continue;
    const r = years[k] || { start: 0, end: 0 };
    for (const pid of e.changed) {
      const list = (e.byProvince && e.byProvince[pid]) || [];
      if (list.length > 1) {
        out.multiPerProvince.push({ era: k, provinceId: pid, count: list.length });
      }
      let hasExplicit = false;
      for (const ev of list) {
        out.total++;
        if (ev.explicit) { out.explicit++; hasExplicit = true; } else out.synthesized++;
        if (Number.isFinite(ev.y) && (ev.y < r.start || ev.y > r.end)) {
          out.outOfRange.push({
            era: k, provinceId: pid, date: { y: ev.y, m: ev.m, d: ev.d },
            year: ev.y, start: r.start, end: r.end, explicit: !!ev.explicit,
            text: formatDate(ev),
          });
        }
      }
      if (hasExplicit) out.explicitProvinces++;
    }
  }
  return out;
}

/**
 * 易主**日期**的合法性判定（带「剧本序号 → 区间」的便利入口）。
 * 🔴 真正的判定核心是下面的 `validateChangeDateInRange`（**唯一实现**）；
 *    本函数只多做一步「按 era 序号取区间」。src 里目前**没有调用者**（面板与 store 都拿
 *    得到区间，直接用 InRange 那份）—— 保留它是为了让「有 tl 却没有区间」的调用方不必自己
 *    拼区间（那才是第二套比较的来源）。新增调用者请优先用 InRange。
 *
 * @param {object} tl 时间轴模型
 * @param {number} era 剧本序号
 * @param {object|number} date `{y,m,d}` 或裸年份
 * @returns {{ok:boolean, reason?:string, range?:{start:number,end:number}, date?:object}}
 */
export function validateChangeDate(tl, era, date) {
  const years = (tl && tl.years) || [];
  if (!years.length) return { ok: false, reason: '还没有剧本' };
  if (!Number.isInteger(era) || era < 0 || era >= years.length) {
    return { ok: false, reason: '剧本序号超出范围' };
  }
  const { start, end } = years[era];
  return validateChangeDateInRange(date, start, end);
}

/**
 * 同上，但区间由调用方直接给出（store 拿不到 tl 时用 —— 它只有 scenario.era 的字符串年份）。
 * ⚠️ 两处判定必须等价，所以这里也是**同一份实现**的薄包装，不许另写比较。
 */
export function validateChangeDateInRange(date, start, end) {
  const n = normalizeDate(date);
  if (!n) return { ok: false, reason: '日期无法识别（需要年份）', range: { start, end } };
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, reason: '剧本区间缺失', range: { start, end } };
  }
  if (n.y < start || n.y > end) {
    return { ok: false, reason: `年份须落在本剧本区间 ${start} ~ ${end}`, range: { start, end } };
  }
  if (n.m !== null && (n.m < 1 || n.m > 12)) {
    return { ok: false, reason: `月份须在 1 ~ 12（当前 ${n.m}）`, range: { start, end } };
  }
  if (n.d !== null) {
    if (n.m === null) return { ok: false, reason: '填了日就必须填月', range: { start, end } };
    // 月天数**唯一实现**在 scenarioDates（本模块不再自带一份 —— 两份 = 迟早有一份忘了闰年）
    const dim = daysInMonth(n.y, n.m);
    if (n.d < 1 || n.d > dim) {
      return { ok: false, reason: `${n.y} 年 ${n.m} 月只有 ${dim} 天（当前 ${n.d}）`, range: { start, end } };
    }
  }
  return { ok: true, range: { start, end }, date: n };
}

/**
 * 该年该月的天数 —— **已合并到 `utils/scenarioDates.js#daysInMonth`**（本模块 import 使用）。
 * 保留这个同名导出只是为了让既有 import 不破；不要在这里重新实现。
 */
export { daysInMonth as daysInMonthOf };

/**
 * 规整书签列表：去脏值、按日期升序、字段平整。
 * **不生成 id**（id 由 store 在新增时给，见 `scenarioEditing.addSlicePoint`）——
 * 纯函数层不引入随机性，否则「同一份数据重复导出得到同一批名字」这条契约会被打破。
 * ⚠️ 本函数与 store 的 `sanitizeSlicePoints` 是**同一套规整**、只差「同 id 去重」
 *    （store 需要去重是因为 id 要当列表 key；这里不需要，因为帧是按日期合并的）。
 *    改字段口径时**两处一起改** —— 单测 t9 会守这里，test_82 f3 会守 store 那份。
 *
 * @returns {Array<{id:string, label:string, date:object, y:number, m:number|null, d:number|null}>}
 */
export function normalizeSlicePoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const date = normalizeDate(p.date && typeof p.date === 'object'
      ? p.date
      : { y: p.y !== undefined ? p.y : p.year, m: p.m, d: p.d });
    if (!date) continue;
    out.push({
      id: String(p.id || ''),
      label: typeof p.label === 'string' ? p.label : '',
      date,
      y: date.y, m: date.m, d: date.d,
    });
  }
  out.sort((a, b) => cmpDate(a.date, b.date) || String(a.id).localeCompare(String(b.id)));
  return out;
}

/**
 * 切片索引：把「时间轴模型 + 书签」压成「需要出图的时间点」。
 *
 * 三类来源，**按日期合并**（一个时间点只出一张图）：
 *   - `bookmark` 人在时间轴上存的切片书签（`slicePoints`）—— **默认必出**；
 *   - `era`      每个剧本**起点**一帧。即使一省都没易主，时代交界处也可能换名/换色
 *                （polity id 每代全新，见 scenarioTimeline 的文件头注释），漏了就少了整代底图；
 *   - `change`   每次易主一帧。
 *
 * `frame.era` 一律取 `eraIndexOfYear(date.y)`（「这一帧属于哪个剧本」），
 * 与 `buildScenarioSVG({ era, date })` 的调用口径完全一致 —— 不搞两套规则。
 *
 * 每帧都带 `date`（`{y,m,d}`）与 `sources`（来源标记数组）；
 * 易主日期落在区间外（旧数据/导入数据）时 `outOfRange: true`，交给 UI 明说，不静默。
 *
 * @param {object} tl 时间轴模型
 * @param {Array} slicePoints 书签（`{id,label,y,m,d}` 或 `{id,label,date}`）
 * @returns {{frames:Array, stats:Object}}
 */
export function collectSliceFrames(tl, slicePoints) {
  const years = (tl && tl.years) || [];
  const n = years.length;
  const frames = [];
  const stats = {
    frameCount: 0, eraCount: 0, changeCount: 0, bookmarkCount: 0,
    explicitChanges: 0, synthesizedChanges: 0, outOfRangeChanges: 0,
    firstYear: 0, lastYear: 0, firstText: '', lastText: '',
  };
  if (!n) return { frames, stats };

  const byKey = new Map();
  const slot = (date) => {
    const key = dateKey(date);
    let f = byKey.get(key);
    if (!f) {
      f = {
        dateKey: key, date, year: date.y,
        era: 0, kind: 'era', changed: [], changes: [], explicit: {},
        outOfRange: false, sources: [], bookmarks: [], bookmarkIds: [], labels: [],
      };
      byKey.set(key, f);
    }
    return f;
  };

  // ① 书签帧（默认必出）
  for (const p of normalizeSlicePoints(slicePoints)) {
    const f = slot(p.date);
    f.bookmarks.push({ id: p.id, label: p.label });
    if (p.id) f.bookmarkIds.push(p.id);
    if (p.label) f.labels.push(p.label);
    if (!f.sources.includes(FRAME_SOURCE.BOOKMARK)) f.sources.push(FRAME_SOURCE.BOOKMARK);
    stats.bookmarkCount++;
  }

  // ② 剧本起点帧
  // ⚠️ 起点帧的日期是「起点年 + 月日缺省」= 该年 1 月 1 日（`dateKey` 口径）→
  //    判「是不是起点帧」必须比**完整日期**而不是比年份：只比年份会让同一年里
  //    任何一次年中易主都被标成 `mixed`（纯函数用例 t5 抓到）。
  const startKeys = new Set(years.map((y) => dateKey({ y: y.start, m: null, d: null })));
  for (let k = 0; k < n; k++) {
    const f = slot({ y: years[k].start, m: null, d: null });
    if (!f.sources.includes(FRAME_SOURCE.ERA)) f.sources.push(FRAME_SOURCE.ERA);
  }

  // ③ 易主帧（同一天合并）
  for (let k = 1; k < n; k++) {
    const e = (tl.eraChg || [])[k];
    if (!e || !Array.isArray(e.changed)) continue;
    const r = years[k] || { start: 0, end: 0 };
    for (const pid of e.changed) {
      const list = (e.byProvince && e.byProvince[pid]) || [];
      for (const ev of list) {
        stats.changeCount++;
        if (ev.explicit) stats.explicitChanges++;
        else stats.synthesizedChanges++;
        const f = slot(ev);
        if (!f.sources.includes(FRAME_SOURCE.CHANGE)) f.sources.push(FRAME_SOURCE.CHANGE);
        f.changed.push(pid);
        f.changes.push({
          era: k, provinceId: pid, explicit: !!ev.explicit,
          date: { y: ev.y, m: ev.m, d: ev.d }, owner: ev.owner ?? null,
        });
        if (ev.explicit) f.explicit[pid] = true;
        if (Number.isFinite(ev.y) && (ev.y < r.start || ev.y > r.end)) {
          f.outOfRange = true;
          stats.outOfRangeChanges++;
        }
      }
    }
  }

  for (const f of byKey.values()) {
    f.era = eraIndexOfYear(tl, f.date.y);
    const isStart = startKeys.has(f.dateKey);
    const hasChange = f.changed.length > 0;
    if (f.sources.includes(FRAME_SOURCE.BOOKMARK) && !hasChange && !isStart) f.kind = 'bookmark';
    else if (hasChange) f.kind = isStart ? 'mixed' : 'change';
    else f.kind = 'era';
    // 展示名：书签名优先（人给的名字比「2010」有用）
    f.label = f.labels.length ? f.labels.join(' / ') : '';
    f.changed.sort();
    f.changes.sort((a, b) => cmpDate(a.date, b.date) || String(a.provinceId).localeCompare(String(b.provinceId)));
    frames.push(f);
  }
  frames.sort((a, b) => cmpDate(a.date, b.date) || a.era - b.era);

  stats.eraCount = startKeys.size;
  stats.frameCount = frames.length;
  stats.firstYear = frames.length ? frames[0].year : 0;
  stats.lastYear = frames.length ? frames[frames.length - 1].year : 0;
  stats.firstText = frames.length ? formatDate(frames[0].date) : '';
  stats.lastText = frames.length ? formatDate(frames[frames.length - 1].date) : '';
  return { frames, stats };
}

/**
 * 帧文件名（**唯一实现**：渲染层造载荷、主进程落盘、用例断言共用一条规则）。
 *
 * 形如 `frame_0001_era03_14441111.svg` —— 日期段 = `dateToken`（年月日补零、负数年 `n` 前缀、
 * 月日缺省补 `00`）。文件名里**不出现** `-`（负数年）与任何路径分隔符，Windows 合法。
 * 日期缺省时退回年份（兼容只到年的旧帧，命名仍确定）。
 */
export function sliceFrameName(index, frame, ext = 'svg') {
  const i = String(Math.max(0, Number(index) || 0) + 1).padStart(4, '0');
  const era = String((frame && frame.era) || 0).padStart(2, '0');
  const date = frame ? (frame.date || { y: frame.year, m: null, d: null }) : null;
  const n = normalizeDate(date);
  const stamp = n ? dateToken(n) : '0';
  return `frame_${i}_era${era}_${stamp}.${ext}`;
}

export { formatDate as formatScenarioDate };
