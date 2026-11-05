#!/usr/bin/env node
/**
 * Node 单元测试：剧本视图“更多”工具栏的**可读性**闸门（2026-11-05）
 *
 * 用户原话（2026-11-05）：“不要再让我看到一大堆乱七八糟的按钮和根本看不懂的文字。”
 * 这不是审美偏好，是**可发现性**问题 —— 本项目真实踩过两次：
 *   ① 只有图标没有文字的“分辨率”按钮，用户“更多里找了五分钟没找到”（test_105 记着）；
 *   ② “更多”里 50+ 个按钮分成 4 行、行内几乎没有标题，生成类按钮混在笔刷中间（STATUS 232-287）。
 *
 * 判据（都读源码模板，秒级）：
 *   1) `.toolbar-more` 里**分区标题 ≥ 4**，且标题文字里必须有中文
 *      （现在有：省份几何 / 地形·底图·生成 / 图层·着色 / 剧本·导入导出 / …）
 *   2) `.toolbar-more` 里**每个按钮都必须有可见文字**（不能只有图标或 ⊞ 这类符号）
 *   3) 该区域内**面向用户的文字**不许出现内部术语：
 *      FMG / Azgaar / provenance / 落库 / 单源 / 格距 / 回执 / 幂等 / N3a / φ
 *   4) 负向探针：去掉一个按钮文字、塞一句 “FMG 模板”，同一条判据必须报红
 *
 * 用法：node scripts/tests/unit/test_toolbar_ux.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FILE = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 本仓 index=LF、工作树可能被 autocrlf 改 CRLF —— 读源码先归一化 */
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function attrName(prop) {
  const raw = prop && (prop.rawName || prop.name);
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  // static 属性没有 rawName，name 是字符串；指令的 rawName 带 v- 前缀
  return String(raw.content || '');
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

/** 收集节点的全部可见文字（type 2 = 文本节点） */
function textOf(node) {
  if (!node) return '';
  if (node.type === 2) return node.content || '';
  if (node.type === 3) return '';
  let out = '';
  for (const ch of node.children || []) out += textOf(ch);
  return out;
}

/** 在 AST 里找 class 含 toolbar-more 的元素 */
function findMore(ast) {
  let hit = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || hit) return;
    if (n.type === 1 && /\btoolbar-more\b/.test(attrOf(n, 'class'))) { hit = n; return; }
    for (const ch of n.children || []) walk(ch);
  };
  walk(ast);
  return hit;
}

/** 收集 more 子树里的按钮与分区标题 */
function scanMore(more) {
  const buttons = [];
  const sections = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 1) {
      if (n.tag === 'button') buttons.push({ text: textOf(n).replace(/\s+/g, ' ').trim(), line: n.loc.start.line });
      const tid = attrOf(n, 'data-testid');
      if (/^more-sec-/.test(tid)) sections.push({ tid, text: textOf(n).replace(/\s+/g, ' ').trim(), line: n.loc.start.line, style: attrOf(n, 'style') });
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(more);
  return { buttons, sections };
}

const SRC = readText(FILE);
const { parse } = require('@vue/compiler-sfc');
const parsed = parse(SRC, { filename: 'ScenarioMap.vue' });
const ast = parsed.descriptor.template && parsed.descriptor.template.ast;
assert(ast, 'ScenarioMap.vue 没有模板 AST');
const more = findMore(ast);
assert(more, '找不到 .toolbar-more（“更多”面板）');

const { buttons, sections } = scanMore(more);
const REGION = SRC.slice(more.loc.start.offset, more.loc.end.offset);

/** 判据 2：每个按钮都有可见文字（中文或 ≥2 个字母数字；纯符号不行） */
function checkButtonText(list) {
  const bad = list.filter((b) => !/[\u4e00-\u9fff]/.test(b.text) && String(b.text).replace(/\s/g, '').length < 2);
  assert(bad.length === 0,
    '这些按钮只有图标/符号、没有名字（用户就是找不到它们）：' + bad.map((b) => 'L' + b.line + ' “' + b.text + '”').join(' | '));
  return list.length + ' 个按钮都有名字';
}

