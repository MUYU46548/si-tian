#!/usr/bin/env node
/**
 * Node 单元测试：历史剧本「势力标注」分级纯函数（src/renderer/src/utils/polityLabels.js）
 *
 * 背景（A8，2026-09-26 暮雨诉求）：
 *   历史剧本要能**自定义显示的势力名称**，并照 EU4 的做法分级 —— 放大看省名、缩小只看势力名
 *   （可简称），全名只在点开省份详情时给。分级判定 / 领土聚合 / 文本选择全部收在
 *   `polityLabels.js` 一处，避免「渲染顺手写一套、导出再写一套」——那种双源**不会报错**，
 *   只会让导出的图和画布不一样。
 *
 * 判错的后果都是静默的：
 *   · 分级方向反了 → 放大反而只剩势力简称（用户以为名字丢了）；
 *   · 质心不加面积权 → 势力标签被小碎省拽到别的势力地界里；
 *   · 退化环返回 NaN 坐标 → `fillText(NaN)` **不画也不报错** → 「有些势力的名字凭空消失」。
 *
 * 用法：node scripts/tests/unit/test_polity_labels.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'polityLabels.js');

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
function near(actual, expected, tol, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${label}: 期望 ≈${expected}（±${tol}），实际 ${actual}`);
  }
}

/** 轴对齐矩形（逆时针） */
function rect(x0, y0, w, h) {
  return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
}

const TIER_ORDER = { province: 0, polity: 1, abbr: 2 };

