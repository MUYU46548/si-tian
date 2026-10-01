// utils/scenarioSlices.js
// 历史剧本「逐年切片导出」的纯函数层（无 DOM、无 Vue、无 store 依赖）
//
// 为什么需要它：
//   ① 「哪些年份各出一帧」是一个**判定**，不是遍历结果 —— 真实数据 12 剧本 / 3488 年，
//      按年出帧 = 3488 张（没人要）；按「状态真的变了」出帧 ≈ 十张出头。
//      这个判定若写在组件里，导出对话框与导出链就各有一份（本仓已三次踩到「改一处另一处不变」）。
//   ② 切片能不能信，取决于**日期是不是真的**：`computeEraChanges` 在缺显式值时会在本剧本
//      区间内**均匀铺开**一个合成年份（确定性、看起来很像真的）。于是「切片很漂亮」与
//      「这些日期是编的」可以同时成立 —— 必须能把两者分开计数并摆在用户面前。
//   ③ 帧文件名要**确定性**（同一份数据重复导出得到同一批名字），主进程写入与渲染层载荷
//      必须用同一条命名规则，否则对不上账。
//
// 数据语义（与 utils/scenarioTimeline.js 严格一致，本模块**不重新实现**归属判定）：
//   - scenario[k].ownership[pid]   = 第 k 个剧本快照里该省的归属（= 该剧本**结束**时的状态）
//   - scenario[k].changeYears[pid] = 该省在**本剧本内**易主的年份（显式值；缺省则合成）
//   ⇒ 任意年份的状态：year < 本剧本 changeYear ? 上一剧本的归属 : 本剧本的归属
//     这条判定见 `currentOwnerRef` / `baseOwnerRef`；切片只是**挑年份**，不碰状态推导。
import { parseYear, eraIndexOfYear } from './scenarioTimeline';

/** 一帧一张图，帧数超过这个量级就不是「切片」而是「逐帧动画」了 —— 导不动也不该导 */
export const MAX_SLICE_FRAMES = 400;

/**
 * 易主日期体检：显式录入 vs 自动推算各多少，以及落在本剧本区间外的。
 * @returns {{total:number, explicit:number, synthesized:number, outOfRange:Array}}
 */
export function changeDateStats(tl) {
  const out = { total: 0, explicit: 0, synthesized: 0, outOfRange: [] };
  const years = (tl && tl.years) || [];
  const n = years.length;
  for (let k = 1; k < n; k++) {
    const e = (tl.eraChg || [])[k];
    if (!e || !Array.isArray(e.changed)) continue;
    const r = years[k] || { start: 0, end: 0 };
    for (const pid of e.changed) {
      out.total++;
      if (e.explicit && e.explicit[pid]) out.explicit++;
      else out.synthesized++;
      const y = e.year ? e.year[pid] : undefined;
      if (Number.isFinite(y) && (y < r.start || y > r.end)) {
        out.outOfRange.push({ era: k, provinceId: pid, year: y, start: r.start, end: r.end });
      }
    }
  }
  return out;
}

/**
 * 易主年份的合法性判定（**唯一实现**：面板内联提示与 store 写入守卫共用同一份）。
 * 规则：必须是数字，且落在**本剧本的年代区间**内。
 * 区间退化（start === end）时只接受该年 —— 那正是这个剧本唯一有意义的时刻。
 * @returns {{ok:boolean, reason?:string, range?:{start:number,end:number}}}
 */
export function validateChangeYear(tl, era, year) {
  const years = (tl && tl.years) || [];
  if (!years.length) return { ok: false, reason: '还没有剧本' };
  if (!Number.isInteger(era) || era < 0 || era >= years.length) {
    return { ok: false, reason: '剧本序号超出范围' };
  }
  const { start, end } = years[era];
  const v = parseYear(year);
  if (!Number.isFinite(v)) return { ok: false, reason: '年份不是数字', range: { start, end } };
  if (v < start || v > end) {
    return { ok: false, reason: `年份须落在本剧本区间 ${start} ~ ${end}`, range: { start, end } };
  }
  return { ok: true, range: { start, end } };
}

