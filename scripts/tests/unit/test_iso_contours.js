#!/usr/bin/env node
/**
 * Node 单元测试：等值线抽取（src/renderer/src/utils/contour.js#extractIsoLines）
 *
 * 背景：`extractContours` 是给**分类场**（biome 这类整数编码）用的，输出格边中点连成的阶梯线；
 * 等深线要的是**连续场**上的平滑线，两件事不能混。这里守三件事：
 *   · 交点在格边上按线性插值（档位换一个值，线整体移动，而不是锁在格边上）；
 *   · 闭合环要首尾相接（不能在某处断开）；
 *   · 鞍点不能画成 X（两条线在格心交叉 = 等深线上"打了个结"）。
 *
 * 用法：node scripts/tests/unit/test_iso_contours.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'contour.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

function gridPts(cols, rows, spacing = 10) {
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([c * spacing, r * spacing]);
  return pts;
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { extractIsoLines } = mod;

  check('t1 竖直梯度：0.5 等值线落在 x=5（线性插值，不是格边）', () => {
    const cols = 3, rows = 3;
    const field = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    const lines = extractIsoLines(field, cols, rows, gridPts(cols, rows, 10), 0.5);
    eq(lines.length, 1, '一条线');
    const pts = lines[0].points;
    assert(pts.length >= 3, `点数应 ≥3（实际 ${pts.length}）`);
    for (const p of pts) assert(Math.abs(p.x - 5) < 1e-6, `x 应恒为 5（实际 ${p.x}）`);
    return `${pts.length} 点，全在 x=5`;
  });

  check('t2 闭合环：中心高、四周低 → 首尾相接的一个环', () => {
    const cols = 5, rows = 5;
    const field = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = Math.max(Math.abs(c - 2), Math.abs(r - 2));
        field[r * cols + c] = d === 0 ? 1 : 0;
      }
    }
    const lines = extractIsoLines(field, cols, rows, gridPts(cols, rows, 10), 0.5);
    eq(lines.length, 1, '一个环');
    const pts = lines[0].points;
    assert(pts.length >= 5, `环上点数 ≥5（实际 ${pts.length}）`);
    const a = pts[0], b = pts[pts.length - 1];
    assert(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6, `应闭合：首 ${JSON.stringify(a)} 末 ${JSON.stringify(b)}`);
    return `${pts.length} 点闭合环`;
  });

  check('t3 多档位：一次给两档 → 两条线，各自 level 正确', () => {
    const cols = 5, rows = 3;
    const field = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) field[r * cols + c] = c;
    const lines = extractIsoLines(field, cols, rows, gridPts(cols, rows, 10), [0.5, 2.5]);
    eq(lines.length, 2, '两条线');
    const lv = lines.map((l) => l.level).sort((a, b) => a - b);
    eq(lv[0], 0.5, '低档');
    eq(lv[1], 2.5, '高档');
    return lines.map((l) => `level=${l.level} x=${l.points[0].x}`).join('；');
  });

  check('t4 全平场：一条线都不给（不能返回零长度碎线）', () => {
    const field = new Float32Array(9).fill(5);
    eq(extractIsoLines(field, 3, 3, gridPts(3, 3), 5).length, 0, 'flat');
    eq(extractIsoLines(field, 3, 3, gridPts(3, 3), 6).length, 0, 'above');
    return '0';
  });

  check('t5 鞍点：对角两高两低 → 两条**分开**的线（不能交叉成 X）', () => {
    // 2×2：TL=BR=1、TR=BL=0；中心均值 0.5 ≥ 档位 0.5 → 两个低角各被围住
    const field = new Float32Array([1, 0, 0, 1]);
    const lines = extractIsoLines(field, 2, 2, gridPts(2, 2, 10), 0.5);
    eq(lines.length, 2, '两条线');
    for (const l of lines) eq(l.points.length, 2, '每条两点');
    // 两条线的端点不应重合（重合 = 在格心打了个结）
    const k = (p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const a = new Set(lines[0].points.map(k));
    const shared = lines[1].points.filter((p) => a.has(k(p)));
    eq(shared.length, 0, '两条线不共端点');
    return lines.map((l) => l.points.map((p) => `(${p.x},${p.y})`).join('→')).join('；');
  });

  check('t6 退化输入：长度不符 / 空场 / 非法档位 → 空数组，不抛', () => {
    eq(extractIsoLines(new Float32Array(4), 3, 3, gridPts(3, 3), 0.5).length, 0, '长度不符');
    eq(extractIsoLines(null, 3, 3, gridPts(3, 3), 0.5).length, 0, '空场');
    eq(extractIsoLines(new Float32Array(9).fill(1), 3, 3, gridPts(3, 3), NaN).length, 0, '非法档位');
    return '[]';
  });

  check('t7 不与分类场那套混用：extractContours 仍在（同一模块两个入口）', () => {
    assert(typeof mod.extractContours === 'function', 'extractContours 应保留');
    assert(typeof mod.extractIsoLines === 'function', 'extractIsoLines 应存在');
    return 'ok';
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
