#!/usr/bin/env node
/**
 * Node 单元测试：笔迹纯函数层（src/renderer/src/utils/strokeMath.js）
 *
 * T7 的“手感”最终要落到数上：
 *   · 同一条轨迹，采样间距越大（= 手越快）→ 宽度必须单调变大（或按参数反向）；
 *   · 无效点必须被丢掉，不能让 NaN 流进 Canvas（NaN 坐标会让整条 path 静默不画）；
 *   · outline→SVG 的路径必须闭合、非空。
 * perfect-freehand 本体在 CDP 用例/探针里覆盖（ESM 裸模块，data: 导入解析不到）。
 *
 * 用法：node scripts/tests/unit/test_stroke_math.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'strokeMath.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

async function main() {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { toStrokeInput, widthsBySpeed, outlineToSvgPath, outlineLength, resampleSeries } = mod;

  check('t1 toStrokeInput：对象/数组/缺压力/非法点', () => {
    const out = toStrokeInput([{ x: 1, y: 2 }, [3, 4, 0.9], { x: NaN, y: 2 }, { x: 5, y: 6, pressure: 2 }]);
    eq(out.length, 3, '有效点数');
    eq(out[0][2], 0.5, '默认压力');
    eq(out[1][2], 0.9, '数组压力');
    eq(out[2][2], 1, '压力夹到 1');
    return '3 个有效点；NaN 被丢；压力夹紧';
  });

  check('t2 widthsBySpeed：间距越大越宽（单调），且夹在 min~max', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 6, y: 0 }, { x: 16, y: 0 }, { x: 36, y: 0 }];
    const w = widthsBySpeed(pts, { base: 10, min: 0.4, max: 2, speedScale: 1.6 });
    eq(w.length, pts.length, '宽度数量');
    assert(w[1] < w[2] && w[2] < w[3] && w[3] <= w[4], `应单调变宽：${w}`);
    assert(w[0] >= 4 && w[4] <= 20, `应夹在 4~20：${w}`);
    return `宽度 ${w.join(' / ')}`;
  });

  check('t3 widthsBySpeed：空输入 / 单点不炸', () => {
    eq(widthsBySpeed([]).length, 0, '空');
    const one = widthsBySpeed([{ x: 1, y: 1 }]);
    eq(one.length, 1, '单点');
    assert(Number.isFinite(one[0]), '单点宽度有限');
    return '空 0；单点有限';
  });

  check('t4 outlineToSvgPath：闭合、含 Q/T、点数不足返回空串', () => {
    const outline = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const d = outlineToSvgPath(outline, true);
    assert(d.startsWith('M'), 'M 开头');
    assert(d.includes('Q') && d.includes('T'), 'Q/T');
    assert(d.endsWith('Z'), 'Z 闭合');
    eq(outlineToSvgPath([[0, 0], [1, 1]]), '', '点数不足');
    return d.slice(0, 40) + '…';
  });

  check('t5 outlineLength：折线长度可算（诊断用）', () => {
    const len = outlineLength([[0, 0], [3, 4], [3, 14]]);
    eq(len, 15, '3-4-5 + 10');
    return '15';
  });

  check('t6 resampleSeries：河宽因子从手迹点数映射到落库点数，端点不丢、不产生 NaN', () => {
    const out = resampleSeries([1, 2, 3], 5);
    eq(out.length, 5, '数量');
    eq(out[0], 1, '首值');
    eq(out[4], 3, '末值');
    assert(Math.abs(out[2] - 2) < 1e-9, `中点应为 2：${out}`);
    assert(out.every((v) => Number.isFinite(v)), '无 NaN');
    eq(resampleSeries([], 3).length, 3, '空值填 1');
    eq(resampleSeries([1, 1], 1)[0], 1, '单点');
    return out.join(' / ');
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
