#!/usr/bin/env node
/**
 * 一次性审计（只读）：清点 store 里所有 `execute({...})` —— 哪些命令的 undo/redo 闭包
 * **没有**安排落盘（靠调用方在 execute 之后补一次保存的，撤销时就落不了盘）。
 *
 * 背景（2026-10-25 019 真机演练抓到的）：`store/undo.js` 的 undo()/redo() 本身不落盘，
 * 纪律是"每个写口自己安排保存"。凡是满足下面两点的命令都可能中招：
 *   ① undo/redo 闭包只改 ref / 数组（没有经过自带保存的写口）；
 *   ② 调用方在 execute() 之后调一次 save*() 就以为完事（只覆盖了第一次 redo）。
 *
 * 用法：node scripts/tests/tools/audit-undo-persist.mjs [--json]
 * 产物：stdout 清点表（可直接贴进 docs/agents-archive/project-save.md）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORE = path.join(ROOT, 'src', 'renderer', 'src', 'store');

const SAVE_PATTERNS = [
  /saveScenarios\s*\(/,
  /scheduleAutoSaveScenarios\s*\(/,
  /scheduleAutoSaveMap\s*\(/,
  /scheduleAutoSave\s*\(/,
  /commitHeightmap\s*\(/,
  /saveGeodata\s*\(/,
  /saveMapData\s*\(/,
];

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(full));
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 从 `start`（指向 `{`）开始找配对的 `}`，跳过字符串 / 模板串 / 行注释 / 块注释 */
function matchBrace(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function main() {
  const files = listJs(STORE);
  const rows = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const re = /\bexecute\s*\(\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const braceAt = src.indexOf('{', m.index);
      const end = matchBrace(src, braceAt);
      if (end < 0) continue;
      const body = src.slice(braceAt, end + 1);
      const typeMatch = body.match(/type:\s*'([^']+)'/) || body.match(/type:\s*"([^"]+)"/);
      const labelMatch = body.match(/label:\s*[`'"]([^`'"]*)/);
      const saves = SAVE_PATTERNS.some((p) => p.test(body));
      rows.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: lineOf(src, m.index),
        type: typeMatch ? typeMatch[1] : '(inline)',
        label: labelMatch ? labelMatch[1] : '',
        saves,
      });
    }
  }
  const missing = rows.filter((r) => !r.saves);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ total: rows.length, missing, all: rows }, null, 2));
    return 0;
  }
  console.log(`=== execute() 落盘清点：共 ${rows.length} 处，闭包里没安排保存的 ${missing.length} 处 ===`);
  for (const r of missing) {
    console.log(`  ${r.file}:${r.line}  type=${r.type}  label=${r.label || '—'}`);
  }
  return 0;
}

process.exit(main());