/**
 * 切片索引：把「时间轴模型」压成「需要出图的年份」。
 *
 * 两类帧：
 *   - `era`   每个剧本**起点**一帧。即使一省都没易主，时代交界处也可能换名/换色
 *             （polity id 每代全新，见 scenarioTimeline 的文件头注释），漏了就少了整代底图。
 *   - `change` 每次易主一帧（同一年多个省易主 → 合并成一帧）。
 *
 * 同一年的帧合并；`frame.era` 一律取 `eraIndexOfYear(year)`（「这一帧属于哪个剧本」），
 * 与 `buildScenarioSVG(era, year)` 的调用口径完全一致 —— 不搞两套规则。
 * 易主年份落在区间外（旧数据/导入数据）时 `outOfRange: true`，交给 UI 明说，不静默。
 *
 * @returns {{frames:Array, stats:Object}}
 */
export function collectSliceFrames(tl) {
  const years = (tl && tl.years) || [];
  const n = years.length;
  const frames = [];
  const stats = {
    frameCount: 0, eraCount: 0, changeCount: 0,
    explicitChanges: 0, synthesizedChanges: 0, outOfRangeChanges: 0,
    firstYear: 0, lastYear: 0,
  };
  if (!n) return { frames, stats };

  const byYear = new Map();
  const slot = (year) => {
    let f = byYear.get(year);
    if (!f) {
      f = { year, era: 0, kind: 'era', changed: [], changes: [], explicit: {}, outOfRange: false };
      byYear.set(year, f);
    }
    return f;
  };

  // ① 剧本起点帧
  const startYears = new Set(years.map((y) => y.start));
  for (let k = 0; k < n; k++) slot(years[k].start);

  // ② 易主帧（同一年合并）
  for (let k = 1; k < n; k++) {
    const e = (tl.eraChg || [])[k];
    if (!e || !Array.isArray(e.changed)) continue;
    const r = years[k] || { start: 0, end: 0 };
    for (const pid of e.changed) {
      const y = e.year ? e.year[pid] : undefined;
      stats.changeCount++;
      if (e.explicit && e.explicit[pid]) stats.explicitChanges++;
      else stats.synthesizedChanges++;
      if (!Number.isFinite(y)) continue;
      const f = slot(y);
      f.changed.push(pid);
      f.changes.push({ era: k, provinceId: pid, explicit: !!(e.explicit && e.explicit[pid]) });
      if (e.explicit && e.explicit[pid]) f.explicit[pid] = true;
      if (y < r.start || y > r.end) { f.outOfRange = true; stats.outOfRangeChanges++; }
    }
  }

  for (const f of byYear.values()) {
    f.era = eraIndexOfYear(tl, f.year);
    // 帧种类：起点（剧本交界）/ 易主 / 两者同年
    const isStart = startYears.has(f.year);
    f.kind = f.changed.length ? (isStart ? 'mixed' : 'change') : 'era';
    f.changed.sort();
    frames.push(f);
  }
  frames.sort((a, b) => a.year - b.year || a.era - b.era);

  stats.eraCount = startYears.size;
  stats.frameCount = frames.length;
  stats.firstYear = frames.length ? frames[0].year : 0;
  stats.lastYear = frames.length ? frames[frames.length - 1].year : 0;
  return { frames, stats };
}

/** 帧文件名（**唯一实现**：渲染层造载荷、主进程落盘、用例断言共用一条规则） */
export function sliceFrameName(index, frame, ext = 'svg') {
  const i = String(Math.max(0, Number(index) || 0) + 1).padStart(4, '0');
  const era = String((frame && frame.era) || 0).padStart(2, '0');
  const y = frame && Number.isFinite(frame.year) ? String(frame.year) : '0';
  // 年份可为负（公元前）→ 用 n 前缀，避免文件名里出现 '-' 与分隔符混淆
  const year = y.startsWith('-') ? `n${y.slice(1)}` : y;
  return `frame_${i}_era${era}_${year}.${ext}`;
}
