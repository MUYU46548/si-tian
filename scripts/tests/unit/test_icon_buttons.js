#!/usr/bin/env node
/**
 * Node 单测：**全仓**“纯图标按钮”不许增长（2026-11-08，用户：“不要再让我看到只有图标的按钮”）
 *
 * 为什么单独一件：现有的 `test_toolbar_ux*.js` 是**按组件名单**查的（剧本 / 行星 / 区域 / 21 个面板），
 * 名单外的东西坏了没人管 —— 2026-11-08 实测扫全仓还有 19 个（顶栏 14 + 世界卡 2 + 搜索 1 + 地形 2），
 * 全部在名单之外。这条用例把口径推广到**所有 .vue**。
 *
 * 判据：
 *   a1 每个 .vue 的纯图标按钮数 ≤ 基线；未登记在基线的文件必须是 0；
 *   a2 总数必须**恰好等于**基线之和 —— 修掉一个就要同步下调基线（棘轮：只许降，不许悄悄放宽）；
 *   a3 基线里登记的文件必须真实存在（防止写个不存在的路径假装干净）；
 *   a4 反向探针四条：纯图标必须抓 / 带文字不抓 / 通用符号（×）不抓 / 色块与 chevron 折叠按钮不抓。
 *
 * 通用符号与豁免口径（与 `test_toolbar_ux_panels.js` 同源）：
 *   · 文字就是通用符号：× ✕ ＋ − ⤢ ↺ ↻；
 *   · 图标本身就是通用符号：x / close / plus / minus / chevron-*（渲染出来和文字符号一样）；
 *   · 选色块 / 选图标（`.color-btn` `.icon-pick` 这类）、展开折叠（`.fold-btn` `.chevron`）。
 *
 * 用法：node scripts/tests/unit/test_icon_buttons.js
 * 退出码：0 = 全过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { parse } = require(path.join(ROOT, 'node_modules', '@vue', 'compiler-sfc'));

/**
 * 现有债务（**只许降**）：2026-11-08 收口后 = **0**。
 * 历史：顶栏曾有 14 个纯图标按钮，顶栏已占 ~1700px/1920，补文字要 +350~450px、1280 必溢出；
 * 解法是把低频动作收进带文字的「更多」浮层（`App.vue` 的 `.header-more`），主力动作图标+文字常驻。
 * 以后若有人再加纯图标按钮，这条会红 —— 把文字补上，或收进「更多」。
 */
const BASELINE = {};

const SYMBOLS = ['×', '✕', '✖', '⨯', '＋', '+', '−', '-', '⤢', 'Ｘ', '↺', '↻'];
const UNIVERSAL_ICONS = new Set(['x', 'close', 'plus', 'minus', 'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right']);
const PICKERS = /swatch|color-btn|color-chip|color-dot|color-swatch|icon-pick|marker-btn|palette/i;
const DISCLOSURE = /fold-btn|collapse|expand|chevron|toggle/i;

function attrName(p) {
  const raw = p && (p.rawName || p.name);
  if (!raw) return '';
  return typeof raw === 'string' ? raw : String(raw.content || '');
}
function attrValue(p) {
  const v = p && p.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.content === 'string') return v.content;
  const exp = p && p.exp;
  if (exp && typeof exp.content === 'string') return exp.content;
  return '';
}
function attrOf(n, name) {
  for (const p of n.props || []) if (attrName(p) === name) return attrValue(p);
  return '';
}
function dynAttr(n, raw) {
  for (const p of n.props || []) if ((p.rawName || '') === raw) return String((p.value && p.value.content) || '');
  return '';
}
function textOf(n) {
  if (!n) return '';
  if (n.type === 2) return n.content || '';
  if (n.type === 5) return '{{ }}';          // 插值：运行时就是文字
  if (n.type === 3) return '';              // 注释
  let out = '';
  for (const c of n.children || []) out += textOf(c);
  return out;
}
function iconNames(n) {
  const out = [];
  const walk = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 1 && String(m.tag).toLowerCase() === 'icon') out.push(attrOf(m, 'name') || '');
    for (const c of m.children || []) walk(c);
  };
  walk(n);
  return out;
}

