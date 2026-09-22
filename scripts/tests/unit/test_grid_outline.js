#!/usr/bin/env node
/**
 * Node 单元测试：栅格 → 矢量轮廓（src/renderer/src/utils/gridOutline.js）
 *
 * 为什么要有这一层：地形涂色 / 生物群系这类「每格一个标签」的栅格，过去是逐格 roundRect 画的，
 * 真实缩放下就是一屏细密马赛克（用户实测原话「依然是马赛克方块填色，不是自然的笔刷」）。
 * 现在渲染端改成「抽边界 → 共线塌缩 → RDP 简化 → Chaikin 平滑 → 一次性 fill」，
 * 于是这个纯几何模块的正确性直接决定画面对不对。它无 DOM 依赖，正好放 Node 层跑真实断言
 * （CDP 用例只能间接看像素，定位不到「哪一列格子丢了西边」这种错误）。
 *
 * 用法：node scripts/tests/unit/test_grid_outline.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS（与其它 unit 用例一致）→ 用 data: URL 动态 import，
 *    这样既不需要改 package.json 的 type，也不要做源码正则改写（正则改写在 §123 已踩过坑）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'gridOutline.js');

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
function near(a, b, tol, label) {
  if (Math.abs(a - b) > tol) throw new Error(`${label}: 期望 ${b} ±${tol}，实际 ${a}`);
}

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const {
    traceLabelLoops, collapseCollinear, simplifyLoop, chaikinLoop, loopArea, buildLabelOutlines,
  } = mod;

  const EMPTY = 255;
  const mk = (cols, rows) => new Uint8Array(cols * rows).fill(EMPTY);
  const fill = (L, cols, c0, r0, c1, r1, v) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) L[r * cols + c] = v;
  };
  const trace = (L, cols, rows) => traceLabelLoops(L, cols, rows, { outside: EMPTY, ignore: [EMPTY] });

  // ── 1. 单块：环数 / 面积 / 包围盒 ──────────────────────────────────────────
  check('单块：1 个环、面积 16 格、包围盒 (3,3)-(7,7)', () => {
    const cols = 10, rows = 10, L = mk(cols, rows);
    fill(L, cols, 3, 3, 6, 6, 1);
    const loops = trace(L, cols, rows).get(1) || [];
    assert(loops.length === 1, `环数 = ${loops.length}（应为 1）`);
    near(loopArea(loops[0]), 16, 1e-6, '面积');
    const xs = loops[0].map(p => p[0]), ys = loops[0].map(p => p[1]);
    assert(Math.min(...xs) === 3 && Math.max(...xs) === 7, `x 范围 [${Math.min(...xs)},${Math.max(...xs)}]（应为 3..7）`);
    assert(Math.min(...ys) === 3 && Math.max(...ys) === 7, `y 范围 [${Math.min(...ys)},${Math.max(...ys)}]（应为 3..7）`);
    return '16 格';
  });

  // ── 2. 分离两块 ─────────────────────────────────────────────────────────
  check('分离两块：2 个环、各 9 格', () => {
    const cols = 20, rows = 10, L = mk(cols, rows);
    fill(L, cols, 1, 1, 3, 3, 2); fill(L, cols, 15, 5, 17, 7, 2);
    const loops = trace(L, cols, rows).get(2) || [];
    assert(loops.length === 2, `环数 = ${loops.length}`);
    for (const l of loops) near(loopArea(l), 9, 1e-6, '面积');
    return '2×9';
  });

  // ── 3. 带洞：evenodd 填充的正确性（洞不能被填掉） ─────────────────────────
  check('带洞：外框 + 洞各 1 环，evenodd 奇偶性正确', () => {
    const cols = 12, rows = 12, L = mk(cols, rows);
    fill(L, cols, 0, 0, cols - 1, rows - 1, 1);
    fill(L, cols, 4, 4, 7, 7, EMPTY);
    const loops = trace(L, cols, rows).get(1) || [];
    assert(loops.length === 2, `环数 = ${loops.length}（应为 外框 + 洞）`);
    const areas = loops.map(loopArea).sort((a, b) => b - a);
    near(areas[0], 144, 1e-6, '外框面积'); near(areas[1], 16, 1e-6, '洞面积');
    const inside = (loop, x, y) => {
      let inIt = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, yi] = loop[i], [xj, yj] = loop[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inIt = !inIt;
      }
      return inIt;
    };
    const parity = (x, y) => loops.reduce((n, l) => n + (inside(l, x, y) ? 1 : 0), 0);
    assert(parity(6, 6) % 2 === 0, `洞心 (6,6) 奇偶 = ${parity(6, 6)}（应为偶数 → 不填充）`);
    assert(parity(1, 1) % 2 === 1, `实体 (1,1) 奇偶 = ${parity(1, 1)}（应为奇数 → 填充）`);
    return '奇偶正确';
  });

  // ── 4. 对角相接（捏点）不死循环、面积不丢 ─────────────────────────────────
  check('对角相接：环数 1~2、总面积 2 格（不丢边）', () => {
    const cols = 6, rows = 6, L = mk(cols, rows);
    L[1 * cols + 1] = 1; L[2 * cols + 2] = 1;
    const loops = trace(L, cols, rows).get(1) || [];
    assert(loops.length >= 1 && loops.length <= 2, `环数 = ${loops.length}`);
    near(loops.reduce((s, l) => s + loopArea(l), 0), 2, 1e-6, '总面积');
    return `${loops.length} 环 / 2 格`;
  });

  // ── 5. 满格与网格外框 ───────────────────────────────────────────────────
  check('满格：1 环 / 面积 20（外框边界要认）', () => {
    const cols = 5, rows = 4, L = new Uint8Array(cols * rows).fill(3);
    const loops = trace(L, cols, rows).get(3) || [];
    assert(loops.length === 1, `环数 = ${loops.length}`);
    near(loopArea(loops[0]), 20, 1e-6, '面积');
    return '20';
  });

  // ── 6. 简化 + 平滑：保形、减点、转角变平顺 ───────────────────────────────
  check('圆盘：共线塌缩 + RDP 减点、Chaikin 保形（面积偏差 < 8%）', () => {
    const cols = 30, rows = 30, L = mk(cols, rows);
    for (let r = 5; r <= 24; r++) for (let c = 5; c <= 24; c++) {
      if ((c - 14.5) ** 2 + (r - 14.5) ** 2 <= 81) L[r * cols + c] = 2;
    }
    const raw = trace(L, cols, rows).get(2)[0];
    const coll = collapseCollinear(raw);
    const simp = simplifyLoop(coll, 0.75);
    const sm = chaikinLoop(simp, 2);
    assert(coll.length < raw.length * 0.7, `共线塌缩效果不足：${raw.length} → ${coll.length}`);
    assert(simp.length <= coll.length, `简化后反而变多：${coll.length} → ${simp.length}`);
    assert(sm.length >= simp.length * 3, `Chaikin 未细分：${simp.length} → ${sm.length}`);
    const aRaw = loopArea(raw), aSm = loopArea(sm);
    assert(Math.abs(aSm - aRaw) / aRaw < 0.08, `面积偏差 ${(((aSm - aRaw) / aRaw) * 100).toFixed(1)}%（应 < 8%）`);
    const medTurn = (pts) => {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        let d = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
        if (d > Math.PI) d = 2 * Math.PI - d;
        out.push(d);
      }
      out.sort((x, y) => x - y);
      return out[Math.floor(out.length / 2)];
    };
    assert(medTurn(sm) < medTurn(raw) * 0.25,
      `转角未平顺：raw=${medTurn(raw).toFixed(3)} smooth=${medTurn(sm).toFixed(3)}`);
    return `${raw.length}→${coll.length}→${simp.length}→${sm.length} 点，面积偏差 ${(((aSm - aRaw) / aRaw) * 100).toFixed(2)}%`;
  });

  // ── 7. 世界坐标换算 ─────────────────────────────────────────────────────
  check('世界坐标：ox/oy/cell 换算正确，未绘制值不进结果', () => {
    const cols = 10, rows = 10, cell = 14.4, ox = -100, oy = -50;
    const L = mk(cols, rows);
    fill(L, cols, 2, 2, 3, 3, 5);
    const m = buildLabelOutlines(L, cols, rows, { cell, ox, oy, outside: EMPTY, ignore: [EMPTY] });
    const loops = m.get(5);
    assert(loops && loops.length === 1, `环数 = ${loops ? loops.length : 'none'}`);
    const p = loops[0].pts;
    const xs = p.map(q => q.x), ys = p.map(q => q.y);
    near(Math.min(...xs), ox + 2 * cell, 1e-6, 'minX');
    near(Math.max(...xs), ox + 4 * cell, 1e-6, 'maxX');
    near(Math.min(...ys), oy + 2 * cell, 1e-6, 'minY');
    near(Math.max(...ys), oy + 4 * cell, 1e-6, 'maxY');
    assert(!m.has(EMPTY), '未绘制值（255）不应出现在结果里');
    assert(Array.isArray(loops[0].bbox) && loops[0].bbox.length === 4, '缺 bbox（视口剔除依赖它）');
    return 'bbox + 换算 ok';
  });

  // ── 8. 性能：真实库规模（239×162 ≈ 3.9 万格）连续色块 ─────────────────────
  check('性能：3.9 万格连续色块 < 60ms（渲染需在交互中重算）', () => {
    const cols = 239, rows = 162, L = mk(cols, rows);
    let s = 20260922;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let b = 0; b < 7; b++) {
      const cx = 30 + rnd() * (cols - 60), cy = 20 + rnd() * (rows - 40), R = 12 + rnd() * 20;
      const tp = 1 + (b % 6);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const dx = c - cx, dy = r - cy;
        const ang = Math.atan2(dy, dx);
        const rr = R * (1 + 0.28 * Math.sin(3 * ang + b) + 0.14 * Math.sin(5 * ang));
        if (Math.hypot(dx, dy) <= rr) L[r * cols + c] = tp;
      }
    }
    const t0 = Date.now();
    const m = buildLabelOutlines(L, cols, rows, { cell: 14.4, ox: 0, oy: 0, outside: EMPTY, ignore: [EMPTY] });
    const dt = Date.now() - t0;
    let loops = 0, pts = 0;
    for (const list of m.values()) for (const l of list) { loops++; pts += l.pts.length; }
    assert(loops > 0, '没有产出任何环');
    assert(loops <= 40, `环数异常多（${loops}）—— 连续色块不该碎成这么多块`);
    assert(dt < 60, `耗时 ${dt}ms（应 < 60ms）`);
    return `${dt}ms / ${loops} 环 / ${pts} 点`;
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 栅格轮廓（Node）单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
