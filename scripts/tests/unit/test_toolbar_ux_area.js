#!/usr/bin/env node
/**
 * Node 单元测试：区域视图工具栏的**可读性**闸门（2026-11-05）
 *
 * 与行星/剧本两张同一套口径（用户：“按钮要看得懂，别学 PS 同一位置藏多个工具”）：
 *   `.edit-toolbar` 里**每个按钮都要有可见文字**（对齐/分布那 8 个纯符号 + 指南针/比例尺
 *   本轮已补字）；全模板不允许“既没字、也不是通用符号/色块/图标选择器/插值”的按钮。
 *
 * 判据：
 *   1) `.edit-toolbar` 里每个按钮都有中文可见文字或插值
 *   2) 全模板无文字按钮只允许：通用符号（× 关闭 / ＋ − 缩放）、色块（class 或 :style 底色）、
 *      图标选择器（icon-pick）、插值（`{{ … }}` 运行时就是文字）
 *   3) 可见文字（文本 + title）零工程术语
 *   4) 负向探针：插空按钮 / 塞“落库”，必须变红
 *
 * 用法：node scripts/tests/unit/test_toolbar_ux_area.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILE = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'AreaMap.vue');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function attrName(prop) {
  const raw = prop && (prop.rawName || prop.name);
  if (!raw) return '';
  return typeof raw === 'string' ? raw : String(raw.content || '');
}
function attrValue(prop) {
  const v = prop && prop.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.content === 'string') return v.content;
  const exp = prop && prop.exp;
  if (exp && typeof exp.content === 'string') return exp.content;
  return '';
}
function attrOf(node, name) {
  for (const p of node.props || []) if (attrName(p) === name) return attrValue(p);
  return '';
}
function dynAttr(node, rawName) {
  for (const p of node.props || []) {
    if ((p.rawName || '') === rawName) return String((p.value && p.value.content) || '');
  }
  return '';
}
function textOf(node) {
  if (!node) return '';
  if (node.type === 2) return node.content || '';
  if (node.type === 5) return '{{ }}';     // 插值：运行时就是文字
  if (node.type === 3) return '';
  let out = '';
  for (const ch of node.children || []) out += textOf(ch);
  return out;
}

const CJK = /[\u4e00-\u9fff]/;
const SYMBOLS = ['×', '✕', '⨯', '−', '＋', '+', '-', '⤢', '↺'];
const JARGON = [
  { label: 'provenance', re: /provenance/ },
  { label: '落库', re: /落库/ },
  { label: '单源', re: /单源/ },
  { label: '格距', re: /(?<!网)格距/ },
  { label: '回执', re: /回执/ },
  { label: '幂等', re: /幂等/ },
  { label: 'N3a', re: /N3a/ },
  { label: 'φ', re: /φ/ },
];

function scan(ast) {
  const buttons = [];
  let toolbarFound = 0;
  const walk = (n, inBar) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 1) {
      const cls = attrOf(n, 'class');
      const here = inBar || /\bedit-toolbar\b/.test(cls);
      if (/\bedit-toolbar\b/.test(cls)) toolbarFound++;
      if (n.tag === 'button') {
        buttons.push({
          text: textOf(n).replace(/\s+/g, ' ').trim(),
          line: n.loc.start.line,
          cls: cls + ' ' + dynAttr(n, ':class'),
          style: dynAttr(n, ':style'),
          inBar: here,
        });
      }
      for (const ch of n.children || []) walk(ch, here);
      return;
    }
    for (const ch of n.children || []) walk(ch, inBar);
  };
  walk(ast, false);
  return { buttons, toolbarFound };
}

function visibleStrings(ast) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 2) {
      const t = String(n.content || '').trim();
      if (t) out.push({ text: t, line: n.loc.start.line });
    }
    if (n.type === 1) {
      const title = attrOf(n, 'title');
      if (title && title.trim()) out.push({ text: title.trim(), line: n.loc.start.line });
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(ast);
  return out;
}

function checkToolbar(buttons) {
  const bar = buttons.filter((b) => b.inBar);
  assert(bar.length > 8, '没找到工具栏按钮（.edit-toolbar 里只有 ' + bar.length + ' 个）');
  const bad = bar.filter((b) => !CJK.test(b.text) && !b.text.includes('{{'));
  assert(bad.length === 0,
    '工具栏里还有只有图标的按钮：' + bad.map((b) => 'L' + b.line + '“' + b.text + '”').join(' | '));
  return bar.length + ' 个按钮都有名字';
}

function checkNaked(buttons) {
  const bad = buttons.filter((b) => {
    if (CJK.test(b.text)) return false;
    if (b.text.includes('{{')) return false;
    if (SYMBOLS.includes(b.text)) return false;
    // `.marker-btn` 是**标记图标选择器**（一排小图标，本来就是“选图标”而不是“点动作”）
    if (/swatch|color-btn|color-chip|color-dot|icon-pick|marker-btn/i.test(b.cls)) return false;
    if (/background/.test(b.style || '')) return false;
    return true;
  });
  assert(bad.length === 0,
    '还有没名字、也不是通用符号/色块/图标选择器的按钮：' +
    bad.slice(0, 8).map((b) => 'L' + b.line + '“' + b.text + '”(' + b.cls + ')').join(' | '));
  return '全部 ' + buttons.length + ' 个按钮：有名字 / 插值 / 通用符号 / 色块 / 图标选择器';
}

function checkJargon(strings) {
  const bad = strings.filter((s) => JARGON.some((w) => w.re.test(s.text)));
  assert(bad.length === 0,
    '区域视图里还有工程术语：' + bad.slice(0, 6).map((s) => 'L' + s.line + '“' + s.text.slice(0, 40) + '”').join(' | '));
  return strings.length + ' 处可见文字，0 命中';
}

const SRC = readText(FILE);
const { parse } = require('@vue/compiler-sfc');
const parsed = parse(SRC, { filename: 'AreaMap.vue' });
const ast = parsed.descriptor.template && parsed.descriptor.template.ast;
assert(ast, 'AreaMap.vue 没有模板 AST');

const { buttons } = scan(ast);
const VISIBLE = visibleStrings(ast);

check('区域视图工具栏：每个按钮都有名字', () => checkToolbar(buttons));
check('全模板：没名字的只能是通用符号/色块/图标选择器/插值', () => checkNaked(buttons));
check('区域视图可见文字零工程术语', () => checkJargon(VISIBLE));

check('负向探针：空按钮 / 塞术语，两条都必须红', () => {
  let a = false;
  try { checkToolbar(buttons.concat([{ text: '', line: 1, cls: '', style: '', inBar: true }])); } catch (_) { a = true; }
  assert(a, '负向探针没抓住工具栏里的纯图标按钮');
  let b = false;
  try { checkNaked(buttons.concat([{ text: '', line: 2, cls: 'plain', style: '', inBar: false }])); } catch (_) { b = true; }
  assert(b, '负向探针没抓住普通区域的纯图标按钮');
  let c = false;
  try { checkJargon(VISIBLE.concat([{ text: '改完立即落库', line: 3 }])); } catch (_) { c = true; }
  assert(c, '负向探针没抓住工程术语');
  return '三条都抓住了';
});

const bad = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length === 0 ? 0 : 1);
