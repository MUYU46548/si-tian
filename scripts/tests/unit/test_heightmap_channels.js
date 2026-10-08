#!/usr/bin/env node
/**
 * Node 单元测试：高度图逐格通道（文化/宗教）的纯逻辑 + 网格空间索引
 *   · src/renderer/src/utils/heightmapChannels.js
 *   · src/renderer/src/utils/gridSpatialIndex.js
 *   · src/renderer/src/utils/heightmapAccess.js 的 nearestIndexAt
 *
 * 为什么值得单测（2026-10-08，A3 文化/宗教笔刷）：
 *   这三处都是「判错不会报错、只会静默错乱」的地方 ——
 *     · 通道数组读回形态（TypedArray / 普通数组 / JSON 退化的 {0:..}）判错 → 整层数据丢失
 *     · 通道值与元数据列表的对应关系判错（用 id 而不是位置）→ 涂 A 显示 B 的颜色
 *     · 空间索引分桶判错 → 笔刷刷到邻格 / 吸管吸到别处
 *
 * 用法：node scripts/tests/unit/test_heightmap_channels.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM 且**没有相对 import**（所以能用 data: URL 动态 import；
 *    带相对 import 的模块请放到 CDP 用例里跑，见 test_89）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const U = (...p) => path.join(ROOT, 'src', 'renderer', 'src', 'utils', ...p);

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    if (detail && detail.then) throw new Error('check() 不支持异步回调，请用同步断言');
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
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

async function loadESM(file) {
  const src = fs.readFileSync(file, 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
}

/** 造一个 n×n 的规则网格（第 0 点在原点，spacing = step） */
function gridOf(n, step) {
  const pts = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) pts.push([c * step, r * step]);
  return { points: pts, spacing: step, cellsX: n, cellsY: n, count: pts.length };
}

