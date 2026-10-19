#!/usr/bin/env node
/**
 * Node 单元测试：手势闸门的**纯状态机**（`src/renderer/src/utils/interactionGate.js`）
 *
 * 为什么要有这一层：闸门是"到点的自动保存**该不该现在跑**"的唯一判定。它一旦判错，
 * 后果分两种、都不是报错型：
 *   · 判"不该存"却存了 → 用户拖动中继续被 519ms 卡住（本修要解决的那件事没解决）；
 *   · 判"该存"却一直不存 → 改动永远只在内存里（**数据安全**）。
 * 所以两条边都必须有判据，且**不许用墙钟时间判**（慢机器假红）：这里用 `check(now)`
 * 的注入时刻 + 机械计数（`defers` / `forced`）来判。
 *
 * 用法：node scripts/tests/unit/test_interaction_gate.js
 * 退出码：0 = 全通过；1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'interactionGate.js');

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

async function main() {
  const url = pathToFileURL(SRC).href;
  const G = await import(url);
  const {
    beginInteraction, endInteraction, isInteractionActive, activeInteractionCount,
    createSaveDeferrer, resetInteractionGate, interactionGateStats,
    INTERACTION_QUIET_MS, SAVE_MAX_DEFER_MS,
  } = G;

  // ── a) begin/end 配对与计数 ────────────────────────────────────────────────
  check('a1 未开始手势时"人不在画布上"', () => {
    resetInteractionGate();
    assert(!isInteractionActive(), '静止态不该被判成手势中');
    assert(activeInteractionCount() === 0, '计数应为 0');
  });

  check('a2 begin 之后判定为手势中，end 之后计数归零', () => {
    resetInteractionGate();
    beginInteraction('t');
    assert(isInteractionActive(), 'begin 后必须为 true');
    assert(activeInteractionCount() === 1, '计数应为 1');
    endInteraction('t');
    assert(activeInteractionCount() === 0, 'end 后计数必须归零');
  });

  check('a3 嵌套 begin/end 逐层配对（只有全部结束才算结束）', () => {
    resetInteractionGate();
    beginInteraction('a');
    beginInteraction('b');
    assert(activeInteractionCount() === 2, '嵌套计数');
    endInteraction('a');
    assert(activeInteractionCount() === 1 && isInteractionActive(), '还剩一层时应仍在手势中');
    endInteraction('b');
    assert(activeInteractionCount() === 0, '全部结束');
  });

  check('a4 没有 begin 的 end 不抛异常、且留计数（配对错误的信号）', () => {
    resetInteractionGate();
    const r = endInteraction('ghost');
    assert(r === false, '应返回 false');
    assert(interactionGateStats.unmatchedEnds === 1, '应记 unmatchedEnds');
    assert(activeInteractionCount() === 0, '不应变成负数');
  });

  check('a5 抬手后有静默窗口（把 mouseup 里收笔那一拍让开）', () => {
    resetInteractionGate();
    beginInteraction('t');
    endInteraction('t');
    const now = Date.now();
    assert(isInteractionActive(now + INTERACTION_QUIET_MS - 5),
      '静默窗口内应仍算"忙"（否则保存会与收笔撞在同一拍）');
    assert(!isInteractionActive(now + INTERACTION_QUIET_MS + 20),
      '静默窗口过后应放行');
  });

  // ── b) 顺延判定器 ─────────────────────────────────────────────────────────
  check('b1 静止时直接放行（不误伤正常保存）', () => {
    resetInteractionGate();
    const d = createSaveDeferrer();
    const t = Date.now();
    assert(d.check(t) === 'run', '静止时应 run');
    assert(interactionGateStats.defers === 0, '不该记顺延');
  });

  check('b2 手势中到点 → wait（这是"拖动中不再被 519ms 卡住"的判据）', () => {
    resetInteractionGate();
    beginInteraction('t');
    const d = createSaveDeferrer();
    const t = Date.now();
    assert(d.check(t) === 'wait', '手势中应 wait');
    assert(interactionGateStats.defers === 1, '应记一次顺延');
    assert(d.check(t + 150) === 'wait', '仍在手势中 → 继续 wait');
    assert(interactionGateStats.defers === 2, '顺延计数应累加');
  });

  check('b3 抬手 + 静默过后 → run（改动必须真的补存）', () => {
    resetInteractionGate();
    beginInteraction('t');
    const d = createSaveDeferrer();
    d.check(Date.now());
    endInteraction('t');
    const after = Date.now() + INTERACTION_QUIET_MS + 10;
    assert(d.check(after) === 'run', '抬手静默后必须放行');
  });

  check('b4 顺延有上限：超过 maxDeferMs 强制 run 并记 forced（数据不饿死）', () => {
    resetInteractionGate();
    beginInteraction('t');
    const d = createSaveDeferrer();
    const t = Date.now();
    assert(d.check(t) === 'wait', '先顺延');
    assert(d.check(t + SAVE_MAX_DEFER_MS - 10) === 'wait', '未到上限继续等');
    assert(d.check(t + SAVE_MAX_DEFER_MS + 1) === 'forced', '到上限必须强制放行');
    assert(interactionGateStats.forced === 1, '应记 forced');
    endInteraction('t');
  });

  check('b5 上限是"从该保存到点算起"的，不是按手势总时长', () => {
    resetInteractionGate();
    beginInteraction('t');
    const d = createSaveDeferrer();
    const t = Date.now();
    d.check(t);                                  // 第一次到点：起点
    assert(d.check(t + 900) === 'wait', '未到上限');
    endInteraction('t');
    // 抬手后放行 → 起点清空；下一轮保存重新计时，不会被上一轮的长手势拖累
    assert(d.check(t + INTERACTION_QUIET_MS + 20) === 'run', '抬手后应放行');
    beginInteraction('t2');
    assert(d.check(t + 2000) === 'wait', '新的一轮重新计时');
    endInteraction('t2');
  });

  check('b6 reset 能把闸门与计数清干净（用例之间不许串味）', () => {
    resetInteractionGate();
    beginInteraction('t');
    resetInteractionGate();
    assert(activeInteractionCount() === 0, '计数应清零');
    assert(!isInteractionActive(), '应判为静止');
    assert(interactionGateStats.begins === 0 && interactionGateStats.defers === 0, '计数应清零');
    endInteraction('t');    // 清完之后多出来的 end 不能把计数打成负数
    assert(activeInteractionCount() === 0, '不应为负');
    resetInteractionGate();
  });

  // ── c) 源码闸门（口径不许被悄悄改松） ─────────────────────────────────────
  check('c1 上限与静默窗口是显式常量（改值必须是一次可见的改动）', () => {
    const fs = require('fs');
    const src = fs.readFileSync(SRC, 'utf8');
    assert(/export const SAVE_MAX_DEFER_MS = \d+/.test(src), '上限必须是显式常量');
    assert(/export const INTERACTION_QUIET_MS = \d+/.test(src), '静默窗口必须是显式常量');
    assert(SAVE_MAX_DEFER_MS >= 1000, '上限不应小于 1s（否则等于没顺延）');
    assert(INTERACTION_QUIET_MS >= 0, '静默窗口不能为负');
  });

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - fail}/${results.length} 通过`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('单元测试崩溃：', e);
  process.exit(1);
});
