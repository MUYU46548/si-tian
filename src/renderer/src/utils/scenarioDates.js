// utils/scenarioDates.js
// 历史剧本「月日精度日期」的纯函数层（无 DOM、无 Vue、无 store 依赖）
//
// 为什么需要它（2026-10-05，执行单《月日精度与切片书签》）：
//   ① 旧模型是 `scenario.changeYears[pid] = 1993`（一省一剧本最多易主一次、只有年精度）。
//      「切片点要到月日」要求同省同年**多次**易主，年单值装不下 → 改成
//      `scenario.changeEvents[pid] = [{ y, m, d, owner }, …]`（按日期升序的列表）。
//   ② 这是**破坏性**数据模型变更，但只要「旧键读取兼容」就安全 —— 关键在**幂等**：
//      迁移函数必须能被跑任意多次（载入 / 快照回放 / 合并 / 导入），
//      第二次跑必须是 no-op。写成「有旧键才转」而不检查新键，就会在
//      「新旧同时存在」时用旧值覆盖新值（静默丢数据）。
//   ③ `m`/`d` 允许为 null（只录到年），语义 = 该年 **1 月 1 日**。这条口径必须只有一处实现：
//      比较、格式化、区间校验、切片帧名全部走本模块，任何一处自己写 `m || 1` 就是第二事实源。
//
// 🔴 迁移的唯一实现 = `normalizeScenarioDates()`：
//   发现 `changeYears` → 转 `changeEvents` 并**删旧键**；对已是新格式的输入必须是 no-op。
//   保存只写新键，**不双写**（双写 = 第二事实源，迟早漂移）。
//   调用点见 `AGENTS.md`「月日精度与切片书签」条目：载入 / 撤销重放 / 导入 / 写入口。
//
// ⚠️ 全程**不改入参**（返回新对象）。入参可能是 Vue 响应式代理或
//    `JSON.parse(JSON.stringify(...))` 出来的裸对象，两种情况都得能跑。

/** 月份缺省（= 1 月）与日缺省（= 1 日）—— 「只录到年」的语义锚点 */
export const DEFAULT_MONTH = 1;
export const DEFAULT_DAY = 1;

/** 解析年份：字符串/数字/负值都吃，失败返回 NaN（与 scenarioTimeline.parseYear 同口径） */
export function parseYear(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 整数解析：非整数/空 → null（`m`/`d` 的「缺省」就是 null，不是 1） */
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 该年 2 月的天数（格里高利历；年可为负 —— 负数年用 Math.abs 判闰，够用且不误导） */
function daysInFebruary(y) {
  const v = Math.abs(y);
  return (v % 4 === 0 && v % 100 !== 0) || v % 400 === 0 ? 29 : 28;
}

/** 该年该月的天数；月为 null → 31（缺省月不参与上限判定） */
export function daysInMonth(y, m) {
  const mm = intOrNull(m);
  if (mm === null) return 31;
  if (mm < 1 || mm > 12) return 31;
  return [31, daysInFebruary(y), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
}

/**
 * 规整一个日期对象 → `{ y, m, d }` 或 `null`（年份非法时）。
 *
 * 接受的入参形态（**宽松**，因为调用方既有 UI 也有老代码）：
 *   · `{ y, m, d }`（也吃 `{ year, month, day }` 长字段名）
 *   · **裸年份**（数字或数字字符串）→ 视为 `{ y, m: null, d: null }`
 *     ⚠️ 这条必须有：`normalizeEventList` 早就按裸年份容错，而 store 的
 *     `setOwnership` / `batchSetOwnership` / `setChangeEventsBulk` 三个写入口的文档都写着
 *     「或裸年份」。此前这里只认对象 → 裸年份被判非法，症状分两类且**都不报错**：
 *     `setOwnership` 直接拒绝（连归属都不写）、`batchSetOwnership` 把日期**静默丢掉**却返回
 *     `success:true`（调用方以为日期记下了）。2026-10-05 由子代理审查抓出。
 *
 * 规则：`m`/`d` 各自可为 null；**`m` 为 null 时 `d` 一律归 null**
 * （「只到年」和「有日没月」是同一件事，后者是脏数据）。
 */
export function normalizeDate(raw) {
  let src = raw;
  if (typeof raw === 'number' || typeof raw === 'string') src = { y: raw };
  if (!src || typeof src !== 'object') return null;
  const y = parseYear(src.y !== undefined ? src.y : src.year);
  if (!Number.isFinite(y)) return null;
  const m = intOrNull(src.m !== undefined ? src.m : src.month);
  if (m === null) return { y, m: null, d: null };
  return { y, m, d: intOrNull(src.d !== undefined ? src.d : src.day) };
}

/** 日期 → 可比较整数（缺省月/日按 1 月 1 日）。非法日期给 ±Infinity，排序时沉底 */
export function toOrdinal(date) {
  const n = normalizeDate(date);
  if (!n) return Number.NEGATIVE_INFINITY;
  return ((n.y * 100 + (n.m === null ? DEFAULT_MONTH : n.m)) * 100)
    + (n.d === null ? DEFAULT_DAY : n.d);
}

/**
 * 🔴 日期比较的**唯一实现**（先 y 后 m 后 d，null 按 1 月 1 日）。
 * 返回 <0 / 0 / >0，可直接喂 `Array.prototype.sort`。非法日期一律「小于」任何合法日期。
 */
export function cmpDate(a, b) {
  const oa = toOrdinal(a);
  const ob = toOrdinal(b);
  if (oa === ob) return 0;
  return oa < ob ? -1 : 1;
}

/** 同一天（按缺省口径） */
export function sameDate(a, b) {
  return cmpDate(a, b) === 0;
}

/** `cmpDate` 的别名 —— 时间轴侧按「比较函数」语义命名更顺口，同一条实现 */
export const compareDates = cmpDate;

/** 取较晚 / 较早的一个（都非法时返回 a），null 安全 */
export function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return cmpDate(a, b) >= 0 ? a : b;
}

export function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return cmpDate(a, b) <= 0 ? a : b;
}

