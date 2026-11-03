#!/usr/bin/env node
/**
 * Node 单元测试：直角引号红线（2026-11-03）
 *
 * 用户拍板：界面文案 / 回执 / 注释一律不用直角引号（日式角括号），该用 “ ” 与 ‘ ’。
 * 这条红线如果只写在 AGENTS.md 里，**下一轮就会破** —— 所以把它做成用例：
 * 直接跑 `scripts/quote-audit.mjs --json`，要求
 *   · 界面文案计数 = 0
 *   · 代码/字符串里计数 = 0
 * （docs 归档不参与判据：`agents-archive` 页头写着"原文一字未改"，是历史证据。）
 *
 * 为什么 spawn 而不是在这里再写一遍分类逻辑：审计脚本是**唯一实现**，
 * 这里再抄一份就会出现"用例说绿、审计说红"。慢 0.5s 换掉双源，值得。
 *
 * 用法：node scripts/tests/unit/test_quote_marks.js
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AUDIT = path.join(ROOT, 'scripts', 'quote-audit.mjs');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let cache = null;
function audit() {
  if (cache) return cache;
  assert(fs.existsSync(AUDIT), `审计脚本不存在：${AUDIT}`);
  const out = execFileSync(process.execPath, [AUDIT, '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
  });
  cache = JSON.parse(out);
  return cache;
}

check('q1 审计脚本可解析（--json）', () => {
  const d = audit();
  assert(typeof d.totalUi === 'number' && typeof d.totalCode === 'number', '缺少 totalUi / totalCode');
  assert(Array.isArray(d.rows), '缺少 rows');
  return `扫 ${d.files} 个命中文件 / 总 ${d.totalOpen}`;
});

check('q2 界面文案里一个直角引号都没有（红线）', () => {
  const d = audit();
  const bad = d.rows.filter(r => (r.inUi || 0) > 0).slice(0, 8);
  assert(d.totalUi === 0, `界面文案还有 ${d.totalUi} 处：${bad.map(r => r.rel + '(' + r.inUi + ')').join(', ')}`);
  return '0 处';
});

check('q3 代码/字符串里一个直角引号都没有（回执、指南、断言都算）', () => {
  const d = audit();
  const bad = d.rows.filter(r => (r.inCode || 0) > 0).slice(0, 8);
  assert(d.totalCode === 0, `代码/字符串里还有 ${d.totalCode} 处：${bad.map(r => r.rel + '(' + r.inCode + ')').join(', ')}`);
  return '0 处';
});

check('q4 docs 剩余只允许在归档里（历史证据，按"原文一字未改"保留）', () => {
  const d = audit();
  const live = d.rows.filter(r => r.rel.startsWith('docs/') && !/^docs\/(archive|agents-archive)\//.test(r.rel));
  const sum = live.reduce((a, r) => a + r.open, 0);
  assert(sum === 0, `docs 非归档区还有 ${sum} 处：${live.slice(0, 6).map(r => r.rel).join(', ')}`);
  return `归档内保留 ${d.totalOpen} 处（不参与判据）`;
});

const failed = results.filter(r => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
console.log(`\n=== 直角引号红线 ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
