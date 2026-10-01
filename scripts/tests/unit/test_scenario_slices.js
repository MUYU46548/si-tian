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
const DEPS = ['scenarioSlices.js', 'scenarioTimeline.js'];

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
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const slices = await import(pathToFileURL(path.join(tmp, 'scenarioSlices.js')).href);
  const timelineMod = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);
  const { collectSliceFrames, changeDateStats, validateChangeYear, sliceFrameName, MAX_SLICE_FRAMES } = slices;
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

  // ---------- 1. 帧集合：起点帧 + 易主帧 ----------
  check('t1 两剧本自造数据 → 起点帧 2 + 易主帧 2（合成年份），按年升序且 era 与年份一致', () => {
    const tl = buildTimeline(baseScenarios());
    const { frames, stats } = collectSliceFrames(tl);
    const years = frames.map((f) => f.year);
    // 合成值：span=10，i=0 → 2010+round(1/3*10)=2013；i=1 → 2010+round(2/3*10)=2017
    deepEq(years, [2000, 2010, 2013, 2017], '帧年份');
    eq(stats.frameCount, 4, '帧数');
    eq(stats.eraCount, 2, '剧本起点帧数');
    eq(stats.changeCount, 2, '易主次数');
    deepEq(frames.map((f) => f.kind), ['era', 'era', 'change', 'change'], '帧种类');
    for (const f of frames) eq(f.era, eraIndexOfYear(tl, f.year), `frame.era(${f.year}) 与 eraIndexOfYear 一致`);
    eq(frames[2].changed.length, 1, '2013 帧的易主省数');
    eq(frames[0].changed.length, 0, '起点帧不带易主');
    return `帧 ${years.join(' / ')}；起点 ${stats.eraCount} + 易主 ${stats.changeCount}`;
  });

  check('t2 显式年份覆盖合成值，且会计入 explicitChanges', () => {
    const list = baseScenarios();
    list[1].changeYears = { prov_c: 2015 };
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    deepEq(frames.map((f) => f.year), [2000, 2010, 2013, 2015], '帧年份');
    eq(stats.explicitChanges, 1, '显式易主数');
    eq(stats.synthesizedChanges, 1, '合成易主数');
    deepEq(frames[3].explicit, { prov_c: true }, '显式标记只落在被显式指定的省上');
    eq(frames[3].changed[0], 'prov_c', '2015 帧属 prov_c');
    return '显式 2015 生效；统计 1 显式 / 1 合成';
  });

  check('t3 同年多个省易主 → 合并成一帧（不是两帧重图）', () => {
    const list = baseScenarios();
    list[1].changeYears = { prov_b: 2012, prov_c: 2012 };
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

  check('t4 易主年份恰好落在剧本起点 → 与起点帧合并成 mixed，且不重复出帧', () => {
    const list = baseScenarios();
    list[1].changeYears = { prov_b: 2010 };
    const tl = buildTimeline(list);
    const { frames } = collectSliceFrames(tl);
    const f = frames.find((x) => x.year === 2010);
    eq(f.kind, 'mixed', '起点 + 易主 = mixed');
    eq(f.changed.length, 1, '该帧带 1 个省');
    eq(frames.filter((x) => x.year === 2010).length, 1, '同年只有一帧');
    return '2010 帧 kind=mixed';
  });

  check('t5 谱系全部人工纠正（无变化）→ 只剩起点帧（不是零帧）', () => {
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

  // ---------- 2. 区间外年份：必须被标出来，不许静默 ----------
  check('t6 易主年份落在本剧本区间外 → outOfRange 标记 + changeDateStats.outOfRange 明细', () => {
    const list = baseScenarios();
    list[1].changeYears = { prov_b: 1999 };   // 乙时代是 2010~2020
    const tl = buildTimeline(list);
    const { frames, stats } = collectSliceFrames(tl);
    const f = frames.find((x) => x.year === 1999);
    assert(!!f, '区间外年份仍要出帧（数据如此，导不出才是隐瞒）');
    eq(f.outOfRange, true, '帧被标为区间外');
    eq(stats.outOfRangeChanges, 1, '统计里的区间外条数');
    const d = changeDateStats(tl);
    eq(d.outOfRange.length, 1, '体检明细条数');
    eq(d.outOfRange[0].provinceId, 'prov_b', '点名省份');
    eq(d.outOfRange[0].start, 2010, '点名区间起点');
    eq(d.outOfRange[0].end, 2020, '点名区间终点');
    return `区间外 1 条：prov_b 1999 ∉ [2010,2020]`;
  });

  check('t7 日期体检把「显式 / 合成」分开计数（真实数据全是合成值时必须看得出来）', () => {
    const list = baseScenarios();
    list[1].changeYears = { prov_b: 2015 };
    const tl = buildTimeline(list);
    const d = changeDateStats(tl);
    eq(d.total, 2, '易主总数');
    eq(d.explicit, 1, '显式');
    eq(d.synthesized, 1, '合成');
    eq(tl.stats.explicitChangeYears, 1, '与时间轴自带的统计一致（同一口径）');
    const none = changeDateStats(buildTimeline(baseScenarios()));
    eq(none.explicit, 0, '一条都没录时显式数 = 0');
    eq(none.synthesized, 2, '全算合成');
    return '显式 1 / 合成 1；全合成时 explicit=0';
  });

  // ---------- 3. 年份合法性判定（面板内联提示与写入守卫共用）----------
  check('t8 validateChangeYear：区间内通过 / 区间外与非法值给原因', () => {
    const tl = buildTimeline(baseScenarios());
    eq(validateChangeYear(tl, 1, 2015).ok, true, '区间内');
    eq(validateChangeYear(tl, 1, 2010).ok, true, '下边界含');
    eq(validateChangeYear(tl, 1, 2020).ok, true, '上边界含');
    eq(validateChangeYear(tl, 1, 2009).ok, false, '下越界');
    eq(validateChangeYear(tl, 1, 2021).ok, false, '上越界');
    eq(validateChangeYear(tl, 1, '二〇一五').ok, false, '非数字');
    eq(validateChangeYear(tl, 1, null).ok, false, 'null');
    eq(validateChangeYear(tl, 99, 2015).ok, false, '剧本序号越界');
    assert(/2010 ~ 2020/.test(validateChangeYear(tl, 1, 2021).reason), '原因里要点名区间');
    return '边界含、越界拒、非法拒，且原因带区间';
  });

  check('t9 空时间轴 / 缺字段不抛异常（冷启动与半截数据都要能活）', () => {
    deepEq(collectSliceFrames(null).frames, [], 'null 时间轴');
    deepEq(collectSliceFrames({ years: [] }).frames, [], '无剧本');
    eq(collectSliceFrames(null).stats.frameCount, 0, '统计零值');
    const d = changeDateStats(undefined);
    eq(d.total, 0, '体检零值');
    eq(validateChangeYear(null, 0, 2000).ok, false, '空时间轴判不通过');
    assert(MAX_SLICE_FRAMES >= 100, '帧数上限应给足（十来个剧本几十次易主完全够）');
    return `空/缺字段安全；MAX_SLICE_FRAMES=${MAX_SLICE_FRAMES}`;
  });

  // ---------- 4. 帧文件名（渲染层造载荷与主进程落盘的共同契约）----------
  check('t10 sliceFrameName：补零、含纪元与年份、负数年份用 n 前缀（文件名不许出现 -）', () => {
    eq(sliceFrameName(0, { era: 0, year: 2000 }), 'frame_0001_era00_2000.svg', '首帧');
    eq(sliceFrameName(11, { era: 2, year: 2015 }, 'png'), 'frame_0012_era02_2015.png', '第 12 帧 png');
    eq(sliceFrameName(3, { era: 1, year: -350 }), 'frame_0004_era01_n350.svg', '公元前年份不带减号');
    eq(sliceFrameName(0, null), 'frame_0001_era00_0.svg', '缺帧对象不抛异常');
    // 确定性：同一帧两次调用必须一模一样（否则重复导出无法对账）
    eq(sliceFrameName(5, { era: 1, year: 1234 }), sliceFrameName(5, { era: 1, year: 1234 }), '确定性');
    return '4 例 + 确定性';
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
