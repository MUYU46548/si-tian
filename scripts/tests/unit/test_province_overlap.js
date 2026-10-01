#!/usr/bin/env node
/**
 * Node 单元测试：新建省份的「压叠闸门」纯函数（src/renderer/src/utils/provinceOverlap.js）
 *
 * 为什么必须有这一层：CDP 用例只能看「store 有没有拒」这个结论；度量本身错了
 * （恒 0 → 永远不拦；把点数组当省份传 → `pointInProvince` 恒 false → 假绿）在端到端里
 * 表现完全一样。这里直接对度量下断言。
 *
 * 用法：node scripts/tests/unit/test_province_overlap.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测模块是 ESM 且有相对 import（./provinceShape）→ 复制到临时目录 + 补 `.js`（同其它 unit 用例）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['provinceOverlap.js', 'provinceShape.js', 'geometry.js', 'gridOutline.js'];

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
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label}: 期望 ${expected} ±${tol}，实际 ${actual}`);
  }
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

/** 轴对齐矩形省 */
const rect = (id, name, x0, y0, x1, y1, extra) => ({
  id, name, kind: 'land',
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  ...(extra || {}),
});

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-overlap-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const mod = await import(pathToFileURL(path.join(tmp, 'provinceOverlap.js')).href);
  const { measureProvinceOverlap, describeOverlap, OVERLAP_REJECT_RATIO, OVERLAP_MAX_DIM } = mod;

  // ---------- 1. 基本度量 ----------
  check('t1 完全不相交 → ratio 0（不能恒拦，否则新省永远建不出来）', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    const cand = rect('new', '新省', 200, 0, 300, 100);
    const r = measureProvinceOverlap(cand, [a]);
    eq(r.blocked, false, '不该拦');
    eq(r.occupied, 0, '占用格数');
    assert(r.total > 100, `采样格数应够（实际 ${r.total}）`);
    eq(r.ratio, 0, '比例');
    return `${r.total} 格采样，占用 0`;
  });

  check('t2 完全覆盖 → ratio ≈ 0.7 且 blocked，并点名占用者', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    const cand = rect('new', '新省', -10, -10, 110, 110);
    const r = measureProvinceOverlap(cand, [a]);
    eq(r.blocked, true, '应判压叠');
    // 解析值 = 甲省面积/新省面积 = 10000/14400 ≈ 0.69；格心采样与格边对齐会有几个百分点偏差
    assert(r.ratio > 0.6 && r.ratio < 0.8, `比例应在 0.6~0.8（实际 ${r.ratio.toFixed(3)}）`);
    eq(r.offenders.length, 1, '占用者条数');
    eq(r.offenders[0].id, 'a', '占用者 id');
    eq(r.offenders[0].name, '甲省', '占用者名字（给用户看的）');
    const msg = describeOverlap(r);
    assert(msg.indexOf('甲省') >= 0 && /%/.test(msg), `文案要点名 + 带百分比：${msg}`);
    return `ratio=${r.ratio.toFixed(2)}（解析 ≈0.69），点名甲省`;
  });

  check('t3 部分压叠：25% 是关键判据两侧', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    // 新省 200 宽，其中 100 宽压在甲省上 → 恰好 50%
    const half = measureProvinceOverlap(rect('h', '半压', 0, 0, 200, 100), [a]);
    near(half.ratio, 0.5, 0.06, '压一半');
    eq(half.blocked, true, '50% 该拦');
    // 新省 500 宽，其中 100 压在甲省上 → 20% < 25%
    const light = measureProvinceOverlap(rect('l', '轻压', 0, 0, 500, 100), [a]);
    near(light.ratio, 0.2, 0.05, '压 20%');
    eq(light.blocked, false, '20% 不该拦（阈值 25%）');
    assert(OVERLAP_REJECT_RATIO > 0.2 && OVERLAP_REJECT_RATIO < 0.5, '阈值取值应落在两者之间');
    return `50% 拦 / 20% 放（阈值 ${OVERLAP_REJECT_RATIO}）`;
  });

  check('t4 被自己的旧轮廓跳过（skipId）与多占用者按格数排序', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    const b = rect('b', '乙省', 100, 0, 200, 100);
    const cand = rect('a', '甲省', 0, 0, 100, 100);
    const withSkip = measureProvinceOverlap(cand, [a, b], { skipId: 'a' });
    eq(withSkip.occupied, 0, '跳过自身后不该有占用');
    const r = measureProvinceOverlap(rect('n', '新省', 80, 0, 210, 100), [a, b]);
    eq(r.offenders.length, 2, '两个占用者');
    eq(r.offenders[0].id, 'b', '格数多的排前面');
    assert(r.offenders[0].cells >= r.offenders[1].cells, '按 cells 降序');
    return 'skipId 生效；占用者按格数降序';
  });

  // ---------- 2. 边界与容错 ----------
  check('t5 空表 / 退化几何 / 非法输入都不抛异常', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    eq(measureProvinceOverlap(a, []).blocked, false, '没有别的省');
    eq(measureProvinceOverlap(a, null).blocked, false, 'null 表');
    eq(measureProvinceOverlap(null, [a]).blocked, false, 'null 候选');
    eq(measureProvinceOverlap([], [a]).blocked, false, '空点列');
    eq(measureProvinceOverlap([{ x: 1, y: 1 }, { x: 2, y: 2 }], [a]).blocked, false, '点太少');
    const zero = measureProvinceOverlap({ points: [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }] }, [a]);
    eq(zero.total, 0, '零面积候选 → 0 格');
    eq(zero.ratio, 0, '零面积 → 比例 0（不做除零）');
    eq(describeOverlap(zero), '', '没被拦时文案为空');
    eq(describeOverlap(null), '', 'null 也给空串');
    return 'null/空/退化 8 例安全';
  });

  check('t6 点数组与省份对象两种形态结果一致（传错形态会假绿）', () => {
    const a = rect('a', '甲省', 0, 0, 100, 100);
    const candProv = rect('n', '新省', 0, 0, 200, 100);
    const asArray = measureProvinceOverlap(candProv.points, [a]);
    const asProv = measureProvinceOverlap(candProv, [a]);
    eq(asArray.total, asProv.total, '格数一致');
    eq(asArray.occupied, asProv.occupied, '占用格数一致');
    // 🔴 反向判据：把点数组直接当省份传进 `pointInProvince` 会恒 false —— 这里锁住「不会」
    assert(asArray.occupied > 0, '点数组形态也必须真的判出重叠');
    return '两形态同结果';
  });

  check('t7 洞（反向内环）不计入面积：候选压住洞的部分不算重叠', () => {
    // 甲省 = 100×100 外环 + 中间 60×60 的洞（反向绕行）
    const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const hole = [{ x: 20, y: 20 }, { x: 20, y: 80 }, { x: 80, y: 80 }, { x: 80, y: 20 }];
    const a = { id: 'a', name: '带洞省', kind: 'land', points: outer, extraRings: [{ points: hole, kind: 'land' }] };
    // 新省只盖住洞的范围 → 应判「几乎不重叠」
    const inHole = measureProvinceOverlap(rect('n', '洞中省', 25, 25, 75, 75), [a]);
    assert(inHole.ratio < 0.1, `洞内不该算重叠（实际 ${inHole.ratio.toFixed(2)}）`);
    // 反过来：盖住整个外环（含洞）→ 解析值 = (10000 - 3600) / 12100 ≈ 0.53
    const whole = measureProvinceOverlap(rect('w', '全盖', -5, -5, 105, 105), [a]);
    near(whole.ratio, 0.53, 0.07, '外环减洞 / 候选面积');
    return `洞内 ${inHole.ratio.toFixed(2)} / 全盖 ${whole.ratio.toFixed(2)}`;
  });

  check('t8 海域省算重叠（海也是分区；文案里标出来）', () => {
    const sea = rect('s', '近海', 0, 0, 100, 100, { kind: 'sea' });
    const r = measureProvinceOverlap(rect('n', '新省', 0, 0, 100, 100), [sea]);
    eq(r.blocked, true, '压在海上也要拦');
    eq(r.offenders[0].kind, 'sea', '占用者类型');
    assert(describeOverlap(r).indexOf('海域') >= 0, `文案要标明海域：${describeOverlap(r)}`);
    return '海域参与判定并标注';
  });

  // ---------- 3. 大省抽稀（真实库有两个 1 万点的省）----------
  check('t9 万点大省：抽稀后仍判得出压叠，且标 approx（不抽稀会卡在抬手那一帧）', () => {
    const n = 10000;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push({ x: 100 + 50 * Math.cos(t), y: 100 + 50 * Math.sin(t) });
    }
    const big = { id: 'big', name: '万点省', kind: 'land', points: pts };
    const t0 = Date.now();
    const r = measureProvinceOverlap(rect('n', '新省', 60, 60, 140, 140), [big]);
    const ms = Date.now() - t0;
    eq(r.blocked, true, '压在大省上要判出来');
    eq(r.approx, true, '抽稀过的度量必须标 approx');
    assert(r.offenders[0].id === 'big', '点名大省');
    assert(ms < 1500, `度量耗时应可控（实际 ${ms}ms）`);
    return `ratio=${r.ratio.toFixed(2)}，approx=true，${ms}ms（${n} 点）`;
  });

  check('t10 采样上限生效：格数不超过 maxDim²（性能闸门是常量而不是运气）', () => {
    const a = rect('a', '甲省', 0, 0, 10000, 10000);
    const cand = rect('n', '新省', 0, 0, 10000, 10000);
    const r = measureProvinceOverlap(cand, [a]);
    assert(r.dim === OVERLAP_MAX_DIM, `dim 应为 ${OVERLAP_MAX_DIM}（实际 ${r.dim}）`);
    assert(r.total <= OVERLAP_MAX_DIM * OVERLAP_MAX_DIM, `格数上限：${r.total}`);
    const small = measureProvinceOverlap(cand, [a], { maxDim: 11 });
    assert(small.dim === 11 && small.total <= 122, `maxDim 可注入（用例用）：${small.total}`);
    return `dim=${r.dim}，格数 ${r.total}`;
  });

  // ---------- 汇总 ----------
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
