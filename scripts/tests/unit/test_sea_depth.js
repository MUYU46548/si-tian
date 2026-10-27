#!/usr/bin/env node
/**
 * Node 单元测试：海深推导（src/renderer/src/utils/seaDepth.js）
 *
 * 为什么这块必须测：海深**不在数据里**（真实底图 2539 个海格高度全是常数 12），
 * 全靠渲染期推导。推导一旦退化成"全 0 / 全 1"，表现是**海面又变成一块纯色** ——
 * 不报错、不崩，只是用户看不到层次（正是这次要修的东西）。
 *
 * 用法：node scripts/tests/unit/test_sea_depth.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'seaDepth.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, l) { if (a !== b) throw new Error(`${l}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/** 造一份 cols×rows 的高度图：`hOf(c,r)` 给高度 */
function makeHm(cols, rows, hOf) {
  const n = cols * rows;
  const h = new Float32Array(n);
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      h[i] = hOf(c, r, i);
      points.push([c * 10, r * 10]);
    }
  }
  return { h, grid: { cellsX: cols, cellsY: rows, spacing: 10, points } };
}

async function main() {
  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(SRC, 'utf8'), 'utf8').toString('base64'));
  const { buildSeaDepth, seaBandIndex, smoothSeaField, SEA_DEPTH_LEVELS, SEA_HEIGHT_MIN_SPAN,
  buildSeaDepthFromRings } = mod;

  check('t1 距岸模式：陆格 t=0，离岸越远 t 越大，ref 来自本图分布', () => {
    // 7×5，左边 2 列是陆（h=30），右边 5 列是海（h=12）
    const hm = makeHm(7, 5, (c) => (c < 2 ? 30 : 12));
    const d = buildSeaDepth(hm, { smooth: false });
    assert(d, '应算出海深场');
    eq(d.mode, 'distance', '模式');
    eq(d.seaCells, 25, '海格数');
    for (let r = 0; r < 5; r++) {
      eq(d.t[r * 7 + 1], 0, '陆格 t 为 0');
      const t1 = d.t[r * 7 + 2];
      const t3 = d.t[r * 7 + 4];
      assert(t1 > 0, `贴岸海格应有深度（${t1}）`);
      assert(t3 > t1, `更远的海格应更深（${t1} → ${t3}）`);
    }
    assert(d.ref >= 2, `ref 下限 2（实际 ${d.ref}）`);
    return `ref=${d.ref} maxDepth=${d.maxDepthCells} 贴岸=${d.t[2].toFixed(2)} 深处=${d.t[4].toFixed(2)}`;
  });

  check('t2 距岸模式：t 一律夹在 0..1（归一化不能溢出）', () => {
    const hm = makeHm(9, 9, (c, r) => (c === 4 && r === 4 ? 40 : 12));
    const d = buildSeaDepth(hm, { smooth: false });
    for (let i = 0; i < hm.h.length; i++) {
      assert(d.t[i] >= 0 && d.t[i] <= 1, `t[${i}]=${d.t[i]} 越界`);
    }
    return `9×9 单岛，最深 t=${Math.max(...d.t).toFixed(2)}`;
  });

  check('t3 真海深优先：海格高度有起伏时按 h 推（越低越深）', () => {
    const hm = makeHm(5, 3, (c) => (c < 1 ? 30 : 20 - c * 2));   // 海格 18 / 16 / 14 / 12
    const d = buildSeaDepth(hm, { smooth: false });
    eq(d.mode, 'height', '模式');
    assert(d.t[1] < d.t[2] && d.t[2] < d.t[3], `越深 t 越大：${d.t[1]} ${d.t[2]} ${d.t[3]}`);
    assert(d.t[1] >= 0 && d.t[3] <= 1, '夹在 0..1');
    assert(SEA_HEIGHT_MIN_SPAN > 0, '常量存在');
    return `mode=height，t=${[1, 2, 3].map((c) => d.t[c].toFixed(2)).join(' / ')}`;
  });

  check('t4 没有海格 → null（不能返回全 0 场骗调用方去画等深线）', () => {
    const hm = makeHm(4, 4, () => 40);
    eq(buildSeaDepth(hm), null, '全陆');
    eq(buildSeaDepth(null), null, '空输入');
    return 'null';
  });

  check('t5 默认不平滑：贴岸一格仍是浅水（平滑会把浅海带拉深）', () => {
    const hm = makeHm(7, 5, (c) => (c < 2 ? 30 : 12));
    const d = buildSeaDepth(hm);
    assert(d.t[2] < 0.3, `贴岸格应很浅（${d.t[2]}）`);
    const sm = buildSeaDepth(hm, { smooth: true });
    assert(sm.t[2] < 0.45, `显式平滑一遍也不该把岸拉成深海（${sm.t[2]}）`);
    return `默认 ${d.t[2].toFixed(2)} / 平滑 ${sm.t[2].toFixed(2)}`;
  });

  check('t6 分带下标：边界不越界、单调', () => {
    const bands = [0, 0.19, 0.21, 0.5, 0.79, 0.99, 1];
    const idx = bands.map((v) => seaBandIndex(v, 5));
    assert(idx[0] === 0 && idx[idx.length - 1] === 4, `首尾：${idx}`);
    for (let i = 1; i < idx.length; i++) assert(idx[i] >= idx[i - 1], `应单调：${idx}`);
    eq(seaBandIndex(-1, 5), 0, '负值夹 0');
    eq(seaBandIndex(2, 5), 4, '超 1 夹末档');
    eq(seaBandIndex(NaN, 5), 0, 'NaN 回 0');
    return idx.join(',');
  });

  check('t7 等深线档位是升序且都在 (0,1) 内（1 = 最深，取 1 会落在格边）', () => {
    assert(Array.isArray(SEA_DEPTH_LEVELS) && SEA_DEPTH_LEVELS.length >= 2, '至少两条');
    for (let i = 0; i < SEA_DEPTH_LEVELS.length; i++) {
      const v = SEA_DEPTH_LEVELS[i];
      assert(v > 0 && v < 1, `档位越界：${v}`);
      if (i) assert(v > SEA_DEPTH_LEVELS[i - 1], `应升序：${SEA_DEPTH_LEVELS}`);
    }
    return SEA_DEPTH_LEVELS.join(' / ');
  });

  check('t8 smoothSeaField：跨陆格不混值（海岸线不会被"平均"进海里）', () => {
    const cols = 3, rows = 1;
    const h = new Float32Array([30, 12, 12]);
    const t = new Float32Array([0, 1, 1]);
    smoothSeaField(t, cols, rows, h, 20);
    eq(t[0], 0, '陆格不变');
    assert(t[1] <= 1 && t[2] <= 1, '海格不越界');
    return `t=${Array.from(t).join(',')}`;
  });

  // ── 粗格导入图：由高精度陆地环重建海深场（2026-10-27）────────────────────────
  check('t9 环栅格化：岛内是陆（t=0）、离岸越远 t 越大、场在 (0,1]', () => {
    // 400×400 的方岛，环 = 四个角（顺时针）
    const ring = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];
    const f = buildSeaDepthFromRings([ring], { step: 4 });
    assert(f, '应能建出场');
    eq(f.mode, 'rings', '来源标记');
    const at = (x, y) => {
      const c = Math.round((x - f.points[0][0]) / f.step);
      const r = Math.round((y - f.points[0][1]) / f.step);
      return f.t[r * f.cols + c];
    };
    eq(at(200, 200), 0, '岛心必须是陆（t=0，否则等深线会画到陆地上）');
    // ⚠️ 取点在**栅格范围内**：环外只扩了 3 格（step×3），380 已经在网格外（会读到 undefined）
    const near = at(304, 200);
    const far = at(310, 200);
    assert(near > 0, `贴岸海格应有深度：${near}`);
    assert(far > near, `离岸更远应更深：${near} vs ${far}`);
    let max = 0;
    for (const v of f.t) if (v > max) max = v;
    assert(max <= 1 + 1e-9 && max > 0.5, `t 应在 (0,1]：max=${max}`);
    return `ref=${f.ref.toFixed(2)} step=${f.step} 近=${near.toFixed(2)} 远=${far.toFixed(2)}`;
  });

  check('t10 环带洞：洞里的水不被填成陆地（偶数奇偶）', () => {
    const outer = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];
    const hole = [{ x: 180, y: 180 }, { x: 220, y: 180 }, { x: 220, y: 220 }, { x: 180, y: 220 }];
    const f = buildSeaDepthFromRings([outer, hole], { step: 4 });
    assert(f, '应能建出场');
    const at = (x, y) => {
      const c = Math.round((x - f.points[0][0]) / f.step);
      const r = Math.round((y - f.points[0][1]) / f.step);
      return f.t[r * f.cols + c];
    };
    assert(at(200, 200) > 0, `洞心应是水（t>0），实际 ${at(200, 200)}`);
    eq(at(140, 200), 0, '环壁上仍是陆');
    return `洞心=${at(200, 200).toFixed(2)}`;
  });

  check('t11 退化输入：空环 / 全同点 / 单环两点 / 格数上限 → null 或可读结果', () => {
    eq(buildSeaDepthFromRings([], {}), null, '空环');
    eq(buildSeaDepthFromRings([[{ x: 0, y: 0 }]], {}), null, '单点环');
    eq(buildSeaDepthFromRings([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], {}), null, '两点环');
    // 极小 maxCells 时放大格距；放不下则老实返回 null（不硬扛成几百万格）
    const ring = [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { x: 0, y: 2000 }];
    const tiny = buildSeaDepthFromRings([ring], { step: 1, maxCells: 500 });
    assert(tiny === null || tiny.cols * tiny.rows <= 500, '不能超格数上限');
    return `tiny=${tiny ? tiny.cols + 'x' + tiny.rows : 'null'}`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
