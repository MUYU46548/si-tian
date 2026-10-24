#!/usr/bin/env node
/**
 * Node 单元测试：标记命中判定（src/renderer/src/utils/markerHitTest.js）
 *
 * 为什么必须有这一层：标记此前**没有命中测试**（放下时问个名字，之后就点不到了），
 * 所以"点标记看资料"一直挂不上。命中判定一旦写错，界面上没有报错——
 * 只会"点了没反应"或"点到旁边那个"，而这正是本仓最讨厌的静默缺陷。
 * 这里把口径钉死：后画的在上（与 drawScenarioMarkers 的绘制顺序一致）、容差含边界、
 * 脏坐标跳过、无 id 的导入标记按**下标**定位（`undefined === undefined` 会误命中第一条）。
 *
 * 用法：node scripts/tests/unit/test_marker_hit.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'markerHitTest.js');

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
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

async function load() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-markerhit-'));
  fs.copyFileSync(SRC, path.join(tmp, 'markerHitTest.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return import(pathToFileURL(path.join(tmp, 'markerHitTest.js')).href);
}

async function main() {
  const M = await load();

  check('a1 重叠时命中**后画的**那条（与绘制顺序同义）', () => {
    const list = [
      { id: 'a', x: 100, y: 100, name: '甲' },
      { id: 'b', x: 100, y: 100, name: '乙' },
    ];
    const hit = M.hitMarker(list, 100, 100, 5);
    assert(hit, '应命中');
    eq(hit.marker.name, '乙', '命中项');
    eq(hit.index, 1, '命中下标');
  });

  check('a2 容差含边界：tol 内命中、tol 外不命中（3-4-5 整数距离）', () => {
    const list = [{ id: 'm', x: 0, y: 0 }];
    assert(M.hitMarker(list, 5, 0, 5), '距离=5、tol=5 应命中');
    assert(!M.hitMarker(list, 5.001, 0, 5), '距离>tol 不该命中');
    assert(M.hitMarker(list, 3, 4, 5), '距离=5（3-4-5）应命中');
    assert(!M.hitMarker(list, 3, 4, 4.99), 'tol 略小不该命中');
  });

  check('a3 脏坐标跳过、不抛（null / undefined / 字符串 / Infinity）', () => {
    const list = [
      { id: 'bad1', x: null, y: 0 },
      { id: 'bad2', x: '100', y: undefined },
      { id: 'bad3', x: Infinity, y: 0 },
      null,
      { id: 'ok', x: 10, y: 10 },
    ];
    const hit = M.hitMarker(list, 10, 10, 1);
    assert(hit, '应命中最后那条有效标记');
    eq(hit.marker.id, 'ok', '跳过脏条目');
    assert(M.hitMarker([{ id: 'n', x: null, y: null }], 0, 0, 100) === null, '全是脏坐标 → null');
  });

  check('a4 空表 / 非数组 / 非法容差 → null；tol=0 只精确命中', () => {
    assert(M.hitMarker([], 0, 0, 10) === null, '空数组');
    assert(M.hitMarker(null, 0, 0, 10) === null, 'null 表');
    assert(M.hitMarker([{ x: 0, y: 0 }], 0, 0, -1) === null, '负容差');
    assert(M.hitMarker([{ x: 0, y: 0 }], 0, 0, NaN) === null, 'NaN 容差');
    assert(M.hitMarker([{ x: 0, y: 0 }], NaN, 0, 10) === null, 'NaN 坐标');
    assert(M.hitMarker([{ x: 0, y: 0 }], 0, 0, 0), 'tol=0 精确命中');
    assert(!M.hitMarker([{ x: 0, y: 0 }], 0.5, 0, 0), 'tol=0 偏移不命中');
  });

  check('a5 句柄：有 id 用 id、无 id 用下标；undefined 句柄绝不命中第一条无 id 的', () => {
    const list = [
      { x: 0, y: 0, name: '导入甲' },              // 无 id
      { x: 1, y: 1, name: '导入乙' },              // 无 id
      { id: 'm3', x: 2, y: 2 },
    ];
    eq(M.markerIdentity(list[0], 0), 0, '无 id → 下标');
    eq(M.markerIdentity(list[2], 2), 'm3', '有 id → id');
    eq(M.markerIndexOf(list, 'm3'), 2, '按 id 找');
    eq(M.markerIndexOf(list, 1), 1, '按下标找');
    eq(M.markerIndexOf(list, 9), -1, '越界下标 → -1');
    eq(M.markerIndexOf(list, undefined), -1, 'undefined 句柄 → -1（不能命中第一条无 id 的）');
    eq(M.markerIndexOf(list, null), -1, 'null 句柄 → -1');
    eq(M.markerIndexOf(null, 0), -1, '无表 → -1');
  });

  check('a6 只读：判定不改 markers（前后逐字段相同）', () => {
    const list = [
      { id: 'a', x: 1, y: 2, name: '甲', type: 'city' },
      { id: 'b', x: 3, y: 4, name: '乙', type: 'port' },
    ];
    const before = JSON.stringify(list);
    M.hitMarker(list, 1, 2, 10);
    M.markerIndexOf(list, 'b');
    M.markerIdentity(list[0], 0);
    eq(JSON.stringify(list), before, 'markers 被改动了');
  });

  check('a7 常量：命中半径是正的屏幕像素（调用方用它 / 缩放 换算）', () => {
    assert(Number.isFinite(M.MARKER_HIT_RADIUS_PX), 'MARKER_HIT_RADIUS_PX 必须是数字');
    assert(M.MARKER_HIT_RADIUS_PX > 0, '命中半径必须为正');
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌';
    console.log(`${mark} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  if (failed.length) {
    console.log(`\n标记命中判定：${failed.length}/${results.length} 项失败`);
    process.exit(1);
  }
  console.log(`\n标记命中判定：${results.length}/${results.length} 项通过`);
}

main().catch((e) => {
  console.error('单测崩溃：', e);
  process.exit(1);
});
