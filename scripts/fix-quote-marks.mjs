#!/usr/bin/env node
// scripts/fix-quote-marks.mjs —— 直角引号「」→ 中文引号 “” 的清理器（2026-11-03）
//
// 背景（用户 2026-11-02 拍板）：`「」` 是日式角括号，不该在中文界面/注释里当"引用/强调"用；
// 该用 `“ ”` 与 `‘ ’`（英文直引号 `" '` 在代码里照旧）。存量 7,092 处 / 587 个文件。
//
// 用法：
//   node scripts/fix-quote-marks.mjs                 # dry-run：按文件出清单 + 每文件样例
//   node scripts/fix-quote-marks.mjs --apply         # 真写盘
//   node scripts/fix-quote-marks.mjs --scope src     # 只 src（可选 src|tests|docs|all，默认 all）
//   node scripts/fix-quote-marks.mjs --show 5 --top 30
//
// 口径：
//   · 只做**四字符**替换：`「→“`、`」→”`、`『→‘`、`』→’`；不碰英文引号，不动行结构（CRLF/BOM 原样）；
//   · **跳过正则字面量行**：`replace(/…「…/)`、`new RegExp(...)` 这类行换掉会改语义，
//     进"需人工"清单（本仓实测只有 `utils/vaultClassify.js` 一条，手改时两种括号都留着）；
//   · 默认不碰 build/ dist/ release*/ node_modules/ .git/。
//
// 为什么实现与用例一起改：大量用例断言的就是**原文**（statusMsg 回执、指南正文）。
// 两边同一套替换，断言才跟得上实现；改完必须跑全量回归。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPEN = '\u300c', CLOSE = '\u300d';       // 「 」
const OPEN_S = '\u300e', CLOSE_S = '\u300f';   // 『 』
const MAP = new Map([[OPEN, '\u201c'], [CLOSE, '\u201d'], [OPEN_S, '\u2018'], [CLOSE_S, '\u2019']]);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const scopeArg = args.indexOf('--scope');
const SCOPE = scopeArg >= 0 ? args[scopeArg + 1] : 'all';
const showArg = args.indexOf('--show');
const SHOW = showArg >= 0 ? Number(args[showArg + 1]) || 3 : 3;
const topArg = args.indexOf('--top');
const TOP = topArg >= 0 ? Number(args[topArg + 1]) || 25 : 25;
// `--files a.html,b.html`：只改指定的几个文件（给 docs 里零散的 mockup 用，不必整包 docs）
const filesArg = args.indexOf('--files');
const ONLY = filesArg >= 0 ? String(args[filesArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;

const SCOPES = {
  src: ['src'],
  tests: ['scripts'],
  docs: ['docs'],
  all: ['src', 'scripts', 'docs'],
};
if (!SCOPES[SCOPE]) {
  console.error(`未知 scope：${SCOPE}（可选 ${Object.keys(SCOPES).join(' / ')}）`);
  process.exit(2);
}

const EXTS = new Set(['.js', '.mjs', '.cjs', '.vue', '.html', '.css', '.py', '.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'release', 'release-internal', '.test-edge-profile']);
// 这两个文件**讲的就是这个符号**（文档里的例子、审计的常量），换掉等于把说明改坏
const SKIP_FILES = new Set(['scripts/fix-quote-marks.mjs', 'scripts/quote-audit.mjs']);

function walk(dir, acc = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('release')) continue;
      walk(path.join(dir, e.name), acc);
    } else acc.push(path.join(dir, e.name));
  }
  return acc;
}

/** 这一行是不是"正则字面量/RegExp 构造"——那里换括号会改语义，交人工 */
function isRegexLine(line) {
  if (!/[\u300c\u300d\u300e\u300f]/.test(line)) return false;
  return /(replace|match|split|test|search)\s*\(\s*\//.test(line)
    || /new\s+RegExp\s*\(/.test(line)
    || /RegExp\(/.test(line);
}

function convertChar(ch) { return MAP.get(ch) || ch; }

const files = (ONLY
  ? ONLY.map((rel) => path.join(ROOT, rel))
  : SCOPES[SCOPE].flatMap((d) => walk(path.join(ROOT, d))))
  .filter((p) => EXTS.has(path.extname(p).toLowerCase()))
  .filter((p) => !SKIP_FILES.has(path.relative(ROOT, p).replace(/\\/g, '/')));

const rows = [];
const manual = [];
let total = 0;

for (const abs of files) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  if (!/[\u300c\u300d\u300e\u300f]/.test(text)) continue;
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const lines = text.split('\n');
  const samples = [];
  let count = 0;
  const out = lines.map((line, idx) => {
    let hits = 0;
    for (const ch of line) if (MAP.has(ch)) hits++;
    if (!hits) return line;
    if (isRegexLine(line)) {
      manual.push({ rel, line: idx + 1, text: line.trim().slice(0, 160) });
      return line;
    }
    count += hits;
    if (samples.length < SHOW) samples.push({ line: idx + 1, before: line.trim().slice(0, 140) });
    let next = '';
    for (const ch of line) next += convertChar(ch);
    return next;
  });
  if (!count) continue;
  total += count;
  rows.push({ rel, count, samples, next: out.join('\n'), abs });
}

rows.sort((a, b) => b.count - a.count);

console.log('=== 直角引号清理 ===');
console.log(`模式：${APPLY ? '**写盘**' : 'dry-run（加 --apply 才写）'} ｜ scope=${SCOPE} ｜ 命中 ${total} 处 / ${rows.length} 个文件`);
for (const r of rows.slice(0, TOP)) {
  console.log(`\n${String(r.count).padStart(5)}  ${r.rel}`);
  for (const s of r.samples) console.log(`        L${s.line}: ${s.before}`);
}
if (rows.length > TOP) console.log(`\n… 其余 ${rows.length - TOP} 个文件（--top N 看）`);

if (manual.length) {
  console.log(`\n⚠ 需人工（正则字面量里含括号，换了会改语义）：${manual.length} 行`);
  for (const m of manual.slice(0, 10)) console.log(`   ${m.rel}:${m.line}  ${m.text}`);
}

if (APPLY) {
  let wrote = 0;
  for (const r of rows) {
    fs.writeFileSync(r.abs, r.next, 'utf8');
    wrote++;
  }
  console.log(`\n✅ 已写盘 ${wrote} 个文件 / ${total} 处替换`);
  console.log('   下一步：`node scripts/quote-audit.mjs` 复核 → `python scripts/tests/run_tests.py` 全量回归');
} else {
  console.log('\n（dry-run：没有写任何文件）');
}