async function main() {
  const load = async (p) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8').toString('base64'));
  const mod = await load(SRC);
  const {
    polityLabelTier, ringAreaCentroid, aggregateTerritories, labelTextFor, labelFitsOnScreen,
    POLITY_LABEL_THRESHOLDS, LABEL_MIN_AREA_PX, LABEL_TIERS,
  } = mod;

  // ---------- 1. 分级判定 ----------
  check('t1 分级三档的边界值落在正确的一侧', () => {
    const th = POLITY_LABEL_THRESHOLDS;
    eq(polityLabelTier(0.05), 'province', '极小比例 → 放大了 → 省名');
    eq(polityLabelTier(th.provinceVisibleRatio), 'province', '恰好等于省名阈值 → 仍算放大（≤）');
    eq(polityLabelTier(th.provinceVisibleRatio + 0.001), 'polity', '刚越过省名阈值 → 势力名');
    eq(polityLabelTier(th.polityVisibleRatio), 'polity', '恰好等于势力名阈值 → 仍算中档（≤）');
    eq(polityLabelTier(th.polityVisibleRatio + 0.001), 'abbr', '刚越过势力名阈值 → 简称');
    eq(polityLabelTier(50), 'abbr', '缩得很远 → 简称');
    return `province≤${th.provinceVisibleRatio} < polity≤${th.polityVisibleRatio} < abbr`;
  });

  check('t2 非法比例不崩、不返回空档位（回落中档 = 显示势力名）', () => {
    for (const bad of [undefined, null, NaN, 0, -1, Infinity, 'x', {}]) {
      const t = polityLabelTier(bad);
      assert(LABEL_TIERS.includes(t), `输入 ${String(bad)} 得到非法档位 ${t}`);
      eq(t, 'polity', `输入 ${String(bad)} 应回落中档`);
    }
    return '8 种非法输入全部回落 polity';
  });

  check('t3 单调：看得越远（比例越大）↔ 名字越简，绝不反向', () => {
    let prev = -1;
    const samples = [];
    for (let i = 0; i <= 200; i++) {
      const r = 0.02 * Math.pow(10, (i / 200) * 2.7);   // 0.02 → ~100，覆盖全区间
      const o = TIER_ORDER[polityLabelTier(r)];
      assert(o !== undefined, `比例 ${r} 得到未知档位`);
      assert(o >= prev, `分级非单调：比例 ${r} 处档位回退（${prev} → ${o}）`);
      prev = o;
      if (samples.length < 3 && samples[samples.length - 1] !== o) samples.push(o);
    }
    // 三档都必须出现过，否则「单调」是空转（全落一档也满足非递减）
    assert(new Set(samples).size === 3, `样本未覆盖三档：${JSON.stringify(samples)}`);
    return `200 个采样点单调，覆盖 ${JSON.stringify(samples)}`;
  });

  // ---------- 2. 面积 / 质心 ----------
  check('t4 正方形：面积与形心正确，且**顺逆时针同结果**', () => {
    const ccw = rect(0, 0, 100, 100);
    const cw = ccw.slice().reverse();
    const a = ringAreaCentroid(ccw);
    near(a.area, 10000, 1e-6, '面积');
    near(a.cx, 50, 1e-6, '形心 x');
    near(a.cy, 50, 1e-6, '形心 y');
    const b = ringAreaCentroid(cw);
    near(b.area, a.area, 1e-6, '顺时针面积');
    near(b.cx, a.cx, 1e-6, '顺时针形心 x（绕向不该改变答案）');
    near(b.cy, a.cy, 1e-6, '顺时针形心 y');
    return `面积 ${a.area}，形心 (${a.cx}, ${a.cy})`;
  });

  check('t5 退化环 → area 0，但形心必须是**有限数**（NaN 会让名字静默不画）', () => {
    const cases = [
      [], [{ x: 5, y: 6 }], [{ x: 5, y: 6 }, { x: 7, y: 8 }],
      [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }],
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: NaN, y: 2 }],
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: Infinity }],
      null, undefined, 'nope',
      [[0, 0], [10, 0], [10, 10], [0, 10]],            // 数组形态要支持
    ];
    for (let i = 0; i < cases.length; i++) {
      const r = ringAreaCentroid(cases[i]);
      assert(Number.isFinite(r.cx) && Number.isFinite(r.cy), `第 ${i} 例形心非有限：${JSON.stringify(r)}`);
      assert(Number.isFinite(r.area) && r.area >= 0, `第 ${i} 例面积非法：${r.area}`);
    }
    near(ringAreaCentroid([[0, 0], [10, 0], [10, 10], [0, 10]]).area, 100, 1e-6, '数组形态面积');
    return `${cases.length} 种退化输入全部返回有限值`;
  });

  // ---------- 3. 领土聚合 ----------
  check('t6 面积加权：一个大陆 + 三块碎岛，标签必须落在大陆（不加权会被拽到碎岛）', () => {
    const items = [
      { key: 'A', points: rect(0, 0, 100, 100) },          // 面积 10000，中心 (50,50)
      { key: 'A', points: rect(500, 0, 1, 1) },            // 面积 1
      { key: 'A', points: rect(500, 2, 1, 1) },
      { key: 'A', points: rect(500, 4, 1, 1) },
      { key: 'B', points: rect(0, 300, 10, 10) },
    ];
    const agg = aggregateTerritories(items, (it) => it.key);
    const a = agg.get('A');
    eq(a.count, 4, 'A 的省份数');
    near(a.area, 10003, 1e-6, 'A 的总面积');
    assert(a.cx < 200, `面积加权失效：A 的质心被碎岛拽到 x=${a.cx}（未加权约 375）`);
    near(a.cx, 50.15, 0.5, 'A 的加权质心 x');
    near(a.cy, 50.2, 0.5, 'A 的加权质心 y');
    const b = agg.get('B');
    eq(b.count, 1, 'B 的省份数');
    near(b.cx, 5, 1e-6, 'B 的质心 x');
    return `A 质心 (${a.cx.toFixed(2)}, ${a.cy.toFixed(2)})，A 面积 ${a.area}，B 面积 ${b.area}`;
  });

  check('t7 聚合边界：key 为空 → 跳过；退化环不把质心拉向原点', () => {
    const agg = aggregateTerritories([
      { key: null, points: rect(0, 0, 100, 100) },
      { key: '', points: rect(0, 0, 100, 100) },
      { key: 'C', points: rect(400, 400, 20, 20) },        // 面积 400，中心 (410,410)
      { key: 'C', points: [{ x: 800, y: 800 }] },          // 退化：面积 0
    ], (it) => it.key);
    eq(agg.size, 1, '只有 C 被聚合');
    const c = agg.get('C');
    eq(c.count, 2, 'C 的省份数（退化环也计入数量）');
    near(c.area, 400, 1e-6, 'C 的总面积（退化环贡献 0）');
    // 退化环权重取 1（不是 0）→ 质心被 (800,800) 拉一点，但**绝不会**跳到原点附近
    assert(c.cx > 400 && c.cx < 800, `退化环把质心弄丢了：cx=${c.cx}`);
    return `C 质心 (${c.cx.toFixed(1)}, ${c.cy.toFixed(1)})，count=${c.count}`;
  });

  // ---------- 4. 文本选择 ----------
  check('t8 文本选择：province 档不画势力名；abbr 档无简称则回落全名（**绝不自动截断**）', () => {
    const p = { name: '甲午王朝', abbr: '甲午' };
    eq(labelTextFor(p, 'province'), '', 'province 档不该画势力名');
    eq(labelTextFor(p, 'polity'), '甲午王朝', 'polity 档用全名');
    eq(labelTextFor(p, 'abbr'), '甲午', 'abbr 档用简称');
    eq(labelTextFor({ name: '甲午王朝' }, 'abbr'), '甲午王朝', '无简称 → 回落全名');
    eq(labelTextFor({ name: '甲午王朝', abbr: '   ' }, 'abbr'), '甲午王朝', '空白简称 → 视为没填');
    eq(labelTextFor({ name: '' }, 'polity'), '', '无名 → 空串（调用方据此跳过绘制）');
    eq(labelTextFor(null, 'polity'), '', 'null → 空串');
    eq(labelTextFor(undefined, 'abbr'), '', 'undefined → 空串');
    const t = labelTextFor({ name: '甲午王朝' }, 'abbr');
    assert(t === '甲午王朝' && t !== '甲午', '回落时不许截断成前两字（那是机器臆造的名字）');
    return '全名/简称/回落/空值 7 例';
  });

  // ---------- 5. 屏上面积门槛 ----------
  check('t9 屏上面积门槛：非法缩放一律判否（绝不把标签画到不存在的位置）', () => {
    const area = LABEL_MIN_AREA_PX.province;
    eq(labelFitsOnScreen(area, 1, area), true, '恰好等于门槛 → 通过');
    eq(labelFitsOnScreen(area - 1, 1, area), false, '略小于门槛 → 不通过');
    eq(labelFitsOnScreen(area / 4, 2, area), true, '面积按 scale² 放大');
    eq(labelFitsOnScreen(area / 4, 1, area), false, '同一面积在更小缩放下不通过');
    for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
      eq(labelFitsOnScreen(area * 100, bad, area), false, `缩放 ${String(bad)} 应判否`);
      eq(labelFitsOnScreen(bad, 1, area), false, `面积 ${String(bad)} 应判否`);
    }
    assert(LABEL_MIN_AREA_PX.province < LABEL_MIN_AREA_PX.polity,
      '势力门槛应高于省门槛：势力名要占更大地盘才值当画');
    return `省门槛 ${LABEL_MIN_AREA_PX.province}px² < 势力门槛 ${LABEL_MIN_AREA_PX.polity}px²`;
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('\n失败：');
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
