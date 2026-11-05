#!/usr/bin/env node
/**
 * Node 单元测试：撤销/重做后的统一落盘钩子（B2，2026-11-05）
 *
 * 为什么值得单独守：
 *   ① `undo()/redo()` 不落盘是**设计**（每个写口自己安排保存），但那只覆盖第一次 execute ——
 *      撤销时没人补，于是"改了 → Ctrl+Z → 关掉重开又回来"反复出现（事件表 / 标记 / 019 重导都踩过）。
 *      钩子一旦被谁顺手删掉，**不会报错**，只会在下一次真机演练里以"磁盘没变"这种间接症状出现。
 *   ② 钩子里的落盘调度抛错**不许影响撤销本身**（内存已经撤了，磁盘下一拍还会补）——
 *      这条也要有探针，否则一个保存异常会把撤销变成"点了没反应"。
 *
 * 用法：node scripts/tests/unit/test_undo_persist_hook.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

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
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 载入 undo.js（把 vue / 写闸门换成最小 stub —— 测的是钩子时序，不是 Vue 本身） */
async function loadUndo(guardOk = true) {
  let src = read('src/renderer/src/store/undo.js');
  src = src.replace(/import\s*\{\s*ref,\s*computed\s*\}\s*from\s*'vue';/, '');
  src = src.replace(/import\s*\{\s*guardWrite\s*\}\s*from\s*'\.\/writeGate';/, '');
  const stub = `
function ref(v) { return { value: v }; }
function computed(fn) { return { get value() { return fn(); } }; }
function guardWrite() { return { ok: ${guardOk ? 'true' : 'false'} }; }
`;
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(stub + src);
  return import(url);
}

async function main() {
  // ── 源码契约：钩子接线 ─────────────────────────────────────────────────
  const undo = read('src/renderer/src/store/undo.js');
  const geo = read('src/renderer/src/store/geodata.js');

  check('h1 undo.js：有注册口，且 undo/redo 成功后都调统一钩子', () => {
    assert(undo.includes('export function setHistoryPersistHook('), '没有 setHistoryPersistHook 注册口');
    assert(undo.includes('function persistAfterHistory()'), '没有 persistAfterHistory');
    for (const fn of ['export function undo()', 'export function redo()']) {
      const at = undo.indexOf(fn);
      assert(at >= 0, `找不到 ${fn}`);
      const body = undo.slice(at, undo.indexOf('\n}', at) + 2);
      assert(body.includes('persistAfterHistory();'), `${fn} 里没有调用统一钩子（撤销不落盘回来了）`);
    }
    return 'undo/redo 两条路径都挂上';
  });

  check('h2 geodata 装配：钩子同时覆盖两个数据域（剧本层 + 画布层）', () => {
    assert(/import\s*\{[^}]*setHistoryPersistHook[^}]*\}\s*from\s*'\.\/undo'/.test(geo),
      'geodata 没 import setHistoryPersistHook');
    assert(geo.includes('setHistoryPersistHook(() => {'), '没有注册钩子');
    const at = geo.indexOf('setHistoryPersistHook(() => {');
    const body = geo.slice(at, geo.indexOf('});', at) + 3);
    assert(body.includes('scheduleAutoSaveScenarios()'), '钩子没覆盖剧本层（scheduleAutoSaveScenarios）');
    assert(body.includes('scheduleAutoSave()'), '钩子没覆盖画布层（scheduleAutoSave）');
    return '剧本层 + 画布层';
  });

  // ── 行为：钩子真的被调用 ──────────────────────────────────────────────
  const U = await loadUndo();
  const calls = { n: 0 };
  U.setHistoryPersistHook(() => { calls.n += 1; });

  check('h3 行为：execute 不触发钩子；undo 一次 +1、redo 一次 +1', () => {
    let v = 0;
    U.execute({ type: 't', label: 't', undo: () => { v = 0; }, redo: () => { v = 1; } });
    eq(v, 1, 'execute 后值');
    eq(calls.n, 0, 'execute 不该触发落盘钩子（写口自己安排保存）');
    U.undo();
    eq(calls.n, 1, '撤销后要触发一次');
    eq(v, 0, '撤销后值');
    U.redo();
    eq(calls.n, 2, '重做后要触发一次');
    eq(v, 1, '重做后值');
    return 'execute 0 / undo 1 / redo 2';
  });

  check('h4 空历史时撤销/重做不触发钩子（没东西可撤就不该写盘）', () => {
    const before = calls.n;
    U.clearHistory();
    eq(U.undo(), null, '空历史 undo 返回 null');
    eq(U.redo(), null, '空历史 redo 返回 null');
    eq(calls.n, before, '空历史不该触发落盘');
    return '2 次都不触发';
  });

  check('h5 🔴 钩子抛错不许影响撤销本身（保存炸了，内存也得回退）', () => {
    U.clearHistory();
    let v = 1;
    U.execute({ type: 't2', label: 't2', undo: () => { v = 0; }, redo: () => { v = 1; } });
    U.setHistoryPersistHook(() => { throw new Error('磁盘满了'); });
    const origWarn = console.warn;
    console.warn = () => {};            // 预期内的告警，别把 stderr 刷成一片
    try {
      const cmd = U.undo();
      assert(!!cmd, '撤销没返回命令（异常被吞到外面了？）');
      eq(v, 0, '钩子抛错后内存仍应回退');
      eq(U.canRedo.value, true, '撤销后应可重做');
    } finally {
      console.warn = origWarn;
      U.setHistoryPersistHook(null);
    }
    return '内存回退优先';
  });

  check('h6 注销钩子后不再触发（传 null / 非函数都当注销）', () => {
    U.clearHistory();
    let v = 0;
    U.execute({ type: 't3', label: 't3', undo: () => { v = 0; }, redo: () => { v = 1; } });
    U.setHistoryPersistHook(() => { v = 999; });   // 再来一个会改数据的钩子（不该被调用）
    U.setHistoryPersistHook(null);
    U.undo();
    eq(v, 0, '注销后钩子不该被调用');
    U.setHistoryPersistHook(123);
    eq(U.setHistoryPersistHook(123), null, '非函数必须被规整成 null');
    return '注销 + 非函数规整';
  });

  // guardOk=false 的副本：execute 应被拒（写闸门是单一判定点，钩子不许绕过它）
  const U2 = await loadUndo(false);

  check('h7 写闸门拒绝时零副作用（不进历史、不触发钩子）', () => {
    const c = { n: 0 };
    U2.setHistoryPersistHook(() => { c.n += 1; });
    const gate = U2.execute({ type: 'x', label: 'x', undo: () => {}, redo: () => {} });
    assert(gate && gate.ok === false, '写闸门拒绝时 execute 应返回 ok:false');
    eq(U2.canUndo.value, false, '被拒的命令不许进历史');
    eq(c.n, 0, '被拒时不许触发落盘');
    return '零副作用';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 撤销/重做统一落盘钩子（B2）Node 单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
