#!/usr/bin/env node
/**
 * Node 单元测试：地形特征级锁定 + 湖泊平底（2026-10-27，SP-1025 阶段 1）
 *
 * 守三件事：
 *   · 手绘格按**世界坐标**登记/合并（不是 grid 下标）；
 *   · 重生成按坐标写回：同布局全中、换布局/换分辨率如实丢弃；
 *   · 湖泊是**平底** 18/19（不是按权重渐降的斜盆）。
 *
 * 用法：node scripts/tests/unit/test_hand_edits.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HAND = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'handEdits.js');
const MATH = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'heightMath.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

async function load(file) {
  return import('data:text/javascript;base64,'
    + Buffer.from(fs.readFileSync(file, 'utf8'), 'utf8').toString('base64'));
}

/** 构造一份最小高度图：3×3 网格，间距 10 */
function makeHm(offsetX = 0) {
  const points = [];
  const h = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      points.push([c * 10 + offsetX, r * 10]);
      h.push(30);
    }
  }
  return { h: Float32Array.from(h), grid: { points, spacing: 10 } };
}

/** 通用网格：cols×rows，原点 (ox, oy)，格距 spacing，高度统一 h0 */
function makeGrid(cols, rows, ox, oy, spacing, h0 = 30) {
  const points = [];
  const h = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      points.push([ox + c * spacing, oy + r * spacing]);
      h.push(h0);
    }
  }
  return { h: Float32Array.from(h), grid: { points, spacing, cellsX: cols, cellsY: rows } };
}

