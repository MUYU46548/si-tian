#!/usr/bin/env node
/**
 * Node 单元测试：历史剧本「逐年切片」纯函数（src/renderer/src/utils/scenarioSlices.js）
 *
 * 为什么必须有这一层：
 *   ① 「哪些年份各出一帧」是**判定**，不是遍历结果 —— 真实数据 12 剧本 / 3488 年，
 *      按年出帧 = 3488 张。判定错了不会报错：只会导出一堆重复帧，或者**漏掉整代底图**
 *      （时代交界处没有易主但换名换色，漏了起点帧就少一代）。
 *   ② 切片可信度取决于日期真假：`computeEraChanges` 在缺显式值时会在区间内**均匀铺开**
 *      一个合成年份，看起来很像真的。把「显式 / 合成」分开计数是本功能的诚信底线。
 *   ③ 帧文件名是渲染层造载荷与主进程落盘的**共同契约**，两份实现必然错位。
 *
 * 用法：node scripts/tests/unit/test_scenario_slices.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM 且有相对 import（./scenarioTimeline 无扩展名，Node 解析不了）——
 *    与 test_province_shape.js 同法：复制到临时目录 + 补 `.js` 扩展名 + 写 `{"type":"module"}`，
 *    源码一个字符都不改。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['scenarioSlices.js', 'scenarioTimeline.js', 'scenarioDates.js'];

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

/** 可写临时根（MSYS 的 /tmp 在 Windows 上 Node 不认 —— 与 test_province_shape 同因） */
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