async function main() {
  const CH = await loadESM(U('heightmapChannels.js'));
  const IDX = await loadESM(U('gridSpatialIndex.js'));
  const ACC = await loadESM(U('heightmapAccess.js'));

  // ── 1. normalizeChannel：三种落盘形态都要能救 ──────────────────────────────
  check('normalizeChannel：Uint8Array 原样通过（同一引用）', () => {
    const a = new Uint8Array([1, 2, 0, 3]);
    const r = CH.normalizeChannel(a, 4);
    assert(r === a, '应是同一引用（就地改数组的前提）');
  });

  check('normalizeChannel：普通数组 → Uint8Array（落盘读回的常态）', () => {
    const r = CH.normalizeChannel([1, 2, 0, 3], 4);
    assert(r instanceof Uint8Array, '应转成 Uint8Array');
    deepEq(Array.from(r), [1, 2, 0, 3], '内容');
  });

  check('normalizeChannel：★ {0:..} 退化形态能救回来（不丢整层数据）', () => {
    const r = CH.normalizeChannel({ 0: 1, 1: 2, 2: 0, 3: 3 }, 4);
    assert(!!r, '应能救回而不是返回 null');
    deepEq(Array.from(r), [1, 2, 0, 3], '内容');
  });

  check('normalizeChannel：长度不符 / 非数值 / 空 → null（不悄悄造零值）', () => {
    eq(CH.normalizeChannel([1, 2], 4), null, '长度不够');
    eq(CH.normalizeChannel(null, 4), null, 'null');
    eq(CH.normalizeChannel({ 0: 'x', 1: 0, 2: 0, 3: 0 }, 4), null, '坏值对象');
    eq(CH.normalizeChannel(new Uint8Array(4), 0), null, 'count 非法');
  });

  check('normalizeChannel：值被夹进 0~255（不会串到别的通道）', () => {
    const r = CH.normalizeChannel([300, -1, 2, 3], 4);
    deepEq(Array.from(r), [300 & 0xff, 255, 2, 3], '按字节截断（与 Uint8Array 语义一致）');
  });

  // ── 2. 通道值 ↔ 列表：用**位置**不用 id ───────────────────────────────────
  check('★ 通道值是位置（1 起）：id 是 Date.now() 也不会错乱', () => {
    // 真实数据里 mapData[pid].cultures 的 id 是时间戳（NodeDetailPanel.createCulture 就是这么写的）
    const list = [{ id: 1759900000000, name: '甲' }, { id: 1759900000001, name: '乙' }];
    eq(CH.nextChannelIndex(list), 3, '下一个位置 = 长度 + 1');
    eq(CH.channelEntryAt(list, 1).name, '甲', '第 1 号 = 列表第 0 项');
    eq(CH.channelEntryAt(list, 2).name, '乙', '第 2 号 = 列表第 1 项');
    eq(CH.channelEntryAt(list, 0), null, '0 = 无主，没有条目');
    eq(CH.channelEntryAt(list, 9), null, '越界返回 null');
  });

  check('nextChannelIndex：上限 255（Uint8Array 装得下）', () => {
    const big = new Array(300).fill(0).map((_, i) => ({ id: i }));
    eq(CH.nextChannelIndex(big), 255, '封顶 255');
  });

  check('channelValueAt：越界/缺失一律 0（不抛）', () => {
    const hm = { culture: new Uint8Array([1, 0, 2]) };
    eq(CH.channelValueAt(hm, 'culture', 2), 2, '正常');
    eq(CH.channelValueAt(hm, 'culture', 99), 0, '越界');
    eq(CH.channelValueAt(hm, 'religion', 0), 0, '通道缺失');
  });

  // ── 3. 空间索引：分桶命中要准 ─────────────────────────────────────────────
  check('★ buildGridIndex + collectInRadius：距离过滤后只命中半径内', () => {
    const grid = gridOf(6, 10);              // 世界坐标 0..50，格距 10
    const idx = IDX.buildGridIndex(grid);
    assert(!!idx, '索引应建起来');
    const pts = grid.points;
    const cx = 20, cy = 20;
    const inRadius = (R) => IDX.collectInRadius(idx, cx, cy, R)
      .filter((i) => Math.hypot(pts[i][0] - cx, pts[i][1] - cy) < R)
      .sort((a, b) => a - b);
    // 半径 12：中心（0）+ 四正邻（10）= 5；对角 14.14 > 12 不该进
    eq(inRadius(12).length, 5, '半径 12 → 5 格');
    eq(inRadius(6).length, 1, '半径 6 → 只剩中心那一格');
  });

  check('★ collectInRadius 与全表线性扫描结果逐一相等（分桶不能漏/不能多）', () => {
    const grid = gridOf(6, 10);
    const idx = IDX.buildGridIndex(grid);
    const pts = grid.points;
    const cx = 20, cy = 20;
    for (const R of [6, 12, 15, 25]) {
      const bucket = IDX.collectInRadius(idx, cx, cy, R)
        .filter((i) => Math.hypot(pts[i][0] - cx, pts[i][1] - cy) < R)
        .sort((a, b) => a - b);
      const linear = pts
        .map((p, i) => (Math.hypot(p[0] - cx, p[1] - cy) < R ? i : -1))
        .filter((i) => i >= 0);
      deepEq(bucket, linear, `半径 ${R}`);
    }
    // 半径 15 会把四个对角（14.14）纳入 → 中心 1 + 正交 4 + 对角 4 = 9
    eq(IDX.collectInRadius(idx, cx, cy, 15)
      .filter((i) => Math.hypot(pts[i][0] - cx, pts[i][1] - cy) < 15).length, 9, '半径 15 → 9 格');
  });

  check('buildGridIndex：空网格 / 坏输入返回 null（不抛）', () => {
    eq(IDX.buildGridIndex(null), null, 'null');
    eq(IDX.buildGridIndex({ points: [] }), null, '空点集');
  });

  check('pointXY：兼容 [x,y] 与 {x,y} 两种历史形态', () => {
    deepEq(IDX.pointXY([3, 4]), [3, 4], '数组');
    deepEq(IDX.pointXY({ x: 3, y: 4 }), [3, 4], '对象');
  });

  // ── 4. nearestIndexAt：吸管与 getHeightAt 共用的唯一实现 ─────────────────
  check('★ nearestIndexAt：命中最近格；超出 spacing 视为未命中', () => {
    const grid = gridOf(4, 10);
    eq(ACC.nearestIndexAt(grid, 1, 1), 0, '角落最近 = 第 0 格');
    eq(ACC.nearestIndexAt(grid, 21, 31), grid.points.findIndex((p) => p[0] === 20 && p[1] === 30), '中间格');
    eq(ACC.nearestIndexAt(grid, 100, 100), -1, '远到超出 spacing → 未命中');
    eq(ACC.nearestIndexAt(null, 0, 0), -1, '无网格');
  });

  check('nearestIndexAt：maxDist 可放宽（口径由调用方给，不各写一套）', () => {
    const grid = gridOf(4, 10);
    eq(ACC.nearestIndexAt(grid, 55, 0, 30), 3, '距第 3 格 25 < 30 → 命中');
    eq(ACC.nearestIndexAt(grid, 55, 0), -1, '缺省 maxDist = spacing = 10 时 25 > 10 → 未命中');
    eq(ACC.nearestIndexAt(grid, 5, 0), 0, '距第 0 格 5 < 10 → 命中');
  });

  // ── 5. 与既有 API 共存（回归：新增函数没改旧行为） ────────────────────────
  check('heightmapAccess 既有导出未被改动', () => {
    eq(typeof ACC.hasGrid, 'function', 'hasGrid');
    eq(typeof ACC.resolveHeightmap, 'function', 'resolveHeightmap');
    eq(typeof ACC.planBindBaseMapToPlanet, 'function', 'planBindBaseMapToPlanet');
    eq(ACC.hasGrid({ grid: { points: [[0, 0]] } }), true, 'hasGrid 有网格点 = true');
    eq(ACC.hasGrid({ grid: { points: [] } }), false, 'hasGrid 空点集 = false');
  });

  // ── 输出 ─────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error('用例异常:', e); process.exit(1); });