async function main() {
  const { handEditKey, mergeHandEdits, activeHandEdits, reapplyHandEdits, thinHandEdits, HAND_EDITS_SOFT_MAX, transferHandEdits } = await load(HAND);
  const { lakeHeightForWeight } = await load(MATH);

  check('h1 坐标量化：1e-2 精度，同格不同浮点尾差得到同一个键', () => {
    eq(handEditKey(10.001, 20.004), handEditKey(10, 20), '尾差');
    assert(handEditKey(10.01, 20) !== handEditKey(10, 20), '1e-2 应区分');
    return handEditKey(10.001, 20.004);
  });

  check('h2 合并：同坐标后来者覆盖，脏条目丢弃，旧条目保留', () => {
    const old = [{ x: 0, y: 0, h: 50 }, { x: 10, y: 0, h: 40 }, null, { x: 'a', y: 0, h: 1 }];
    const touched = [{ x: 0, y: 0, h: 60 }, { x: 20, y: 0, h: 35 }];
    const out = mergeHandEdits(old, touched);
    const by = new Map(out.map(e => [handEditKey(e.x, e.y), e.h]));
    eq(by.get(handEditKey(0, 0)), 60, '后写覆盖');
    eq(by.get(handEditKey(10, 0)), 40, '旧条目保留');
    eq(by.get(handEditKey(20, 0)), 35, '新条目加入');
    eq(out.length, 3, '脏条目被丢');
    return `${out.length} 条`;
  });

  check('h3 有效手绘：当前 h == 登记 h 才保留（撤销掉的格出局）', () => {
    const hm = makeHm();
    hm.handEdits = [
      { x: 0, y: 0, h: 30 },    // 与当前一致 → 保留
      { x: 10, y: 0, h: 55 },   // 与当前不一致（被撤销）→ 丢
      { x: 99, y: 99, h: 30 },  // 坐标不存在 → 丢
    ];
    const active = activeHandEdits(hm);
    eq(active.length, 1, '只剩 1 条');
    eq(active[0].x, 0, '留下的是匹配的那条');
    return '1/3 保留';
  });

  check('h4 重生成写回：同布局按坐标全中；换布局/分辨率如实丢弃', () => {
    const oldHm = makeHm();
    oldHm.h[0] = 70; oldHm.h[4] = 65;
    oldHm.handEdits = [
      { x: 0, y: 0, h: 70 },
      { x: 10, y: 10, h: 65 },
    ];
    const same = makeHm();          // 同布局
    const r1 = reapplyHandEdits(same, activeHandEdits(oldHm));
    eq(r1.applied, 2, '同布局 2 格写回');
    eq([same.h[0], same.h[4]], [70, 65], '写回值');

    const moved = makeHm(5);        // 原点平移 5 → 坐标对不上
    const r2 = reapplyHandEdits(moved, activeHandEdits(oldHm));
    eq(r2.applied, 0, '换布局 0 格');
    eq(r2.kept.length, 0, 'kept 也为空');
    return `同布局 ${r1.applied} / 换布局 ${r2.applied}`;
  });

  check('h5 湖泊平底：权重 1→18、权重 0→19，且只可能 18/19（低于海平面 20）', () => {
    eq(lakeHeightForWeight(1), 18, '盆心');
    eq(lakeHeightForWeight(0), 19, '边缘');
    eq(lakeHeightForWeight(0.5), 19, '半权重取整到浅缘');
    const vals = [0, 0.1, 0.3, 0.5, 0.8, 0.99, 1].map(lakeHeightForWeight);
    assert(vals.every(v => v === 18 || v === 19), `只允许 18/19：${vals}`);
    assert(Math.max(...vals) < 20, '必须低于海平面');
    return vals.join(',');
  });

  check('h6 上限抽稀：超上限按网格保形抽稀，结果确定、不整块丢最新', () => {
    // 200×200 密集网格 = 40000 条（模拟大图长时间编辑）
    const many = [];
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) many.push({ x: i * 7, y: j * 7, h: 30 + ((i + j) % 5) });
    }
    assert(many.length > HAND_EDITS_SOFT_MAX, '前提：输入应超上限');
    const a = thinHandEdits(many);
    const b = thinHandEdits(many);
    assert(a.length <= HAND_EDITS_SOFT_MAX, `抽稀后仍超上限：${a.length}`);
    assert(JSON.stringify(a) === JSON.stringify(b), '抽稀结果不确定（同输入应同输出）');
    // 保形：四个角附近都应还有条目（不是把后半段整块砍掉）
    const near = (px, py) => a.some((e) => Math.abs(e.x - px) < 60 && Math.abs(e.y - py) < 60);
    assert(near(0, 0) && near(1386, 0) && near(0, 1386) && near(1386, 1386),
      '抽稀把某个角整块丢了（保形失败）');
    // merge 走同一条路：超上限时合并结果也必须被抽稀
    const merged = mergeHandEdits(many, [{ x: 0, y: 0, h: 99 }]);
    assert(merged.length <= HAND_EDITS_SOFT_MAX, `merge 未抽稀：${merged.length}`);
    assert(merged.some((e) => e.x === 0 && e.y === 0), '抽稀把刚画的格丢了');
    return `${many.length} → ${a.length} 条`;
  });

  check('h7 造陆搬手绘（同包围盒）：逐点命中，写回用**新格坐标**，之后仍能被 activeHandEdits 认出', () => {
    const prev = makeHm();
    prev.h[0] = 70; prev.h[4] = 65;
    prev.handEdits = [{ x: 0, y: 0, h: 70 }, { x: 10, y: 10, h: 65 }];
    const next = makeHm();
    const r = transferHandEdits(next, prev, activeHandEdits(prev));
    eq(r.applied, 2, '同包围盒 2 格搬过去');
    eq([next.h[0], next.h[4]], [70, 65], '写回值');
    eq(r.dropped, 0, '没有丢弃');
    // 🔴 kept 必须用新格坐标：写回旧坐标 = 下一次重生成 activeHandEdits 认不出来（静默丢）
    eq(r.kept.map((e) => [e.x, e.y]).sort(), [[0, 0], [10, 10]], 'kept 坐标');
    next.handEdits = r.kept;
    eq(activeHandEdits(next).length, 2, '搬完 handEdits 仍有效');
    return `${r.applied} 格`;
  });

  check('h8 造陆搬手绘（包围盒挪位/变密）：按**图幅相对位置**吸附，格距不同也能落', () => {
    // 旧图 0..20（格距 10），新图 -10..30（格距 10）：统一块地在图幅里的相对位置没变
    const prev = makeHm();
    prev.h[8] = 88;                                   // 旧图右下角 (20,20)
    prev.handEdits = [{ x: 20, y: 20, h: 88 }];
    const next = makeGrid(5, 5, -10, -10, 10);        // 新图包围盒 -10..30
    const r = transferHandEdits(next, prev, activeHandEdits(prev));
    eq(r.applied, 1, '相对位置应命中');
    eq(r.kept[0], { x: 30, y: 30, h: 88 }, '落在新图右下角');
    eq(r.snapped, 0, '恰好落格：不需要吸附');
    // 新图更密（格距 5）：映射点落在格点上仍然是命中，值为手绘值
    const dense = makeGrid(9, 9, -10, -10, 5);
    const r2 = transferHandEdits(dense, prev, activeHandEdits(prev));
    eq(r2.applied, 1, '变密也命中');
    eq(r2.kept[0].h, 88, '写回值');
    return `${r.kept[0].x},${r.kept[0].y} / 密图 ${r2.applied}`;
  });

  check('h9 造陆搬手绘：抬高型落到新图的海里 → 丢弃；手挖湖（压低型）→ 保留', () => {
    const prev = makeHm();
    prev.h[0] = 75; prev.h[1] = 18;
    prev.handEdits = [{ x: 0, y: 0, h: 75 }, { x: 10, y: 0, h: 18 }];
    const next = makeHm();
    next.h[0] = 12; next.h[1] = 30;                   // 新图上 (0,0) 已是海
    const r = transferHandEdits(next, prev, activeHandEdits(prev), { seaLevel: 20 });
    eq(r.applied, 1, '只保留手挖湖那条');
    eq(r.kept[0].x, 10, '留下的是压低型');
    eq(r.dropped, 1, '抬高型进海 = 孤岛，丢弃');
    eq(next.h[0], 12, '海格不被抬起来');
    eq(next.h[1], 18, '湖写回');
    return `保留 ${r.applied} / 丢 ${r.dropped}`;
  });

  check('h10 造陆搬手绘：超出吸附半径如实丢弃 + 结果确定', () => {
    const prev = makeGrid(5, 5, 0, 0, 10);
    prev.handEdits = [{ x: 10, y: 10, h: 77 }, { x: 20, y: 20, h: 66 }];
    prev.h[6] = 77; prev.h[12] = 66;
    const next = makeGrid(2, 2, 0, 0, 40);            // 网格很粗：格心离最近点 28.3
    const a = transferHandEdits(next, prev, activeHandEdits(prev), { maxSnap: 10 });
    eq(a.applied, 0, `超出半径应全丢（实际 ${a.applied}）`);
    eq(a.dropped, 2, '丢弃计数');
    const b = transferHandEdits(makeGrid(2, 2, 0, 0, 40), prev, activeHandEdits(prev), { maxSnap: 10 });
    eq(JSON.stringify(a.kept), JSON.stringify(b.kept), '同输入同输出');
    return `丢 ${a.dropped}`;
  });

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