/** 剧本夹具（形状与 scenarioEditing.createScenario 一致） */
function scen(id, name, order, start, end, polities, ownership, extra) {
  return {
    id, name, order,
    era: { roman: '', label: name, startYear: String(start), endYear: String(end) },
    polities: polities || [], ownership: ownership || {},
    ...(extra || {}),
  };
}

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-slices-'));
  // 补扩展名：`from './xxx'` 与 `from './xxx.js'` 都要能吃（后者已是合法 ESM，别重复补）
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const slices = await import(pathToFileURL(path.join(tmp, 'scenarioSlices.js')).href);
  const timelineMod = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);
  const {
    collectSliceFrames, changeDateStats, validateChangeDate, validateChangeDateInRange,
    sliceFrameName, normalizeSlicePoints, MAX_SLICE_FRAMES, FRAME_SOURCE,
  } = slices;
  const { buildTimeline, eraIndexOfYear } = timelineMod;

  // ── 基础时间轴 ──
  // ⚠️ 谱系是按「相邻剧本省份重叠度」贪心继承的（`computeLineage`），一个前代集团只能被一个后代继承。
  //    所以「乙时代两个省都算变化」不能靠两个势力 —— 甲时代只占 prov_a，乙时代的 prov_b/prov_c
  //    在上一代**无人持有**（无重叠）→ 两个都拿新谱系 → eraChg[1].changed = ['prov_b','prov_c']。
  const baseScenarios = () => [
    scen('甲', '甲时代', 1, 2000, 2010, [{ id: 'A1', name: '甲国' }], { prov_a: 'A1' }),
    scen('乙', '乙时代', 2, 2010, 2020,
      [{ id: 'B1', name: '乙国' }, { id: 'B2', name: '乙南' }, { id: 'B3', name: '乙东' }],
      { prov_a: 'B1', prov_b: 'B2', prov_c: 'B3' }),
  ];
  /** 月份/日缺省的日期对象（= 该年 1 月 1 日）；显式事件用 `{y,m,d}` */
  const D = (y, m = null, d = null) => ({ y, m, d });

  // ---------- 1. 帧集合：起点帧 + 易主帧 ----------
  check('t1 两剧本自造数据 → 起点帧 2 + 易主帧 2（合成日期），按日期升序且 era 与日期一致', () => {
    const tl = buildTimeline(baseScenarios());
    const { frames, stats } = collectSliceFrames(tl);
    const years = frames.map((f) => f.year);
    // 合成值：span=10，i=0 → 2010+round(1/3*10)=2013；i=1 → 2010+round(2/3*10)=2017
    deepEq(years, [2000, 2010, 2013, 2017], '帧年份');
    eq(stats.frameCount, 4, '帧数');
    eq(stats.eraCount, 2, '剧本起点帧数');
    eq(stats.changeCount, 2, '易主次数');
    eq(stats.bookmarkCount, 0, '没有书签时书签帧数 = 0');
    deepEq(frames.map((f) => f.kind), ['era', 'era', 'change', 'change'], '帧种类');
    for (const f of frames) eq(f.era, eraIndexOfYear(tl, f.date.y), `frame.era(${f.year}) 与 eraIndexOfYear 一致`);
    eq(frames[2].changed.length, 1, '2013 帧的易主省数');
    eq(frames[0].changed.length, 0, '起点帧不带易主');
    // 每帧都必须带日期对象与来源标记（frames.json 与对话框都吃它）
    for (const f of frames) {
      assert(f.date && Number.isFinite(f.date.y), '每帧带 date');
      deepEq(f.sources.length > 0, true, '每帧带 sources');
    }
    deepEq(frames[1].sources, [FRAME_SOURCE.ERA], '起点帧来源 = era');
    deepEq(frames[2].sources, [FRAME_SOURCE.CHANGE], '易主帧来源 = change');
    // 合成日期只有年 → 月日为 null（不许悄悄补 1-1）
    deepEq([frames[2].date.m, frames[2].date.d], [null, null], '合成日期月日为 null');
    return `帧 ${years.join(' / ')}；起点 ${stats.eraCount} + 易主 ${stats.changeCount}`;
  });

  check('t2 显式日期覆盖合成值，且会计入 explicitChanges（月日保留）', () => {
    const list = baseScenarios();
    list[1].changeEvents = { prov_c: [D(2015, 5, 12)] };
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    deepEq(frames.map((f) => f.year), [2000, 2010, 2013, 2015], '帧年份');
    eq(stats.explicitChanges, 1, '显式易主数');
    eq(stats.synthesizedChanges, 1, '合成易主数');
    deepEq(frames[3].explicit, { prov_c: true }, '显式标记只落在被显式指定的省上');
    eq(frames[3].changed[0], 'prov_c', '2015 帧属 prov_c');
    deepEq([frames[3].date.y, frames[3].date.m, frames[3].date.d], [2015, 5, 12], '月日一路带到帧上');
    return '显式 2015-05-12 生效；统计 1 显式 / 1 合成';
  });

  check('t3 同一年多个省易主 → 落在同一帧（日期缺省=1 月 1 日，聚合口径一致）', () => {
    const list = baseScenarios();
    list[1].changeEvents = { prov_b: [D(2012)], prov_c: [D(2012)] };
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    const f = frames.find((x) => x.year === 2012);
    assert(!!f, '缺 2012 帧');
    deepEq(f.changed, ['prov_b', 'prov_c'], '同帧两省');
    eq(f.changed.length, 2, 'changed 数');
    eq(stats.frameCount, 3, '合并后总帧数（2000 / 2010 / 2012）');
    deepEq(frames.map((x) => x.year), [2000, 2010, 2012], '帧年份');
    return '同年两省合并为 1 帧';
  });

  check('t4 同日期的两条日期写法（同年 1-1 与只给年）→ 同一帧，不重复出图', () => {
    // 「只给年」的语义就是该年 1 月 1 日（见 scenarioDates 的文件头），所以这两种写法必须同帧
    const list = baseScenarios();
    list[1].changeEvents = { prov_b: [D(2012)], prov_c: [D(2012, 1, 1)] };
    const tl = buildTimeline(list);
    const { frames } = collectSliceFrames(tl);
    const hits = frames.filter((x) => x.year === 2012);
    eq(hits.length, 1, '同年只出一帧');
    eq(hits[0].changed.length, 2, '两省落在同一帧');
    eq(hits[0].dateKey, '2012-01-01', '缺省口径归一为 1-1');
    return '同年 2012 与 2012-01-01 合并为 1 帧';
  });

  check('t5 易主日期恰好落在剧本起点（同一日期）→ 合并成 mixed；年中易主则与起点帧分开', () => {
    // 起点帧的日期是「剧本起点年 + 月日缺省」= 该年 1 月 1 日 → 只有同一天的易主才合并
    const list = baseScenarios();
    list[1].changeEvents = { prov_b: [D(2010)] };   // 2010-01-01 = 乙时代起点
    const tl = buildTimeline(list);
    const { frames } = collectSliceFrames(tl);
    const f = frames.find((x) => x.dateKey === '2010-01-01');
    eq(f.kind, 'mixed', '起点 + 易主 = mixed');
    eq(f.changed.length, 1, '该帧带 1 个省');
    deepEq(f.sources.slice().sort(), [FRAME_SOURCE.CHANGE, FRAME_SOURCE.ERA].sort(), '两个来源都在');
    eq(frames.filter((x) => x.year === 2010).length, 1, '同一日期只出一帧');

    // 反面对照：年中易主（3-04）与起点（1-01）是**两个不同日期** → 两帧，起点帧仍纯净
    const list2 = baseScenarios();
    list2[1].changeEvents = { prov_b: [D(2010, 3, 4)] };
    const tl2 = buildTimeline(list2);
    const { frames: f2 } = collectSliceFrames(tl2);
    eq(f2.filter((x) => x.year === 2010).length, 2, '同年两个不同日期 = 两帧');
    const start = f2.find((x) => x.dateKey === '2010-01-01');
    eq(start.kind, 'era', '1-1 那帧仍是纯起点帧');
    eq(start.changed.length, 0, '起点帧不带易主');
    const mid = f2.find((x) => x.dateKey === '2010-03-04');
    eq(mid.kind, 'change', '3-04 帧是纯易主帧');
    deepEq(mid.sources, [FRAME_SOURCE.CHANGE], '只有 change 一个来源');
    return '同日合并为 mixed；年中易主与起点帧分开';
  });

  check('t6 谱系全部人工纠正（无变化）→ 只剩起点帧（不是零帧）', () => {
    // 「变化」= 谱系与前一代不同；**上一代没人持有也算变化**（无主 → 有主）。
    // 所以要真的「无变化」，两代必须逐省对上，靠 successorOf 一个个指。
    const list = [
      scen('甲', '甲时代', 1, 2000, 2010,
        [{ id: 'A1', name: '甲国' }, { id: 'A2', name: '甲南' }, { id: 'A3', name: '甲东' }],
        { prov_a: 'A1', prov_b: 'A2', prov_c: 'A3' }),
      scen('乙', '乙时代', 2, 2010, 2020,
        [{ id: 'B1', name: '乙国', successorOf: 'A1' }, { id: 'B2', name: '乙南', successorOf: 'A2' },
          { id: 'B3', name: '乙东', successorOf: 'A3' }],
        { prov_a: 'B1', prov_b: 'B2', prov_c: 'B3' }),
    ];
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    deepEq(frames.map((f) => f.year), [2000, 2010], '只剩两个起点帧');
    eq(stats.changeCount, 0, '无易主');
    eq(tl.explicitLineageCount, 3, '三条人工谱系都被认下');
    return '无变化时仍有两个时代起点帧';
  });

  // ---------- 1b. 切片书签（本轮新增能力）----------
  check('t7 书签帧：默认必出、带名字与 id、来源标记 bookmark', () => {
    const tl = buildTimeline(baseScenarios());
    const points = [
      { id: 'sp1', label: '甲午战争', y: 2005, m: 4, d: 17 },
      { id: 'sp2', label: '乙代开国', y: 2011 },
    ];
    const { frames, stats } = collectSliceFrames(tl, points);
    eq(stats.bookmarkCount, 2, '两个书签');
    const f1 = frames.find((x) => x.dateKey === '2005-04-17');
    assert(!!f1, '缺 2005-04-17 帧');
    eq(f1.kind, 'bookmark', '纯书签帧 kind=bookmark');
    deepEq(f1.bookmarkIds, ['sp1'], '带书签 id（供 UI 反查改名/删除）');
    eq(f1.label, '甲午战争', '展示名优先用书签名');
    deepEq(f1.sources, [FRAME_SOURCE.BOOKMARK], '来源标记');
    const f2 = frames.find((x) => x.dateKey === '2011-01-01');
    assert(!!f2, '缺 2011 帧');
    deepEq([f2.date.m, f2.date.d], [null, null], '只给年的书签 → 月日保持 null');
    deepEq(f2.sources, [FRAME_SOURCE.BOOKMARK], '2011 不是剧本起点也不是易主年 → 纯书签');
    return '书签帧带 id/名字/来源；只给年不补月日';
  });

  check('t8 书签与自动帧**同一天合并**（一条时间点不出两张图）', () => {
    const list = baseScenarios();
    list[1].changeEvents = { prov_c: [D(2015, 5, 12)] };
    const tl = buildTimeline(list);
    // 书签正好落在同一个易主日 + 落在剧本起点
    const points = [
      { id: 'sp1', label: '会战', y: 2015, m: 5, d: 12 },
      { id: 'sp2', label: '乙代开国', y: 2010 },
    ];
    const { frames, stats } = collectSliceFrames(tl, points);
    const f = frames.filter((x) => x.dateKey === '2015-05-12');
    eq(f.length, 1, '同一日期只有一帧');
    eq(f[0].changed.length, 1, '易主信息没丢');
    eq(f[0].label, '会战', '书签名被带上');
    assert(f[0].sources.includes(FRAME_SOURCE.CHANGE), '来源含 change');
    assert(f[0].sources.includes(FRAME_SOURCE.BOOKMARK), '来源含 bookmark');
    eq(stats.bookmarkCount, 2, '书签计数按书签条数（不是按帧数）');
    // 起点 2010-01-01 与书签（只给年 → 1-1）同年同日 → 合并
    const start = frames.filter((x) => x.dateKey === '2010-01-01');
    eq(start.length, 1, '起点与书签同日 → 一帧');
    deepEq(start[0].sources.slice().sort(), [FRAME_SOURCE.BOOKMARK, FRAME_SOURCE.ERA].sort(), '两个来源都在');
    return '书签 ∪ 自动帧按日期合并，来源与名字都保留';
  });

  check('t9 normalizeSlicePoints：脏值丢弃、按日期升序、不生成 id（纯函数不许有随机性）', () => {
    const out = normalizeSlicePoints([
      { id: 'b', label: '乙', y: 2020 },
      { id: 'a', label: '甲', y: 2010, m: 5 },
      { label: '无 id 也留着', y: 2015 },
      { id: 'bad', label: '脏', y: '不是年' },
      null,
      'nope',
    ]);
    deepEq(out.map((p) => p.id), ['a', '', 'b'], '升序（2010 → 2015 → 2020）');
    deepEq(out.map((p) => p.y), [2010, 2015, 2020], '年份');
    eq(out[0].m, 5, '月保留');
    eq(normalizeSlicePoints(null).length, 0, 'null 安全');
    eq(normalizeSlicePoints(undefined).length, 0, 'undefined 安全');
    // 确定性：同一输入两次结果逐字节一致（书签排序不乱跳）
    deepEq(normalizeSlicePoints([{ id: 'z', y: 2011 }, { id: 'a', y: 2011 }]),
      normalizeSlicePoints([{ id: 'a', y: 2011 }, { id: 'z', y: 2011 }]), '同日期按 id 稳定排序');
    return '脏值丢弃 + 升序 + 确定性';
  });

  // ---------- 2. 区间外日期：必须被标出来，不许静默 ----------
  check('t10 易主日期落在本剧本区间外 → outOfRange 标记 + changeDateStats.outOfRange 明细', () => {
    const list = baseScenarios();
    list[1].changeEvents = { prov_b: [D(1999, 6, 1)] };   // 乙时代是 2010~2020
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    const f = frames.find((x) => x.year === 1999);
    assert(!!f, '区间外日期仍要出帧（数据如此，导不出才是隐瞒）');
    eq(f.outOfRange, true, '帧被标为区间外');
    eq(stats.outOfRangeChanges, 1, '统计里的区间外条数');
    const d = changeDateStats(tl);
    eq(d.outOfRange.length, 1, '体检明细条数');
    eq(d.outOfRange[0].provinceId, 'prov_b', '点名省份');
    eq(d.outOfRange[0].start, 2010, '点名区间起点');
    eq(d.outOfRange[0].end, 2020, '点名区间终点');
    deepEq([d.outOfRange[0].date.m, d.outOfRange[0].date.d], [6, 1], '明细带月份（月日精度）');
    eq(d.outOfRange[0].text, '1999-06-01', '明细带人话文本');
    return '区间外 1 条：prov_b 1999-06-01 ∉ [2010,2020]';
  });

  check('t11 日期体检把「显式 / 合成」分开计数，并数出**同省多次易主**', () => {
    const list = baseScenarios();
    list[1].changeEvents = { prov_b: [D(2015, 3, 1), D(2015, 9, 1)] };   // 同省同年两次
    const tl = buildTimeline(list);
    const d = changeDateStats(tl);
    eq(d.total, 3, '事件总数 = 2（prov_b 两次）+ 1（prov_c 合成）');
    eq(d.explicit, 2, '显式 2 条');
    eq(d.synthesized, 1, '合成 1 条');
    eq(d.explicitProvinces, 1, '有显式日期的**省**只有 1 个（与事件条数不同口径）');
    deepEq(d.multiPerProvince, [{ era: 1, provinceId: 'prov_b', count: 2 }], '点名同省多次易主');
    const none = changeDateStats(buildTimeline(baseScenarios()));
    eq(none.explicit, 0, '一条都没录时显式数 = 0');
    eq(none.synthesized, 2, '全算合成');
    deepEq(none.multiPerProvince, [], '没多次易主时清单为空');
    return '显式 2 / 合成 1；同省两次被点名';
  });

  // ---------- 3. 日期合法性判定（面板内联提示与写入守卫共用）----------
  check('t12 validateChangeDate：年守区间、月 1-12、日按真实月天数', () => {
    const tl = buildTimeline(baseScenarios());
    eq(validateChangeDate(tl, 1, D(2015, 5, 12)).ok, true, '区间内');
    eq(validateChangeDate(tl, 1, D(2010)).ok, true, '下边界含（只到年）');
    eq(validateChangeDate(tl, 1, D(2020, 12, 31)).ok, true, '上边界含');
    eq(validateChangeDate(tl, 1, D(2009)).ok, false, '下越界');
    eq(validateChangeDate(tl, 1, D(2021)).ok, false, '上越界');
    eq(validateChangeDate(tl, 1, D(2015, 13)).ok, false, '13 月');
    eq(validateChangeDate(tl, 1, D(2015, 0)).ok, false, '0 月');
    eq(validateChangeDate(tl, 1, D(2015, 2, 30)).ok, false, '平年 2 月没有 30 日');
    eq(validateChangeDate(tl, 1, D(2016, 2, 29)).ok, true, '闰年 2-29 合法');
    eq(validateChangeDate(tl, 1, D(2015, 4, 31)).ok, false, '4 月只有 30 天');
    eq(validateChangeDate(tl, 1, '二〇一五').ok, false, '非数字');
    eq(validateChangeDate(tl, 1, null).ok, false, 'null');
    eq(validateChangeDate(tl, 99, D(2015)).ok, false, '剧本序号越界');
    assert(/2010 ~ 2020/.test(validateChangeDate(tl, 1, D(2021)).reason), '原因里要点名区间');
    assert(/只有 28 天/.test(validateChangeDate(tl, 1, D(2015, 2, 29)).reason), '日越界要点名当月天数');
    // 带区间的薄包装必须与带 tl 的同判（同一份实现，不许两份比较）
    for (const dt of [D(2015, 2, 29), D(2016, 2, 29), D(2009), D(2020, 12, 31), D(2015, 5, 12)]) {
      eq(validateChangeDate(tl, 1, dt).ok, validateChangeDateInRange(dt, 2010, 2020).ok, `等价 ${JSON.stringify(dt)}`);
    }
    return '边界含、月日脏值拒、闰年正确、两条路径同判';
  });

  check('t13 空时间轴 / 缺字段不抛异常（冷启动与半截数据都要能活）', () => {
    deepEq(collectSliceFrames(null).frames, [], 'null 时间轴');
    deepEq(collectSliceFrames({ years: [] }).frames, [], '无剧本');
    deepEq(collectSliceFrames(null, [{ id: 'x', y: 2000 }]).frames, [], '无剧本时书签也不出帧');
    eq(collectSliceFrames(null).stats.frameCount, 0, '统计零值');
    const d = changeDateStats(undefined);
    eq(d.total, 0, '体检零值');
    deepEq(d.multiPerProvince, [], '多次易主清单零值');
    eq(validateChangeDate(null, 0, D(2000)).ok, false, '空时间轴判不通过');
    assert(MAX_SLICE_FRAMES >= 100, '帧数上限应给足（十来个剧本几十次易主完全够）');
    return `空/缺字段安全；MAX_SLICE_FRAMES=${MAX_SLICE_FRAMES}`;
  });

  // ---------- 4. 帧文件名（渲染层造载荷与主进程落盘的共同契约）----------
  check('t14 sliceFrameName：日期段补零、负数年用 n 前缀、月日缺省补 00（文件名不许出现 -）', () => {
    eq(sliceFrameName(0, { era: 0, year: 2000 }), 'frame_0001_era00_20000000.svg', '首帧（只到年 → 0000）');
    eq(sliceFrameName(11, { era: 2, date: D(2015, 5, 12) }, 'png'), 'frame_0012_era02_20150512.png', '第 12 帧 png');
    eq(sliceFrameName(3, { era: 1, date: D(1444, 11, 11) }), 'frame_0004_era01_14441111.svg', 'EU4 式切片点');
    eq(sliceFrameName(4, { era: 1, date: D(-350) }), 'frame_0005_era01_n3500000.svg', '公元前年份不带减号');
    eq(sliceFrameName(5, { era: 1, date: D(1993, 5) }), 'frame_0006_era01_19930500.svg', '只到月 → 日补 00');
    eq(sliceFrameName(0, null), 'frame_0001_era00_0.svg', '缺帧对象不抛异常');
    // 关键：只到年补 00、真 1 月 1 日补 01 —— 两者文件名必须不同（否则「只到年」被谎报成精确日期）
    assert(sliceFrameName(0, { era: 0, date: D(2000) }) !== sliceFrameName(0, { era: 0, date: D(2000, 1, 1) }),
      '只到年与真 1-1 不得同名');
    // 确定性：同一帧两次调用必须一模一样（否则重复导出无法对账）
    eq(sliceFrameName(5, { era: 1, date: D(1234, 7, 8) }), sliceFrameName(5, { era: 1, date: D(1234, 7, 8) }), '确定性');
    for (const f of [{ era: 0, date: D(-350) }, { era: 1, date: D(1444, 11, 11) }, { era: 2, date: D(2000) }]) {
      const n = sliceFrameName(0, f);
      assert(!n.includes('-'), `文件名不许含 -：${n}`);
      assert(!/[/\\]/.test(n), `文件名不许含路径分隔符：${n}`);
    }
    return '6 例 + 只到年/真 1-1 不同名 + 无 - 与分隔符 + 确定性';
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  // 汇总行必须以 `===` 开头：run_tests.py:450 只认这一行做失败摘要
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败：');
    for (const f of failed) console.log(`  · ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('用例异常：', e); process.exit(1); });
