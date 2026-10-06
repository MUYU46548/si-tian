#!/usr/bin/env node
/**
 * Node 单元测试：历史剧本「月日精度日期」纯函数（src/renderer/src/utils/scenarioDates.js）
 *
 * 为什么必须有这一层：
 *   ① `changeYears` → `changeEvents` 是**破坏性**数据模型变更。迁移函数若不幂等，
 *      第二次跑就会用旧值覆盖新值 —— 用户会看到「我录的月日又变回 1 月 1 日了」，且不报错。
 *      这条只能靠纯函数层守：CDP 用例跑的是真实项目往返，成本高且不容易覆盖「跑两次」。
 *   ② `m`/`d` 允许 null（只录到年），语义 = 该年 1 月 1 日。这个口径只要有两份实现，
 *      比较与格式化就会漂移（例如闰年 2-29 在一处合法、另一处越界）。
 *   ③ 负数年份（公元前）要能在文件名与界面里都活下来 —— 文件名里不能出现 `-`。
 *
 * 用法：node scripts/tests/unit/test_scenario_dates.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM 且有相对 import（'./xxx' 无扩展名，Node 解析不了）——
 *    与 test_province_shape.js / test_scenario_slices.js 同法：复制到临时目录 + 补 `.js` 扩展名
 *    + 写 `{"type":"module"}`，源码一个字符都不改。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['scenarioDates.js', 'scenarioTimeline.js', 'scenarioSlices.js'];

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

/** 临时目录里能不能 require 到同一个模块（复制 + 补扩展名） */
function stage(tmp) {
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
}

