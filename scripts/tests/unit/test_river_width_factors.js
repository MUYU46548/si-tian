#!/usr/bin/env node
/**
 * Node 单元测试：逐点河宽（src/renderer/src/utils/riverRender.js 的三件新纯函数）
 *
 * 背景：数据里 `width` 是**每河一个标量**，画出来就是"整条河一个粗细"。要做出
 * "源头细 → 河口粗"，就必须逐点宽度；而"哪端是河口"在导入数据里判不出来
 * （实测 159 条河里 156 条两端落在同一格高度），只能靠**距海距离**。
 *
 * 守三件事：
 *   · 宽度因子单调、端点正好是 0.35 / 1，绝不产出 NaN（NaN 线宽 = 整条不画）；
 *   · 河口判定在"两端都无数据 / 一端无数据 / 相等"时都有确定的回落；
 *   · 变距偏移线与 `offsetPolyline` 在常量距离下**逐点相同**（不是第二套几何）。
 *
 * 用法：node scripts/tests/unit/test_river_width_factors.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'riverRender.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

async function main() {
  // riverRender 只依赖 `utils/rivers.js` 的一个颜色常量 → data: 导入解析不到相对模块，
  // 这里把那条 import 换成一个同名的字面量（本用例只测纯几何，不碰颜色）。
  const raw = fs.readFileSync(SRC, 'utf8')
    .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/rivers\.js';?\s*$/m, "const RIVER_COLOR = '#000000';");
  const mod = await import('data:text/javascript;base64,' + Buffer.from(raw, 'utf8').toString('base64'));
  const { riverWidthFactors, pickRiverMouthEnd, offsetPolyline, offsetPolylineVariable } = mod;

  check('t1 宽度因子：源头 0.35 → 河口 1，单调不减，点数不变', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const f = riverWidthFactors(pts);
    eq(f.length, 4, '点数');
    eq(f[0], 0.35, '源头');
    eq(f[3], 1, '河口');
    for (let i = 1; i < f.length; i++) assert(f[i] >= f[i - 1], `应单调：${f}`);
    return f.map((v) => v.toFixed(2)).join(' / ');
  });

  check('t2 reversed：方向反过来（源头在线尾）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const f = riverWidthFactors(pts, { reversed: true });
    eq(f[0], 1, '线首变河口');
    eq(f[2], 0.35, '线尾变源头');
    return f.map((v) => v.toFixed(2)).join(' / ');
  });

  check('t3 退化：空 / 单点 / 零长度都不给 NaN', () => {
    eq(riverWidthFactors([]).length, 0, '空');
    eq(riverWidthFactors([{ x: 1, y: 1 }]).length, 1, '单点');
    const same = riverWidthFactors([{ x: 5, y: 5 }, { x: 5, y: 5 }]);
    assert(same.every((v) => Number.isFinite(v)), `零长度要有限：${same}`);
    return `zero-len = ${same[0]}`;
  });

  check('t4 河口判定：离海更近的一端', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    eq(pickRiverMouthEnd(pts, () => 0.5, {}), 'last', '等距回落 last');
    eq(pickRiverMouthEnd(pts, (x) => (x < 50 ? 0 : 10)), 'first', '线首更近 → first');
    eq(pickRiverMouthEnd(pts, (x) => (x < 50 ? 10 : 0)), 'last', '线尾更近 → last');
    return 'first/last 各 1';
  });

  check('t5 河口判定：无数据 / 单点 / 非函数 → 确定性回落', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
    eq(pickRiverMouthEnd(pts, () => NaN), 'last', '全 NaN');
    eq(pickRiverMouthEnd(pts, () => NaN, { fallback: 'first' }), 'first', '可指定回落');
    eq(pickRiverMouthEnd(pts, (x) => (x === 0 ? NaN : 3)), 'last', '一端缺失');
    eq(pickRiverMouthEnd([pts[0]], () => 0), 'last', '单点');
    eq(pickRiverMouthEnd(pts, null), 'last', '非函数');
    return 'last/last/last/last/last';
  });

  check('t6 变距偏移：常量距离时与 offsetPolyline 逐点相同（不是第二套几何）', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }, { x: 30, y: 5 }];
    const a = offsetPolyline(pts, 4);
    const b = offsetPolylineVariable(pts, pts.map(() => 4));
    eq(a.length, b.length, '点数');
    for (let i = 0; i < a.length; i++) {
      assert(Math.abs(a[i].x - b[i].x) < 1e-9 && Math.abs(a[i].y - b[i].y) < 1e-9,
        `第 ${i} 点应一致：${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`);
    }
    return '4 点逐点一致';
  });

  check('t7 变距偏移：距离按点生效（首 1、尾 5）且退化不抛', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
    const out = offsetPolylineVariable(pts, [1, 3, 5]);
    eq(out.length, 3, '点数');
    // 法线方向由绕向决定（这里沿 +x 走 → 法线朝 +y）；只断言**量值**按点生效
    assert(Math.abs(Math.abs(out[0].y) - 1) < 1e-9, `首点偏移量应为 1：${out[0].y}`);
    assert(Math.abs(Math.abs(out[2].y) - 5) < 1e-9, `尾点偏移量应为 5：${out[2].y}`);
    eq(offsetPolylineVariable([], [1]).length, 0, '空');
    eq(offsetPolylineVariable([{ x: 1, y: 1 }], [2]).length, 1, '单点');
    return `y=${out.map((p) => p.y).join(',')}`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