/** 判据 1：分区标题 ≥ 4，且都含中文 */
function checkSections(list) {
  assert(list.length >= 4, '“更多”里的分区标题只有 ' + list.length + ' 个（少于 4）—— 用户在一屏 50 个按钮里找不到东西');
  const bad = list.filter((s) => !/[\u4e00-\u9fff]/.test(s.text));
  assert(bad.length === 0, '分区标题里没有中文：' + bad.map((s) => s.tid).join(', '));
  // 🔴 “更多”是**列**容器：标题上再写 `flex-basis:100%` 会变成“高度占满整个面板”，
  //   四个标题叠在一起、把每一行都压扁 → 截图里文字重影（2026-11-05 真踩）。
  const shrink = list.filter((s) => /flex-basis\s*:/.test(s.style || ''));
  assert(shrink.length === 0, '分区标题上还写着 flex-basis（列容器里会撑满高度）：' + shrink.map((s) => s.tid).join(', '));
  return list.map((s) => s.text).join(' / ');
}

const JARGON = ['FMG', 'Azgaar', 'provenance', '落库', '单源', '格距', '回执', '幂等', 'N3a', 'φ'];
// 全模板只禁**工程内部术语**：FMG / Azgaar 是第三方产品的名字，用户在导入 .map 时反而认得它，
// 写成“Azgaar 这类地图软件导出的文件”比干巴巴一句“导入 .map”更好懂。禁它们只限“更多”工具栏
// （那里一屏 50 个按钮，名字必须一眼懂，不能带任何需要先知道渊源的词）。
const JARGON_TECH = JARGON.filter((w) => w !== 'FMG' && w !== 'Azgaar');
/** 判据 3：面向用户的文字里不许出现内部术语 */
function checkNoJargon(regionText) {
  // 注释里允许出现（那是给维护者看的），先剥掉 HTML 注释
  const visible = regionText.replace(/<!--[\s\S]*?-->/g, '');
  const hits = JARGON.filter((w) => visible.includes(w));
  assert(hits.length === 0, '“更多”里还有内部术语：' + hits.join(' / '));
  return JARGON.length + ' 个术语 0 命中';
}

/** 收集整张模板里**用户看得见**的字符串：文本节点 + title 属性 */
function visibleStrings(ast) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 2) {
      const t = String(n.content || '').trim();
      if (t) out.push({ text: t, line: n.loc.start.line });
    }
    if (n.type === 1) {
      for (const p of n.props || []) {
        if (attrName(p) === 'title') {
          const v = attrValue(p).trim();
          if (v) out.push({ text: v, line: n.loc.start.line });
        }
      }
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(ast);
  return out;
}

/** 判据 4：**整张剧本视图模板**的可见文字不许有内部术语（不只“更多”） */
function checkTemplateJargon(strings) {
  const bad = strings.filter((s) => JARGON_TECH.some((w) => s.text.includes(w)));
  assert(bad.length === 0,
    '剧本视图里还有用户看不懂的术语：' + bad.slice(0, 6).map((s) => 'L' + s.line + ' “' + s.text.slice(0, 40) + '”').join(' | '));
  return strings.length + ' 处可见文字，0 命中';
}

check('“更多”有成型的分区标题（≥4，且都写人话）', () => checkSections(sections));
check('“更多”里每个按钮都有可见文字（不许只有图标/符号）', () => checkButtonText(buttons));
check('“更多”里没有内部术语（FMG / Azgaar / 落库 / 单源 …）', () => checkNoJargon(REGION));

const VISIBLE = visibleStrings(ast);
check('整张剧本视图的可见文字（文本 + 悬停说明）零内部术语', () => checkTemplateJargon(VISIBLE));

check('负向探针：按钮去文字 / 塞术语，两条判据都要红', () => {
  let caughtText = false;
  try { checkButtonText(buttons.concat([{ text: '', line: 1 }])); } catch (_) { caughtText = true; }
  assert(caughtText, '负向探针没抓住“纯图标按钮”（判据形同虚设）');

  let caughtJargon = false;
  try { checkNoJargon(REGION + '\n<div>FMG 模板</div>'); } catch (_) { caughtJargon = true; }
  assert(caughtJargon, '负向探针没抓住内部术语（判据形同虚设）');
  return '两条都抓住了';
});

const bad = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length === 0 ? 0 : 1);