/** 剧本夹具（形状与 scenarioEditing.createScenario 一致） */
function scen(id, start, end, ownership, extra) {
  return {
    id, name: id, order: 1,
    era: { roman: '', label: id, startYear: String(start), endYear: String(end) },
    polities: [], ownership: ownership || {},
    ...(extra || {}),
  };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-dates-'));
  stage(tmp);
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const D = await import(pathToFileURL(path.join(tmp, 'scenarioDates.js')).href);
  const T = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);
  const {
    normalizeDate, normalizeEventList, normalizeScenarioDates, normalizeScenarioDict,
    cmpDate, compareDates, toOrdinal, dateKey, formatDate, dateToken, yearToken,
    daysInMonth, lastEventAtOrBefore, hasSettledAt, maxDate, minDate,
  } = D;
  const S = await import(pathToFileURL(path.join(tmp, 'scenarioSlices.js')).href);
  const { validateChangeDate: validateViaTl, validateChangeDateInRange } = S;
  const { buildTimeline, currentOwnerRef, baseOwnerRef, isStriped, settledCount, eventCountInEra,
    baseOwnerAt, currentOwnerAt } = T;

  // ══ A. 日期规整与缺省口径 ══
  check('a1 normalizeDate：缺省 m/d 保持 null（不许悄悄补成 1）；年份非法→null；有日无月→日归 null', () => {
    deepEq(normalizeDate({ y: 1993 }), { y: 1993, m: null, d: null }, '只到年');
    deepEq(normalizeDate({ y: 1993, m: 5 }), { y: 1993, m: 5, d: null }, '到月');
    deepEq(normalizeDate({ y: 1993, m: 5, d: 12 }), { y: 1993, m: 5, d: 12 }, '到日');
    deepEq(normalizeDate({ y: 1993, m: null, d: 12 }), { y: 1993, m: null, d: null }, '有日无月 → 脏数据归一');
    eq(normalizeDate({ y: '不是年' }), null, '非数字年份');
    eq(normalizeDate(null), null, 'null');
    deepEq(normalizeDate({ year: 1993, month: 5, day: 12 }), { y: 1993, m: 5, d: 12 }, '长字段名也吃');
    // 🔴 裸年份必须被接受：store 三个写入口的文档都写着「或裸年份」，
    //    而 normalizeEventList 早就按裸年份容错 —— 只认对象会让裸年份**静默失效**
    //    （setOwnership 直接拒绝 / batchSetOwnership 把日期丢掉却返回 success:true）。
    deepEq(normalizeDate(1993), { y: 1993, m: null, d: null }, '裸数字年份');
    deepEq(normalizeDate('1993'), { y: 1993, m: null, d: null }, '裸数字字符串年份');
    deepEq(normalizeDate(-350), { y: -350, m: null, d: null }, '负数裸年份');
    eq(normalizeDate(''), null, '空串不是年份');
    return '缺省保持 null；脏数据归一为 null；裸年份被接受';
  });

  check('a2 cmpDate：先年后月后日；缺省按 1 月 1 日；与 compareDates 别名一致', () => {
    assert(cmpDate({ y: 1993 }, { y: 1994 }) < 0, '年优先');
    assert(cmpDate({ y: 1993, m: 2 }, { y: 1993, m: 10 }) < 0, '月次之');
    assert(cmpDate({ y: 1993, m: 2, d: 3 }, { y: 1993, m: 2, d: 12 }) < 0, '日最后');
    eq(cmpDate({ y: 1993 }, { y: 1993, m: 1, d: 1 }), 0, '缺省 = 1 月 1 日');
    eq(cmpDate({ y: 1993, m: 1 }, { y: 1993, m: 1, d: 1 }), 0, '缺省日 = 1');
    eq(cmpDate({ y: 1993, m: 5, d: 12 }, { y: 1993, m: 5, d: 12 }), 0, '同一天');
    eq(typeof compareDates, 'function', '别名在场');
    eq(compareDates({ y: 2000 }, { y: 1999 }), 1, '别名同口径');
    // 排序稳定性：乱序数组排完必须严格升序
    const arr = [{ y: 1993, m: 5 }, { y: 1993 }, { y: 1992, m: 12, d: 31 }, { y: 1993, m: 5, d: 2 }];
    const sorted = [...arr].sort(cmpDate).map(formatDate);
    deepEq(sorted, ['1992-12-31', '1993', '1993-05', '1993-05-02'], '排序结果');
    return '三个分量依次比较；缺省口径统一';
  });

  check('a3 dateKey 与 toOrdinal 同口径（缺省按 1 月 1 日补零）', () => {
    eq(dateKey({ y: 1993 }), '1993-01-01', '只到年');
    eq(dateKey({ y: 1993, m: 5 }), '1993-05-01', '到月');
    eq(dateKey({ y: 1993, m: 5, d: 2 }), '1993-05-02', '到日');
    eq(dateKey({ y: -350 }), '-350-01-01', '负数年');
    assert(toOrdinal({ y: 1993, m: 5, d: 2 }) === 19930502, '序数 = 年月日连写');
    assert(toOrdinal({ y: 1993 }) === 19930101, '缺省序数');
    return '键与序数同源';
  });

  check('a4 formatDate：只录到年就只显示年（不许谎报成 1 月 1 日）；数字补零；负数年显示「前N」', () => {
    eq(formatDate({ y: 1993 }), '1993', '只到年');
    eq(formatDate({ y: 1993, m: 5 }), '1993-05', '到月');
    eq(formatDate({ y: 1993, m: 5, d: 2 }), '1993-05-02', '到日补零');
    eq(formatDate({ y: -350 }), '前350', '公元前');
    eq(formatDate({ y: -350, m: 11, d: 11 }), '前350-11-11', '公元前带月日');
    eq(formatDate(null), '', 'null 给空串');
    return '4 例 + null 安全';
  });

  check('a5 dateToken / yearToken：文件名里不出现 -（Windows 与路径分隔符都安全）', () => {
    eq(dateToken({ y: 1993, m: 5, d: 12 }), '19930512', '补零连写');
    eq(dateToken({ y: 1993 }), '19930000', '只到年补 00（不许补 01 —— 那会与真 1 月 1 日混淆）');
    eq(dateToken({ y: -350 }), 'n3500000', '负数年用 n 前缀');
    eq(yearToken(-350), 'n350', '年份段同理');
    eq(yearToken(1993), '1993', '正数年原样');
    for (const d of [{ y: -350 }, { y: 1993, m: 5, d: 12 }, { y: 0 }]) {
      assert(!dateToken(d).includes('-'), `文件名段不许含 -：${dateToken(d)}`);
      assert(!dateToken(d).includes('/') && !dateToken(d).includes('\\'), '不许含路径分隔符');
    }
    return '负数年/缺省月日都安全';
  });

  check('a6 daysInMonth：闰年规则（4 年一闰、100 不闰、400 再闰）与月天数', () => {
    eq(daysInMonth(2000, 2), 29, '2000 闰（400 整除）');
    eq(daysInMonth(1900, 2), 28, '1900 不闰（100 整除非 400）');
    eq(daysInMonth(1996, 2), 29, '1996 闰');
    eq(daysInMonth(1993, 2), 28, '1993 平');
    eq(daysInMonth(1993, 4), 30, '4 月 30 天');
    eq(daysInMonth(1993, 12), 31, '12 月 31 天');
    eq(daysInMonth(1993, null), 31, '月缺省不参与上限判定');
    return '格里高利历规则';
  });

  // ══ B. 事件列表规整 ══
  check('b1 normalizeEventList：升序、同日期去重（留后写）、字段清洗', () => {
    const out = normalizeEventList([
      { y: 1993, m: 5, d: 12, owner: 'B' },
      { y: 1990, m: 1, d: 1, owner: 'A' },
      { y: 1993, m: 5, d: 12, owner: 'C' },   // 同日期重复 → 留后出现的 C
      { y: 'bad' },
    ]);
    deepEq(out.map((e) => [e.y, e.m, e.d, e.owner]),
      [[1990, 1, 1, 'A'], [1993, 5, 12, 'C']], '升序 + 去重留后');
    deepEq(normalizeEventList([1993]), [{ y: 1993, m: null, d: null, owner: null }], '裸数字当「只到年」');
    deepEq(normalizeEventList('nope'), [], '非数组给空');
    return '升序 / 去重 / 容错';
  });

  // ══ C. 迁移（本轮最关键的一组）══
  check('c1 旧 changeYears → changeEvents：字段搬家、owner 取自本剧本 ownership、旧键删除', () => {
    const sc = scen('乙', 2010, 2020, { prov_a: 'B1' }, { changeYears: { prov_a: 2015 } });
    const next = normalizeScenarioDates(sc);
    deepEq(next.changeEvents, { prov_a: [{ y: 2015, m: null, d: null, owner: 'B1' }] }, '事件');
    assert(!('changeYears' in next), '返回的新对象上旧键必须删除（双写 = 第二事实源）');
    assert(!('changeYears' in next.changeEvents), '新键里不许混进旧键名');
    // ⚠️ 迁移**不改入参**（返回新对象）—— 入参常是响应式代理/已解析载荷，就地改会绕过 watch
    deepEq(Object.keys(sc).sort(), Object.keys(scen('乙', 2010, 2020, { prov_a: 'B1' }, { changeYears: { prov_a: 2015 } })).sort(), '入参形状未被就地改动');
    return '旧键读入即转、返回对象上旧键删除、入参不动';
  });

  check('c2 🔴 幂等：连续跑三次，字段逐字节一致（第二次起 no-op）', () => {
    const sc = scen('乙', 2010, 2020, { prov_a: 'B1' }, { changeYears: { prov_a: 2015 } });
    const one = normalizeScenarioDates(sc);
    const two = normalizeScenarioDates(one);
    const three = normalizeScenarioDates(two);
    eq(two, one, '第二遍必须返回同一引用（no-op）');
    eq(three, one, '第三遍同理');
    deepEq(two.changeEvents, one.changeEvents, '字段不动');
    // 已是新格式且无需规整的输入也必须保持原引用
    const fresh = { id: 'x', changeEvents: { p: [{ y: 1, m: 2, d: 3, owner: 'A' }] } };
    eq(normalizeScenarioDates(fresh), fresh, '已是新格式 → 原引用');
    return '三遍一致 + 原引用快路径';
  });

  check('c3 新旧同时存在：新键优先（旧值不许覆盖新值）', () => {
    const sc = scen('乙', 2010, 2020, { prov_a: 'B1', prov_b: 'B2' }, {
      changeYears: { prov_a: 2015, prov_b: 2016 },
      changeEvents: { prov_a: [{ y: 2015, m: 3, d: 4, owner: 'B1' }] },
    });
    const next = normalizeScenarioDates(sc);
    deepEq(next.changeEvents.prov_a, [{ y: 2015, m: 3, d: 4, owner: 'B1' }], '新键原样保留（月日不被抹）');
    deepEq(next.changeEvents.prov_b, [{ y: 2016, m: null, d: null, owner: 'B2' }], '旧键只补新键没有的省');
    assert(!('changeYears' in next), '旧键仍要删');
    return '新键优先 + 旧键补缺';
  });

  check('c4 旧值非数字 → 丢弃该省条目（不许造出 NaN 日期）', () => {
    const sc = scen('乙', 2010, 2020, { prov_a: 'B1' }, { changeYears: { prov_a: '不是年', prov_b: 2015 } });
    const next = normalizeScenarioDates(sc);
    deepEq(Object.keys(next.changeEvents), ['prov_b'], '只留合法省');
    return '脏值静默丢弃（不可造 NaN）';
  });

  check('c5 没有日期键 → 原引用返回（不是所有剧本都写过易主日期）', () => {
    const sc = scen('甲', 2000, 2010, { prov_a: 'A1' });
    eq(normalizeScenarioDates(sc), sc, '无日期键 → 原引用');
    eq(normalizeScenarioDates(null), null, 'null 安全');
    return '零侵入';
  });

  check('c6 normalizeScenarioDict：整表迁移 + 只说改动过的剧本；无改动时整表保持原引用', () => {
    const mk = () => ({
      甲: scen('甲', 2000, 2010, { p: 'A' }),
      乙: scen('乙', 2010, 2020, { p: 'B' }, { changeYears: { p: 2015 } }),
    });
    const dict = mk();
    const r1 = normalizeScenarioDict(dict);
    deepEq(r1.migrated, ['乙'], '点名迁移过的剧本');
    eq(r1.scenarios['甲'], dict['甲'], '没改动的保持原引用');
    assert(r1.scenarios['乙'] !== dict['乙'], '改动的换新对象');
    eq(r1.scenarios['乙'].changeEvents.p[0].y, 2015, '值正确');
    // 第二轮（已是新格式）→ 整表原引用、零迁移
    const r2 = normalizeScenarioDict(r1.scenarios);
    eq(r2.scenarios, r1.scenarios, '全部无旧键时整表原引用');
    deepEq(r2.migrated, [], '无迁移');
    // ⚠️ 数组入参必须原样往返（buildTimeline 手里就是数组）
    const arr = [scen('甲', 2000, 2010, { p: 'A' })];
    const r3 = normalizeScenarioDict(arr);
    assert(Array.isArray(r3.scenarios), '数组入参 → 数组出参（返回字典会让下游 [...scenarios] 抛错）');
    eq(r3.scenarios, arr, '无改动时原引用');
    const arr2 = [scen('乙', 2010, 2020, { p: 'B' }, { changeYears: { p: 2015 } })];
    const r4 = normalizeScenarioDict(arr2);
    assert(Array.isArray(r4.scenarios) && r4.scenarios.length === 1, '数组也要能迁移');
    deepEq(r4.migrated, ['乙'], '数组里点名用剧本 id');
    return '迁移点名 + 原引用保持 + 数组/字典同形往返';
  });

  // ══ D. 区间与月日合法性 ══
  check('d1 validateChangeDateInRange：年守区间、月 1-12、日按真实月天数', () => {
    eq(validateChangeDateInRange({ y: 2015, m: 5, d: 12 }, 2010, 2020).ok, true, '合法');
    eq(validateChangeDateInRange({ y: 2010 }, 2010, 2020).ok, true, '下边界含（只到年）');
    eq(validateChangeDateInRange({ y: 2020, m: 12, d: 31 }, 2010, 2020).ok, true, '上边界含');
    eq(validateChangeDateInRange({ y: 2009 }, 2010, 2020).ok, false, '下越界');
    eq(validateChangeDateInRange({ y: 2021 }, 2010, 2020).ok, false, '上越界');
    eq(validateChangeDateInRange({ y: 2015, m: 13 }, 2010, 2020).ok, false, '13 月');
    eq(validateChangeDateInRange({ y: 2015, m: 0 }, 2010, 2020).ok, false, '0 月');
    eq(validateChangeDateInRange({ y: 2015, m: 2, d: 30 }, 2010, 2020).ok, false, '2 月没有 30 日');
    eq(validateChangeDateInRange({ y: 2016, m: 2, d: 29 }, 2010, 2020).ok, true, '闰年 2-29 合法');
    eq(validateChangeDateInRange({ y: 2015, m: 2, d: 29 }, 2010, 2020).ok, false, '平年 2-29 越界');
    eq(validateChangeDateInRange({ y: 2015, m: 4, d: 31 }, 2010, 2020).ok, false, '4 月只有 30 天');
    eq(validateChangeDateInRange({ y: 2015, m: 12, d: 31 }, 2010, 2020).ok, true, '12-31 合法');
    eq(validateChangeDateInRange({ y: 2015, m: 1, d: 1 }, 2010, 2020).ok, true, '1-1 合法');
    eq(validateChangeDateInRange(null, 2010, 2020).ok, false, 'null');
    assert(/2010 ~ 2020/.test(validateChangeDateInRange({ y: 2021 }, 2010, 2020).reason), '越界要点名区间');
    assert(/只有 28 天/.test(validateChangeDateInRange({ y: 2015, m: 2, d: 29 }, 2010, 2020).reason), '日越界要点名当月天数');
    return '边界含 / 月日脏值拒 / 闰年正确';
  });

  check('d2 validateChangeDate（带 tl 的薄包装）与 D1 必须等价 —— 不许两份比较', () => {
    const tl = buildTimeline([
      scen('甲', 2000, 2010, { p: 'A' }),
      scen('乙', 2010, 2020, { p: 'B' }),
    ]);
    eq(validateViaTl(tl, 1, { y: 2015, m: 5, d: 12 }).ok, true, '区间内');
    eq(validateViaTl(tl, 1, { y: 2021 }).ok, false, '越界');
    eq(validateViaTl(tl, 1, { y: 2015, m: 2, d: 30 }).ok, false, '日越界');
    eq(validateViaTl(tl, 99, { y: 2015 }).ok, false, '剧本序号越界');
    eq(validateViaTl(null, 0, { y: 2000 }).ok, false, '空时间轴');
    // 等价性：同一输入两条路径必须同判
    for (const d of [{ y: 2015, m: 2, d: 29 }, { y: 2016, m: 2, d: 29 }, { y: 2009 }, { y: 2020, m: 12, d: 31 }]) {
      eq(validateViaTl(tl, 1, d).ok, validateChangeDateInRange(d, 2010, 2020).ok, `等价 ${JSON.stringify(d)}`);
    }
    return '两条路径同判';
  });

  // ══ E. 归属查询（月日精度真的生效）══
  // 🔴 为什么这一段的夹具是**手搓时间轴模型**而不是 `buildTimeline(...)`（踩了五次才定）：
  //    `changed`（= 谁算易主）判的是**谱系差异**，而谱系由 `computeLineage` 的
  //    「相邻剧本省份集合重叠度**贪心继承**」推出。那套规则有两条很反直觉的后果：
  //      ① 与上代有重叠的「新」势力会**继承旧谱系**（不看谁先谁后）→「甲国改名叫丙国」
  //         会被判成继承 → 谱系没变 → **不进 changed**（易主事件根本认不出来）；
  //      ② 重叠度平局由 `localeCompare`（还依赖 ICU 排序）裁决 →「谁变了」变得**依赖省数**，
  //         实测同一个夹具改一个省名就能从 changed=[] 翻成 changed=['c']。
  //    结论：**别拿 buildTimeline 驱动的夹具去断言日期行为** —— 那是在测谱系匹配器，
  //    会把「测日期」变成「猜贪心配对」。这里改成手搓模型（只喂 `byProvince`，其余字段无关），
  //    把日期逻辑与谱系逻辑彻底解耦；谱系那一层已有 `test_41` / `test_scenario_slices` 在守。
  const stubEra = (y, byProvince, changed) => ({
    changed, explicit: {}, byProvince, events: [], firstDate: {}, lastDate: {},
  });

  /** 手搓两代时间轴；第二代的归属/事件由参数给定 */
  const handTimeline = (era1ByProvince, era1Ownership, era1Changed) => ({
    minYear: 1000, maxYear: 1100,
    years: [{ start: 1000, end: 1050 }, { start: 1050, end: 1100 }],
    scenarios: [
      { id: '甲', name: '甲', ownership: { A: '甲国' } },
      { id: '乙', name: '乙', ownership: era1Ownership },
    ],
    eraChg: [stubEra(1000, {}, []), stubEra(1050, era1ByProvince, era1Changed)],
    gaps: [], lineages: [], lineageOf: [], stats: {},
  });

  const ev = (pid, y, m, d, owner, explicit = true) => ({
    provinceId: pid, y, m, d, owner, explicit, synthesized: !explicit,
  });

  check('e1 🔴 月日精度：同一年内，6 月前是旧主、6 月后是新主（旧模型做不到）', () => {
    const tl = handTimeline(
      { A: [ev('A', 1045, 6, 1, '乙国')] }, { A: '乙国' }, ['A'],
    );
    // 易主**日前**：仍是旧主；且颜色要在旧主所属的那个剧本里查
    const before = currentOwnerRef(tl, 1, 'A', { y: 1045, m: 5, d: 31 });
    eq(before.owner, '甲国', '易主日前仍是旧主（同一年内，旧模型只能整年切）');
    eq(before.era, 0, '旧主颜色要在上一代查（跨代 polity id 不通用）');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 6, d: 1 }).owner, '乙国', '易主当天已归新主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 6, d: 2 }).owner, '乙国', '易主后');
    eq(baseOwnerRef(tl, 1, 'A', { y: 1045, m: 7 }).owner, '甲国', '底色刻意保持旧主（EU4 斜线）');
    eq(isStriped(tl, 1, 'A', { y: 1045, m: 5, d: 31 }), false, '未落定不画斜线');
    eq(isStriped(tl, 1, 'A', { y: 1045, m: 6, d: 1 }), true, '落定后画斜线');
    deepEq(settledCount(tl, 1, { y: 1045, m: 5, d: 31 }), { settled: 0, total: 1 }, '5 月底未落定');
    deepEq(settledCount(tl, 1, { y: 1045, m: 6, d: 1 }), { settled: 1, total: 1 }, '6-1 落定');
    // 只给年份的查询 = 1 月 1 日（缺省口径）→ 6 月那次还不算落定
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045 }).owner, '甲国', '只给年 = 1 月 1 日 → 仍是旧主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1046 }).owner, '乙国', '下一年是新主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 1, d: 1 }).owner, '甲国', '显式 1-1 与缺省同判');
    // 数字年份入参（旧调用点）按「该年 1 月 1 日」处理 —— 与上面显式 1-1 同判
    eq(currentOwnerRef(tl, 1, 'A', 1045).owner, '甲国', '裸数字年份 = 该年 1-1');
    eq(currentOwnerRef(tl, 1, 'A', 1046).owner, '乙国', '裸数字下一年');
    return '年内前后半段归属相反 + 斜线/落定随动';
  });

  check('e2 同省同年多次易主：按日期逐条落定，最后一次才决定归属（旧模型装不下）', () => {
    const tl = handTimeline(
      { A: [ev('A', 1045, 3, 1, '乙国'), ev('A', 1045, 9, 1, '丙国')] },
      { A: '丙国' }, ['A'],
    );
    eq(eventCountInEra(tl, 1, 'A'), 2, '本剧本内两条事件');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 2 }).owner, '甲国', '3 月前是旧主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 5 }).owner, '乙国', '3 月后是中间主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 10 }).owner, '丙国', '9 月后是末主');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1049 }).owner, '丙国', '剧本末尾仍是末主');
    eq(isStriped(tl, 1, 'A', { y: 1045, m: 5 }), true, '第一条落定即开始斜线');
    eq(settledCount(tl, 1, { y: 1045, m: 2 }).settled, 0, '两条都还没落定');
    eq(settledCount(tl, 1, { y: 1045, m: 5 }).settled, 1, '第一条已落定');
    deepEq(tl.eraChg[1].byProvince.A.map((e) => [e.m, e.owner]), [[3, '乙国'], [9, '丙国']], '事件按日期升序');
    return '同年两次易主逐条生效（一省一剧本一值的旧模型做不到）';
  });

  check('e3 中间主是谁也认得出来：底色查的是**上一代**、斜线是**当前**归属', () => {
    const tl = handTimeline(
      { A: [ev('A', 1045, 3, 1, '乙国'), ev('A', 1045, 9, 1, '丙国')] },
      { A: '丙国' }, ['A'],
    );
    // 关键：即使已经换过两轮，`baseOwnerRef` 仍必须回上一代（甲国）——
    // 否则 EU4 斜线会变成「新主底色 + 新主斜线」= 看不出谁占了谁
    eq(baseOwnerRef(tl, 1, 'A', { y: 1045, m: 5 }).owner, '甲国', '底色 = 上一代');
    eq(baseOwnerRef(tl, 1, 'A', { y: 1045, m: 5 }).era, 0, '底色颜色去上一代查');
    eq(currentOwnerRef(tl, 1, 'A', { y: 1045, m: 5 }).owner, '乙国', '当前归属 = 中间主');
    eq(baseOwnerAt(tl, 1, 'A', { y: 1049 }), '甲国', 'baseOwnerAt 同口径');
    eq(currentOwnerAt(tl, 1, 'A', { y: 1049 }), '丙国', 'currentOwnerAt 同口径');
    return '中间主 + 底色/当前两套查询';
  });

  check('e4 lastEventAtOrBefore / hasSettledAt：边界（同一天算落定）与空列表', () => {
    const list = [{ y: 2015, m: 3, d: 1, owner: 'B' }, { y: 2015, m: 9, d: 1, owner: 'C' }];
    eq(lastEventAtOrBefore(list, { y: 2015, m: 3, d: 1 }).owner, 'B', '当天含');
    eq(lastEventAtOrBefore(list, { y: 2015, m: 2, d: 28 }), null, '之前给 null');
    eq(lastEventAtOrBefore(list, { y: 2016 }).owner, 'C', '之后给最后一条');
    eq(lastEventAtOrBefore([], { y: 2016 }), null, '空列表');
    eq(lastEventAtOrBefore(null, { y: 2016 }), null, 'null 列表');
    eq(hasSettledAt(list, { y: 2015, m: 3, d: 1 }), true, '当天已落定');
    eq(hasSettledAt(list, { y: 2015, m: 2, d: 1 }), false, '之前未落定');
    return '边界 + 空安全';
  });

  check('e5 maxDate/minDate：null 安全', () => {
    eq(formatDate(maxDate({ y: 2015 }, { y: 2016 })), '2016', '取晚');
    eq(formatDate(minDate({ y: 2015 }, { y: 2016 })), '2015', '取早');
    eq(maxDate(null, { y: 2016 }).y, 2016, 'null 取另一个');
    eq(minDate({ y: 2015 }, null).y, 2015, 'null 取另一个');
    return '4 例';
  });

  // ══ F. 迁移网：旧 changeYears 在真实时间轴里也必须被认成显式日期 ══
  // 🔴 这条守的是本轮**最危险**的静默失效：入口若漏了迁移，旧键读不出来 →
  //    `computeEraChanges` 会退回**合成值**（区间内均匀铺开、看起来很像真的）→
  //    用户「明明录过易主年份」却看到一堆编出来的日期，而且**不报错**。
  //    用 `successorOf` 把谱系显式连起来（不依赖重叠度贪心配对），夹具才是确定的。
  check('f1 🔴 buildTimeline 自带迁移网：喂旧 changeYears → 认成显式日期 + 单条 + 月日 null，且不再残留旧键', () => {
    const raw = [
      // ⚠️ 谱系夹具必须照抄已实证能产出非空 changed 的形状（见 t1）：甲代只持有 A，
      //    乙代有三个势力且**多变出来的省**（B/C）上一代无人持有 → 谱系必然不同 → 判为易主。
      //    别自己设计「看起来像易主」的夹具：`computeLineage` 按重叠度贪心继承，
      //    几乎总能把新势力配到旧势力上，于是 changed 静默为空（这一段踩了六次）。
      scen('甲', 1000, 1050, { A: '甲国' }, { polities: [{ id: '甲国', name: '甲国' }] }),
      scen('乙', 1050, 1100, { A: '乙国', B: '丙国', C: '丁国' }, {
        polities: [{ id: '乙国', name: '乙国' }, { id: '丙国', name: '丙国' }, { id: '丁国', name: '丁国' }],
        changeYears: { B: 1015 },                                      // 旧键：只录到年
      }),
    ];
    const tl = buildTimeline(raw);
    assert(tl.eraChg[1].changed.includes('B'), `B 必须是易主省（实际 ${JSON.stringify(tl.eraChg[1].changed)}）`);
    const list = tl.eraChg[1].byProvince.B;
    eq(list.length, 1, '旧键 → 恰好一条事件');
    eq(list[0].explicit, true, '必须被认成**显式**（这里退化成合成值就是静默丢日期）');
    eq(list[0].synthesized, false, '不是合成值');
    eq(list[0].y, 1015, '年份来自旧键');
    deepEq([list[0].m, list[0].d], [null, null], '旧键只有年 → 月日保持 null（不许悄悄补 1-1）');
    eq(list[0].owner, '丙国', 'owner 取自本剧本 ownership（旧模型里是隐含的）');
    eq(tl.stats.explicitChangeEvents, 1, '统计认下 1 条显式');
    // 归一路径（buildTimeline 内部）之后，内存里的旧键必须已经没了（否则会一直双写）
    const snapped = normalizeScenarioDict(raw).scenarios[1];
    assert(!('changeYears' in snapped), '迁移后不许残留旧键');
    assert(Array.isArray(snapped.changeEvents.B) && snapped.changeEvents.B.length === 1, '新键就位');
    // 幂等：拿迁移结果再跑一遍，时间轴逐字段一致
    const again = buildTimeline([raw[0], snapped]);
    deepEq(again.eraChg[1].byProvince.B, list, '第二次构建结果逐字段一致（幂等）');
    return '旧键 → 显式日期（单条、月日 null、owner 补全），且无旧键残留、幂等';
  });

  check('f2 缺省（没录日期）仍走合成值：区间内均匀铺开、只有年、标记 synthesized', () => {
    const tl = buildTimeline([
      scen('甲', 1000, 1050, { A: '甲国' }, { polities: [{ id: '甲国', name: '甲国' }] }),
      scen('乙', 1050, 1100, { A: '乙国', B: '丙国', C: '丁国' }, {
        polities: [{ id: '乙国', name: '乙国' }, { id: '丙国', name: '丙国' }, { id: '丁国', name: '丁国' }],
      }),
    ]);
    // 乙代多变出来的省上一代无人持有 → 与上代谱系必然不同 → 判为易主（三方各一条合成值）
    assert(tl.eraChg[1].changed.includes('B'), 'B 是易主省');
    assert(tl.eraChg[1].changed.includes('C'), 'C 是易主省');
    for (const pid of ['B', 'C']) {
      const e = tl.eraChg[1].byProvince[pid][0];
      eq(e.explicit, false, `${pid} 是合成值`);
      eq(e.synthesized, true, `${pid} 合成标记`);
      deepEq([e.m, e.d], [null, null], `${pid} 合成只有年`);
      assert(e.y >= 1050 && e.y <= 1100, `${pid} 合成年份落在剧本区间内（实际 ${e.y}）`);
    }
    eq(tl.stats.changeEvents, tl.eraChg[1].changed.length, '事件总数 = 变化省数（各一条合成）');
    eq(tl.stats.explicitChangeEvents, 0, '一条显式都没有');
    eq(tl.stats.explicitChangeYears, tl.stats.explicitChangeEvents, '旧别名同值（兼容既有调用点）');
    return '合成兜底不变（全合成时显式数 = 0）';
  });

  // ── 汇总 ──
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败：');
    for (const f of failed) console.log(`  · ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('用例异常：', e); process.exit(1); });
