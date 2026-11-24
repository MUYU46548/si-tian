#!/usr/bin/env node
/**
 * Node 单元测试：**裸 `e.target.closest(...)`** 闸门
 *
 * 为什么要有这一条（2026-11-24）：
 *   0.5.1 用户实测里 `test_04_panels` 弹过一次
 *     `TypeError: e.target.closest is not a function`
 *   路径是 `window.dispatchEvent(new KeyboardEvent('keydown', …))` —— 程序化派发时
 *   `e.target` 是 `window`，而 `window` 没有 `closest`。真实用户按键时 target 是 `body`
 *   所以平时不炸，但**合成事件、触摸、以及部分输入法路径**同样会给出非元素 target。
 *
 *   这不是"测试写法的问题"：`EventTarget` 本来就不只有 `Element`。所以产品侧的正确写法是
 *   `utils/eventTarget.js#targetClosest/targetMatches`（内部判 `nodeType === 1`）。
 *   本闸门扫全部组件/组合式/工具，**禁止**出现裸调用。
 *
 * 判据：
 *   · 出现 `X.target.closest(` / `<ident>.target?.closest(` 一律算违规；
 *   · 允许 `eventTarget.js` 自身（它就是那层防御的实现）；
 *   · 允许显式带守卫的写法：同一行/上一行出现 `nodeType === 1`、`instanceof Element`、
 *     `target && target.closest`（历史写法，也判为已防御）。
 *
 * 反向探针：塞一段裸调用必须报；塞一段走 targetClosest 的必须不报。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TARGET_DIRS = [
  path.join(ROOT, 'src', 'renderer', 'src'),
  path.join(ROOT, 'src', 'main'),
  path.join(ROOT, 'src', 'preload'),
];

// 唯一允许裸调的地方：这层防御本身的实现
const ALLOWLIST = new Set(['src/renderer/src/utils/eventTarget.js']);

// `foo.target.closest(` / `foo.target?.closest(` —— 前面允许任意取景表达式
const BARE = /(\b[\w$]+)\s*(?:\?\.)?\.target\s*\??\.\s*closest\s*\(/g;

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

function listFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (/\.(js|mjs|vue)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 取 .vue 的 script 块（带行偏移），js 原样 */
function sourcesOf(file, src) {
  if (!file.endsWith('.vue')) return [{ code: src, lineOffset: 0 }];
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    out.push({ code: m[2], lineOffset: src.slice(0, m.index).split('\n').length - 1 });
  }
  return out;
}

/** 该行是否自带防御（nodeType / instanceof Element / 三元里判过 closest） */
function guarded(lines, idx) {
  const win = [lines[idx - 1] || '', lines[idx] || '', lines[idx + 1] || ''].join('\n');
  if (/nodeType\s*===\s*1/.test(win)) return true;
  if (/instanceof\s+Element/.test(win)) return true;
  if (/\.closest\s*\?/.test(win)) return true;          // `t && t.closest ? … : null` 那种三元
  return false;
}

function scan(findings) {
  let scanned = 0;
  for (const dir of TARGET_DIRS) {
    for (const file of listFiles(dir)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const blk of sourcesOf(file, src)) {
        scanned++;
        const lines = blk.code.split('\n');
        lines.forEach((line, i) => {
          if (!/\.target\s*\??\.\s*closest\s*\(/.test(line)) return;
          if (guarded(lines, i)) return;
          findings.push({
            file: rel,
            line: blk.lineOffset + i + 1,
            code: line.trim().slice(0, 120),
          });
        });
      }
    }
  }
  return scanned;
}

function main() {
  check('反向探针 A：裸 `e.target.closest(` 必须被报', () => {
    const findings = [];
    const probe = "function onDown(e) {\n  if (e.target.closest('.menu')) return;\n}\n";
    const lines = probe.split('\n');
    lines.forEach((line, i) => {
      if (!/\.target\s*\??\.\s*closest\s*\(/.test(line)) return;
      if (guarded(lines, i)) return;
      findings.push({ line: i + 1 });
    });
    assert(findings.length === 1, `期望 1 条，实际 ${findings.length}`);
    return '1 条';
  });

  check('反向探针 B：走 targetClosest / targetMatches 的写法不许报', () => {
    const probe = [
      "function a(e) { return targetClosest(e.target, '.x'); }",
      "function b(e) { if (targetMatches(e.target, 'input')) return; }",
    ].join('\n');
    const lines = probe.split('\n');
    const hits = lines.filter((l) => /\.target\s*\??\.\s*closest\s*\(/.test(l));
    assert(hits.length === 0, `误报：${hits.join(' | ')}`);
    return '0 条误报';
  });

  check('反向探针 C：带 nodeType 守卫的写法算已防御', () => {
    const probe = "function a(e) {\n  const t = e.target;\n  if (t && t.nodeType === 1 && t.closest('.x')) return;\n}\n";
    const lines = probe.split('\n');
    let hits = 0;
    lines.forEach((line, i) => {
      if (!/\.target\s*\??\.\s*closest\s*\(/.test(line)) return;
      if (guarded(lines, i)) return;
      hits++;
    });
    assert(hits === 0, `带守卫的写法被误报 ${hits} 处`);
    return '0 条误报';
  });

  const findings = [];
  let scanned = 0;
  try {
    scanned = scan(findings);
  } catch (err) {
    findings.push({ file: '<扫描失败>', line: 0, code: String((err && err.message) || err) });
  }

  check(`全仓扫描：${scanned} 个脚本块里没有裸 \`*.target.closest(\``, () => {
    if (!findings.length) return `${scanned} 个脚本块 / 0 条`;
    const lines = findings.map((f) => `  · ${f.file}:${f.line} — ${f.code}`).join('\n');
    throw new Error(`发现 ${findings.length} 处裸 target.closest（改用 utils/eventTarget.js）：\n${lines}`);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main();
