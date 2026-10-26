#!/usr/bin/env node
/**
 * Node 单元测试：山脊候选检测（src/renderer/src/utils/ridges.js）
 *
 * 为什么单测：这是"地形注记"的第一层 —— 候选错了，用户命名再认真也是错的。
 * 判据不看"像不像山"，只看看得见的东西：
 *   · 人造一条对角山脊 → 必须抽出一条**沿对角线**的长候选（点序、范围、高度都对）；
 *   · 平地/全海 → 一条都没有（不能返回噪声）；
 *   · 同输入两次结果一致（落库前的候选必须可复现）。
 *
 * 用法：node scripts/tests/unit/test_ridges.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'ridges.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

const SEA = 20;

function makeRidgeGrid(cols = 48, rows = 48) {
  const n = cols * rows;
  const h = new Float32Array(n);
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      points.push([c * 10, r * 10]);
      const border = c < 4 || r < 4 || c >= cols - 4 || r >= rows - 4;
      if (border) { h[i] = SEA - 5; continue; }
      // 对角山脊：到直线 x=y 的距离
      const d = Math.abs(c - r) / Math.SQRT2;
      h[i] = 30 + 34 * Math.exp(-(d * d) / 12);
    }
  }
  return { h, grid: { cellsX: cols, cellsY: rows, spacing: 10, points } };
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { detectRidges } = mod;

  check('t1 对角山脊：抽出一条沿 x≈y 的长候选', () => {
    const hm = makeRidgeGrid();
    const ridges = detectRidges(hm, { seaLevel: SEA, minCells: 6, maxRidges: 5 });
    assert(ridges.length >= 1, `至少一条（实际 ${ridges.length}）`);
    const r0 = ridges[0];
    assert(r0.points.length >= 6, `点数应 ≥6（实际 ${r0.points.length}）`);
    assert(r0.length > 150, `长度应像一条山脊（实际 ${r0.length}）`);
    assert(r0.meanHeight > SEA, `平均高度应高于海平面（${r0.meanHeight}）`);
    // 每个点都该贴着对角线：|x - y| 不超过 3 格
    const worst = Math.max(...r0.points.map((p) => Math.abs(p.x - p.y)));
    assert(worst <= 40, `点应贴在对角线附近（最大偏离 ${worst} 世界单位）`);
    return `${ridges.length} 条；主脊 ${r0.points.length} 点 / 长度 ${r0.length} / 峰值 ${r0.peakHeight}`;
  });

  check('t2 全平陆地：没有脊线（不能把噪声当山）', () => {
    const cols = 30, rows = 30;
    const pts = [];
    const h = new Float32Array(cols * rows).fill(40);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([c * 10, r * 10]);
    const ridges = detectRidges({ h, grid: { cellsX: cols, cellsY: rows, spacing: 10, points: pts } }, { seaLevel: SEA });
    eq(ridges.length, 0, '平地无脊');
    return '0';
  });

  check('t3 全海 / 空数据：返回空，不抛', () => {
    const cols = 20, rows = 20;
    const pts = [];
    const h = new Float32Array(cols * rows).fill(SEA - 8);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([c * 10, r * 10]);
    eq(detectRidges({ h, grid: { cellsX: cols, cellsY: rows, spacing: 10, points: pts } }).length, 0, '全海');
    eq(detectRidges(null).length, 0, '空输入');
    return '[]';
  });

  check('t4 确定性：同输入两次结果完全一致（候选要可复现）', () => {
    const hm = makeRidgeGrid(40, 40);
    const a = detectRidges(hm, { seaLevel: SEA });
    const b = detectRidges(hm, { seaLevel: SEA });
    eq(JSON.stringify(a), JSON.stringify(b), '两次结果');
    return `${a.length} 条一致`;
  });

  check('t5 maxRidges 生效，且按长度降序', () => {
    const hm = makeRidgeGrid();
    const all = detectRidges(hm, { seaLevel: SEA, maxRidges: 3 });
    assert(all.length <= 3, `上限 3（实际 ${all.length}）`);
    for (let i = 1; i < all.length; i++) assert(all[i - 1].length >= all[i].length, '应按长度降序');
    return all.map((r) => r.length.toFixed(0)).join(' / ');
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
