#!/usr/bin/env node
/**
 * Node 单元测试：行星视图工具栏的**可读性**闸门（2026-11-05）
 *
 * 背景：用户对 UI 的两条硬要求 ——“不要再让我看到一大堆乱七八糟的按钮和根本看不懂的文字”、
 * “别学 PS 同一个按钮位置藏多种工具还要手动替换”。
 * 行星视图的 `.tool-dock` 原来是 **46px 纯图标竖条**（58 个按钮里 58 个没名字），
 * 本轮改成“图标 + 名字”（104px），一个按钮只对应一个工具。
 *
 * 判据（读模板 AST，秒级）：
 *   1) `.tool-dock` 里**每个按钮都有中文可见文字**（22 个工具全都要有名字）
 *   2) 全模板范围内的无文字按钮**只允许**两类：通用符号（× 关闭 / − ＋ 缩放 / ⤢ 适屏 …）、
 *      色块（class 含 swatch / color）—— 其它一律要补名字
 *   3) 用户可见文字（文本 + title）零工程术语：provenance / 落库 / 单源 / 格距 / 回执 / 幂等 / N3a / φ
 *   4) 负向探针：插一个空文字按钮进 dock、塞一句“落库”，两条判据必须变红
 *
 * 用法：node scripts/tests/unit/test_toolbar_ux_planet.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILE = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'PlanetMap.vue');

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
function textOf(node) {
  if (!node) return '';
  if (node.type === 2) return node.content || '';
  // type 5 = 插值 `{{ … }}`：运行时是有文字的（“对象列表”“12px”“草地”…），不能当成空按钮
  if (node.type === 5) return '{{ }}';
  if (node.type === 3) return '';
  let out = '';
  for (const ch of node.children || []) out += textOf(ch);
  return out;
}

/** 动态 class / style 的属性名是 `:class` / `:style`（rawName），要单独取 */
function dynAttr(node, rawName) {
  for (const p of node.props || []) {
    if ((p.rawName || '') === rawName) return String((p.value && p.value.content) || '');
  }
  return '';
}

const CJK = /[\u4e00-\u9fff]/;
const SYMBOLS = ['×', '✕', '⨯', '−', '＋', '+', '-', '⤢', '↺'];
// `格距` 会被“网格距离”这样的正常词命中 —— 用负向后视只抓“格距”本身
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

/** 收集所有 <button> 与指定 class 的容器 */
function scan(ast) {
  const buttons = [];            // { text, line, cls, inDock }
  let dockFound = 0;
  const walk = (n, inDock) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 1) {
      const cls = attrOf(n, 'class');
      const here = inDock || /\btool-dock\b/.test(cls);
      if (/\btool-dock\b/.test(cls)) dockFound++;
      if (n.tag === 'button') {
        buttons.push({
          text: textOf(n).replace(/\s+/g, ' ').trim(),
          line: n.loc.start.line,
          cls: attrOf(n, 'class') + ' ' + dynAttr(n, ':class'),
          style: dynAttr(n, ':style'),
          inDock: here,
        });
      }
      for (const ch of n.children || []) walk(ch, here);
      return;
    }
    for (const ch of n.children || []) walk(ch, inDock);
  };
  walk(ast, false);
  return { buttons, dockFound };
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

/** 判据 1：dock 里每个按钮都有中文名字 */
function checkDock(buttons) {
  const dock = buttons.filter((b) => b.inDock);
  assert(dock.length > 10, '没找到工具坞按钮（.tool-dock 里只有 ' + dock.length + ' 个）- 选择器或结构变了');
  const bad = dock.filter((b) => !CJK.test(b.text));
  assert(bad.length === 0,
    '这些工具按钮只有图标没有名字：' + bad.map((b) => 'L' + b.line + '“' + b.text + '”').join(' | '));
  return dock.length + ' 个工具都有名字';
}

/** 判据 2：全模板无文字按钮只允许通用符号 / 色块 / 有插值的（“{{ label }}”运行时就是文字） */
function checkNoNakedButtons(buttons) {
  const bad = buttons.filter((b) => {
    if (CJK.test(b.text)) return false;                       // 有中文 = 有名字
    if (b.text.includes('{{')) return false;                  // 插值：运行时渲染出文字
    if (SYMBOLS.includes(b.text)) return false;               // 通用符号（关闭/缩放/适屏）
    if (/swatch|color-btn|color-chip|color-dot|icon-pick/i.test(b.cls)) return false; // 色块 / 图标选择器
    if (/background/.test(b.style || '')) return false;       // 色块（:style 里给底色）
    return true;
  });
  assert(bad.length === 0,
    '还有没名字、也不是通用符号/色块的按钮：' + bad.slice(0, 8).map((b) => 'L' + b.line + '“' + b.text + '”(' + b.cls + ')').join(' | '));
  return '全部 ' + buttons.length + ' 个按钮：有名字 / 插值 / 通用符号 / 色块';
}

/** 判据 3：可见文字零工程术语 */
function checkJargon(strings) {
  const bad = strings.filter((s) => JARGON.some((w) => w.re.test(s.text)));
  assert(bad.length === 0,
    '行星视图里还有工程术语：' + bad.slice(0, 6).map((s) => 'L' + s.line + '“' + s.text.slice(0, 40) + '”').join(' | '));
  return strings.length + ' 处可见文字，0 命中';
}

const SRC = readText(FILE);
const { parse } = require('@vue/compiler-sfc');
const parsed = parse(SRC, { filename: 'PlanetMap.vue' });
const ast = parsed.descriptor.template && parsed.descriptor.template.ast;
assert(ast, 'PlanetMap.vue 没有模板 AST');

const { buttons } = scan(ast);
const VISIBLE = visibleStrings(ast);

check('工具坞（.tool-dock）里每个按钮都有中文名字', () => checkDock(buttons));
check('全模板：没有名字的按钮只能是通用符号或色块', () => checkNoNakedButtons(buttons));
check('行星视图可见文字（文本 + 悬停说明）零工程术语', () => checkJargon(VISIBLE));

check('负向探针：空文字按钮 / 塞术语，两条判据都要红', () => {
  let a = false;
  try { checkDock(buttons.concat([{ text: '', line: 1, cls: '', inDock: true }])); } catch (_) { a = true; }
  assert(a, '负向探针没抓住“dock 里的纯图标按钮”');
  let b = false;
  try { checkNoNakedButtons(buttons.concat([{ text: '', line: 2, cls: 'plain-btn', inDock: false }])); } catch (_) { b = true; }
  assert(b, '负向探针没抓住“普通区域的纯图标按钮”');
  let c = false;
  try { checkJargon(VISIBLE.concat([{ text: '改完立即落库', line: 3 }])); } catch (_) { c = true; }
  assert(c, '负向探针没抓住工程术语');
  return '三条都抓住了';
});

const bad = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length === 0 ? 0 : 1);