/** 扫一段 SFC 源码 → { total, bad: [{line,title,cls}] }（纯函数，探针直接喂字符串） */
function scanSource(src, filename = 'probe.vue') {
  const { descriptor, errors } = parse(String(src || ''), { filename });
  if (errors && errors.length) throw new Error(`模板解析失败：${errors[0].message || errors[0]}`);
  if (!descriptor.template) return { total: 0, bad: [] };
  const bad = [];
  let total = 0;
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 1 && n.tag === 'button') {
      total += 1;
      const text = textOf(n).replace(/\s+/g, ' ').trim();
      const cls = attrOf(n, 'class') + ' ' + dynAttr(n, ':class');
      const style = attrOf(n, 'style') + ' ' + dynAttr(n, ':style');
      const hasText = text && !SYMBOLS.includes(text);
      const isSym = SYMBOLS.includes(text);
      const isPick = PICKERS.test(cls);
      const isFold = DISCLOSURE.test(cls);
      const isSwatch = /background|#|rgb|hsl/i.test(style);
      const icons = iconNames(n);
      const allUniversal = icons.length > 0 && icons.every((x) => UNIVERSAL_ICONS.has(x));
      if (!hasText && !isSym && !isPick && !isFold && !isSwatch && !allUniversal) {
        bad.push({ line: n.loc.start.line, title: attrOf(n, 'title') || '', cls: cls.trim() });
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(descriptor.template.ast);
  return { total, bad };
}

function listVue(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listVue(full, acc);
    else if (e.name.endsWith('.vue')) acc.push(full);
  }
  return acc;
}

const results = [];
function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const SRC_ROOT = path.join(ROOT, 'src', 'renderer', 'src');
const files = listVue(SRC_ROOT);
const perFile = new Map();
let total = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const { bad } = scanSource(fs.readFileSync(f, 'utf8'), f);
  if (bad.length) perFile.set(rel, bad);
  total += bad.length;
}

check('a1 每个 .vue 的纯图标按钮数 ≤ 基线（未登记的文件必须是 0）', () => {
  const over = [];
  for (const [rel, bad] of perFile) {
    const cap = BASELINE[rel] || 0;
    if (bad.length > cap) over.push(`${rel}: ${bad.length} > ${cap}（例：L${bad[0].line} ${bad[0].title}）`);
  }
  assert(!over.length, '出现了新的纯图标按钮：\n    ' + over.join('\n    '));
  return `${files.length} 个组件`;
});

check('a2 总数 = 基线之和（修掉就同步下调基线，只许降）', () => {
  const want = Object.values(BASELINE).reduce((a, b) => a + b, 0);
  eq(total, want, '纯图标按钮总数');
  return `剩余 ${total} 个（全部在 ${Object.keys(BASELINE).join('、')}）`;
});

check('a3 基线里登记的文件必须真实存在', () => {
  for (const rel of Object.keys(BASELINE)) {
    assert(fs.existsSync(path.join(ROOT, rel)), `基线指向的文件不存在：${rel}（清理基线）`);
  }
  return Object.keys(BASELINE).length + ' 个';
});

check('a4 反向探针：纯图标必须抓', () => {
  const r = scanSource(`<template><button title="保存"><Icon name="save" :size="15"/></button></template>`);
  eq(r.bad.length, 1, '纯图标按钮应被抓到');
  return 'L' + r.bad[0].line;
});

check('a4b 反向探针：带文字 / 通用符号 / 色块 / 折叠箭头 都不抓', () => {
  const withText = scanSource(`<template><button><Icon name="save" :size="15"/>保存</button></template>`);
  eq(withText.bad.length, 0, '带文字不该抓');
  const sym = scanSource(`<template><button title="关闭">×</button></template>`);
  eq(sym.bad.length, 0, '通用符号不该抓');
  const uni = scanSource(`<template><button title="关闭"><Icon name="x" :size="14"/></button></template>`);
  eq(uni.bad.length, 0, 'x 图标（通用符号）不该抓');
  const chev = scanSource(`<template><button class="row"><Icon name="chevron-down" :size="12"/></button></template>`);
  eq(chev.bad.length, 0, '折叠箭头不该抓');
  const swatch = scanSource(`<template><button class="color-btn" :style="{ background: '#f00' }"></button></template>`);
  eq(swatch.bad.length, 0, '色块不该抓');
  const interp = scanSource(`<template><button>{{ label }}</button></template>`);
  eq(interp.bad.length, 0, '插值（运行时就是文字）不该抓');
  return '6 种豁免';
});

const ok = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}  — ${r.detail}`);
console.log(`\n${ok}/${results.length} 通过`);
if (ok !== results.length) {
  if (perFile.size) {
    console.log('\n明细：');
    for (const [rel, bad] of perFile) {
      console.log(`  ${rel}（${bad.length}）`);
      for (const b of bad.slice(0, 20)) console.log(`    L${b.line}  title=${JSON.stringify(b.title)}`);
    }
  }
  process.exit(1);
}