/**
 * 日期 → 展示文本。`{1993,null,null}` → `'1993'`；`{1993,5,null}` → `'1993-05'`；
 * `{1993,5,12}` → `'1993-05-12'`。缺省分量**不显示**（显示成 1993-01-01 会把「只录到年」谎报成精确日期）。
 * 负数年：`-350` → `'前350'`（`n` 只在文件名里用，界面用「前」，与 era 的写法一致）。
 */
export function formatDate(date) {
  const n = normalizeDate(date);
  if (!n) return '';
  const year = n.y < 0 ? `前${Math.abs(n.y)}` : String(n.y);
  if (n.m === null) return year;
  const mm = String(n.m).padStart(2, '0');
  if (n.d === null) return `${year}-${mm}`;
  return `${year}-${mm}-${String(n.d).padStart(2, '0')}`;
}

/** 日期 → 紧凑键（同年合并、去重都用它；缺省口径同 cmpDate） */
export function dateKey(date) {
  const n = normalizeDate(date);
  if (!n) return '';
  const m = n.m === null ? DEFAULT_MONTH : n.m;
  const d = n.d === null ? DEFAULT_DAY : n.d;
  return `${n.y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 帧名/文件名用的年份段：负数用 `n` 前缀，避免与路径分隔符混淆 */
export function yearToken(y) {
  const v = parseYear(y);
  if (!Number.isFinite(v)) return '0';
  const s = String(v);
  return s.startsWith('-') ? `n${s.slice(1)}` : s;
}

/**
 * 帧名/文件名用的**日期段**（年月日连写，全部补零、无分隔符）。
 *   `{1993,5,12}` → `'19930512'`；`{1993,null,null}` → `'19930000'`；`{-350,null,null}` → `'n3500000'`
 * 月日缺省补 `00` 而不是 `01`：文件名要能**如实**反映「只录到年」，
 * 补 01 会让 `frame_..._19930000` 与真·1 月 1 日的 `frame_..._19930101` 看起来是同一天。
 */
export function dateToken(date) {
  const n = normalizeDate(date);
  if (!n) return '0';
  const mm = String(n.m === null ? 0 : n.m).padStart(2, '0');
  const dd = String(n.d === null ? 0 : n.d).padStart(2, '0');
  return `${yearToken(n.y)}${mm}${dd}`;
}

/** 一个事件是否是「显式录入」（相对运行时合成的推算值） */
export function isExplicitEvent(ev) {
  return !!(ev && ev.explicit);
}

/**
 * 规整「一个省的易主事件列表」→ 升序、去重（同日期只留最后一条）、字段干净的数组。
 *
 * @param {Array} list 原始事件数组（可能是旧格式数字、脏对象、字符串年份）
 * @returns {Array<{y:number, m:number|null, d:number|null, owner:string|null}>} 新数组
 */
export function normalizeEventList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    // 容错：列表里塞了裸数字/字符串（旧 changeYears 的值被手写进新键）→ 当「只到年」
    const date = normalizeDate(typeof raw === 'object' && raw !== null ? raw : { y: raw });
    if (!date) continue;
    const owner = (raw && typeof raw === 'object' && raw.owner !== undefined && raw.owner !== null)
      ? String(raw.owner)
      : null;
    const ev = { y: date.y, m: date.m, d: date.d, owner };
    const k = dateKey(ev);
    if (seen.has(k)) {
      // 同日期重复 → 保留**后出现**的那条（后写覆盖先写，与对象键语义一致）
      const at = out.findIndex((x) => dateKey(x) === k);
      if (at >= 0) out[at] = ev;
      continue;
    }
    seen.add(k);
    out.push(ev);
  }
  out.sort(cmpDate);
  return out;
}

/**
 * 旧 → 新：`changeYears[pid] = y` ⇒ `changeEvents[pid] = [{ y, m: null, d: null, owner }]`。
 * `owner` 取该省在该剧本快照里的归属（`scenario.ownership[pid]`），
 * 因为「易主到谁」在旧模型里是隐含的（= 本剧本的 ownership）。
 */
function migrateChangeYears(scenario) {
  const old = scenario.changeYears;
  const events = {};
  if (old && typeof old === 'object') {
    for (const [pid, val] of Object.entries(old)) {
      const y = parseYear(val);
      if (!Number.isFinite(y)) continue;
      const owner = scenario.ownership && scenario.ownership[pid] !== undefined
        ? scenario.ownership[pid] : null;
      events[pid] = [{ y, m: null, d: null, owner: owner === undefined ? null : owner }];
    }
  }
  return events;
}

/**
 * 🔴 单个剧本的日期迁移（**唯一实现**，幂等）。
 *
 * 行为：
 *   · 有 `changeYears` → 转成 `changeEvents`（与既有 `changeEvents` **合并**：新键优先，
 *     旧键只补新键里没有的省），然后**删掉 `changeYears`**；
 *   · 没有 `changeYears` → 只做规整（列表排序 / 去重 / 字段清洗），不新增键；
 *   · 已经是新格式 → **no-op 级**（规整后深比较，相同则**原样返回入参**，不制造新对象）。
 *     这条很关键：`scenarioDates.test` 判的「幂等」就是「第二次跑返回同一引用 / 无字段差异」。
 *
 * @returns {object} 新剧本对象（无改动时可能返回入参本身）
 */
export function normalizeScenarioDates(scenario) {
  if (!scenario || typeof scenario !== 'object') return scenario;
  const hasOld = Object.prototype.hasOwnProperty.call(scenario, 'changeYears');
  const hasNew = Object.prototype.hasOwnProperty.call(scenario, 'changeEvents');
  if (!hasOld && !hasNew) return scenario;

  const base = hasOld ? migrateChangeYears(scenario) : {};
  const cur = hasNew && scenario.changeEvents && typeof scenario.changeEvents === 'object'
    ? scenario.changeEvents : {};

  const merged = {};
  for (const pid of Object.keys(cur)) {
    const list = normalizeEventList(cur[pid]);
    if (list.length) merged[pid] = list;
  }
  for (const pid of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(merged, pid)) continue;   // 新键优先
    merged[pid] = base[pid];
  }

  const next = { ...scenario };
  delete next.changeYears;
  if (Object.keys(merged).length) next.changeEvents = merged;
  else delete next.changeEvents;

  // 幂等快路径：无旧键 + 规整后与新键逐字段一致 → 直接返回入参（不制造新对象）
  if (!hasOld && hasNew && sameEventMap(merged, scenario.changeEvents)) return scenario;
  return next;
}

function sameEventMap(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const la = a[ka[i]];
    const lb = b[ka[i]];
    if (!Array.isArray(la) || !Array.isArray(lb) || la.length !== lb.length) return false;
    for (let j = 0; j < la.length; j++) {
      const x = la[j]; const y = lb[j];
      if (x.y !== y.y || x.m !== y.m || x.d !== y.d || x.owner !== y.owner) return false;
    }
  }
  return true;
}

/**
 * 整个剧本字典的日期迁移（载入 / 快照回放 / 导入 / 时间轴构建的统一入口）。
 * 无任何改动的剧本**保持原引用**（避免把整表换新对象 → 触发无谓重渲染 / 让
 * 「就地改字段」的纪律失效，见 geodata.refreshEntitiesFromProject 的教训）。
 *
 * ⚠️ **入参可以是数组或字典，出参保持同形** —— `buildTimeline` 手里是数组
 *    （`sortedScenarios`），若这里一律返回字典，下游的 `[...scenarios]` 会变成
 *    「对象不可迭代」直接抛错。类型必须原样往返。
 *
 * @param {Record<string, object>|Array<object>} scenarios
 * @returns {{ ok: boolean, scenarios: (Record<string, object>|Array<object>), migrated: string[], normalized: string[] }}
 */
export function normalizeScenarioDict(scenarios) {
  const isArray = Array.isArray(scenarios);
  const src = scenarios || (isArray ? [] : {});
  const keys = isArray ? src.map((_, i) => i) : Object.keys(src);
  const out = isArray ? [] : {};
  const migrated = [];
  const normalized = [];
  let changed = false;
  for (const key of keys) {
    const sc = src[key];
    const before = sc && typeof sc === 'object';
    const next = before ? normalizeScenarioDates(sc) : sc;
    if (next !== sc) {
      changed = true;
      const name = String((sc && sc.id) || key);
      if (before && Object.prototype.hasOwnProperty.call(sc, 'changeYears')) migrated.push(name);
      else normalized.push(name);
    }
    out[key] = next;
  }
  return { ok: true, scenarios: changed ? out : src, migrated, normalized };
}

/**
 * 日期是否落在 `[start, end]`（含端点；按**年**比较，与剧本边界的年精度一致）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function dateInYearRange(date, start, end) {
  const n = normalizeDate(date);
  if (!n) return { ok: false, reason: '日期无法识别（需要年份）' };
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, reason: '剧本区间缺失' };
  if (n.y < start || n.y > end) {
    return { ok: false, reason: `年份须落在本剧本区间 ${start} ~ ${end}` };
  }
  return { ok: true };
}

// ⚠️ 「易主日期是否合法」的判定**不在这里** —— 它在 `utils/scenarioSlices.js` 的
//    `validateChangeDate` / `validateChangeDateInRange`。理由：那条规则同时是
//    「切片帧名能不能确定地造出来」的前提（年月日要能拼进文件名），
//    而切片帧名也在 `scenarioSlices.js`。把校验与命名放在同一模块，
//    「合法日期」与「能命名的日期」就不会各说各话。
//    本模块只提供它需要的原语：`normalizeDate` / `daysInMonth` / `dateInYearRange`。

// ============================================================
// 归属查询（月日精度）—— 「某个日期这一刻，这个省归谁」
// ============================================================

/**
 * 取该省在 `atDate` 这一刻**已落定**的那条事件（列表里日期 ≤ atDate 的最后一条）。
 * 列表按升序，故从后往前找第一条满足的即可（事件数是个位数，无需二分）。
 */
export function lastEventAtOrBefore(events, atDate) {
  if (!Array.isArray(events) || !events.length) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (cmpDate(events[i], atDate) <= 0) return events[i];
  }
  return null;
}

/** 该省是否在 `atDate` 已发生过易主（同一天算已落定 —— 与旧 `year >= e.year` 口径一致） */
export function hasSettledAt(events, atDate) {
  return !!lastEventAtOrBefore(events, atDate);
}
