#!/usr/bin/env node
// scripts/quote-audit.mjs —— 直角引号「」审计（只读，不改文件）
//
// 背景（用户 2026-11-02）：
//   「」不是常规中文标点（那是日式/竖排的角括号用法），正常中文里几十万字也用不到一次。
//   界面上该用的是中文双引号 “ ” 与单引号 ‘ ’（不是英文直引号 " '，代码里除外）。
//   现在这个符号在仓里被当成"引用/强调"的默认写法滥用了 —— 先量清楚，再谈改。
//
// 用法：
//   node scripts/quote-audit.mjs            # 人读报告（按文件，从多到少）
//   node scripts/quote-audit.mjs --json     # 机器读
//   node scripts/quote-audit.mjs --top 20   # 只看前 20 个文件
//   node scripts/quote-audit.mjs --code     # 只看"代码/字符串里"的（= 会影响界面与用例的）
//
// 判定口径：
//   · `.vue`：模板部分算"界面文案"，<script>/<style> 算"代码"；
//   · `.js/.mjs/.html/.css`：剥掉注释后仍出现 = 代码/字符串里（会显示给用户或进断言）；
//   · `.md/.py`：只统计，不分类。
// 退出码恒为 0（这是报告，不是回归用例）；要卡红线请用 --fail。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPEN = '\u300c';   // 「
const CLOSE = '\u300d';  // 」

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const codeOnly = args.includes('--code');
const failOver = args.includes('--fail');
const topArg = args.indexOf('--top');
const TOP = topArg >= 0 ? Number(args[topArg + 1]) || 20 : 20;

/** 剥注释（保留字符串原文；与测试里用的 strip 同口径：状态机，不认正则） */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 0; // 0=code 1=line 2=block 3='…' 4="…" 5=`…`
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === 0) {
      if (c === '/' && d === '/') { state = 1; i += 2; continue; }
      if (c === '/' && d === '*') { state = 2; i += 2; out += '  '; continue; }
      if (c === "'") { state = 3; out += c; i++; continue; }
      if (c === '"') { state = 4; out += c; i++; continue; }
      if (c === '`') { state = 5; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 1) { if (c === '\n') { state = 0; out += c; } i++; continue; }
    if (state === 2) { if (c === '*' && d === '/') { state = 0; i += 2; out += '  '; continue; } i++; continue; }
    // 字符串内：原样保留（注释符不算）
    if (state === 3 || state === 4 || state === 5) {
      const quote = state === 3 ? "'" : state === 4 ? '"' : '`';
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === quote) state = 0;
      out += c; i++; continue;
    }
  }
  return out;
}

function countOf(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'release', 'release-internal'].includes(e.name)) continue;
      walk(p, acc);
    } else acc.push(p);
  }
  return acc;
}

const EXTS = new Set(['.js', '.mjs', '.cjs', '.vue', '.html', '.css', '.md', '.py']);
const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
  ...walk(path.join(ROOT, 'docs')),
].filter((p) => EXTS.has(path.extname(p).toLowerCase()));

const rows = [];
let totalOpen = 0, totalClose = 0, totalCode = 0, totalUi = 0;
for (const abs of files) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const open = countOf(text, OPEN);
  if (!open) continue;
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const ext = path.extname(abs).toLowerCase();
  let inCode = 0, inUi = 0;
  if (ext === '.vue') {
    // 模板 = 界面文案；script/style = 代码
    const tplEnd = text.lastIndexOf('</template>');
    const tpl = tplEnd > 0 ? text.slice(0, tplEnd) : '';
    const rest = tplEnd > 0 ? text.slice(tplEnd) : text;
    inUi = countOf(tpl, OPEN);
    inCode = countOf(stripComments(rest), OPEN);
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.html' || ext === '.css') {
    inCode = countOf(stripComments(text), OPEN);
  }
  rows.push({ rel, open, close: countOf(text, CLOSE), inUi, inCode });
  totalOpen += open;
  totalClose += countOf(text, CLOSE);
  totalUi += inUi;
  totalCode += inCode;
}

rows.sort((a, b) => b.open - a.open);
const shown = codeOnly ? rows.filter((r) => r.inCode > 0) : rows;

if (asJson) {
  console.log(JSON.stringify({ totalOpen, totalClose, totalUi, totalCode, files: rows.length, rows }, null, 1));
  process.exit(0);
}

console.log('=== 直角引号「」审计（只读）===');
console.log(`扫描文件 ${files.length} 个，命中 ${rows.length} 个`);
console.log(`「 ${totalOpen} 次 / 」 ${totalClose} 次  —— 其中界面文案 ${totalUi}、代码/字符串里 ${totalCode}`);
console.log('（口径：中文文案该用 “ ” 与 ‘ ’；「」是日式角括号，正常中文极少用）');
console.log('');
for (const r of shown.slice(0, TOP)) {
  const tag = r.inCode ? `代码 ${r.inCode}` : (r.inUi ? `界面 ${r.inUi}` : '仅文档/注释');
  console.log(`${String(r.open).padStart(5)}  ${r.rel}  (${tag})`);
}
if (shown.length > TOP) console.log(`… 其余 ${shown.length - TOP} 个文件用 --top N 看`);

if (failOver) {
  // 预留给将来卡红线用（现在不接进回归，避免一上来就红）
  process.exit(totalCode > 0 ? 1 : 0);
}
