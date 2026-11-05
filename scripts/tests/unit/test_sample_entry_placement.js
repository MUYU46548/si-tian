#!/usr/bin/env node
/**
 * Node 单元测试：示例项目的**入口位置** + **打包白名单**（2026-11-05）
 *
 * 这两条都是只在“打包版 / 新装机器”上才现形的真缺陷，原来的 dev 演练一条都抓不到
 * （`drill_sample_project.py` 直接调 IPC，从不看按钮在不在；也不看 asar 里装了什么）：
 *
 *   ① 示例地图项目按钮原来只写在 WorldSelector 的**非只读**分支里。而本仓口径是
 *      “无项目 = 只读”（READONLY_WITHOUT_PROJECT = true）——**新装机器第一次打开**
 *      正是只读态，于是最该看见示例的那条路径上按钮根本不存在。2026-11-05 打包演练
 *      一跑就红（`世界选择页有“示例地图项目”按钮`）。
 *      判据：该按钮的**祖先链里不许出现任何 v-if / v-else-if / v-else** —— 两态都渲染。
 *
 *   ② `build.files` 原为 `sample` 整目录通配，于是生成器日志（含 `E:\…` 绝对路径）与
 *      `*.sitian.backups/`（4 份 ≈8MB 重复载荷）一起进了安装包（0.5.2 之前的包实测）。
 *      判据：sample 只按**显式文件**打包；整目录通配 / 日志 / backups 一律不许出现。
 *
 * 两条判据都自带**负向探针**：把源码/配置改坏（按钮挪进 v-else、通配改回整目录）
 * 再用同一个检查函数跑一遍，必须报错 —— 否则就是“判据看不见问题”的假绿。
 *
 * 用法：node scripts/tests/unit/test_sample_entry_placement.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORLD = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'WorldSelector.vue');
const PANEL = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ProjectPanel.vue');
const PKG = path.join(ROOT, 'package.json');

const results = [];
function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 本仓 index=LF、工作树可能被 autocrlf 改 CRLF —— 读源码先归一化（2026-11-03 假红的来源） */
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function attrName(prop) {
  const raw = prop && (prop.rawName || prop.name);
  if (!raw) return '';
  return typeof raw === 'string' ? raw : (raw.content || '');
}
/** 静态属性在 compiler-core 的 AST 里是 `{value: {type: 6, content: '…'}}`，不是裸字符串 */
function attrValue(prop) {
  const v = prop && prop.value;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.content === 'string') return v.content;
  // 指令（v-if / v-else-if）的表达式在 `exp.content` 里，不在 `value` 里
  const exp = prop && prop.exp;
  if (exp && typeof exp.content === 'string') return exp.content;
  return '';
}

/**
 * 扫模板 AST：找到带指定 data-testid 的元素，回传它的**祖先链**（内含哪些条件分支）。
 * @returns {{found:number, chains:Array<{cond:string[]}>, testids:string[]}}
 */
function scanTemplate(ast, wanted) {
  const hits = [];
  const testids = [];
  const walk = (node, chain) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 1) {
      const cond = [];
      for (const p of node.props || []) {
        const n = attrName(p);
        if (n === 'v-if') cond.push('v-if=' + attrValue(p));
        if (n === 'v-else-if') cond.push('v-else-if=' + attrValue(p));
        if (n === 'v-else') cond.push('v-else');
        if (n === 'data-testid') testids.push(attrValue(p));
      }
      const chain2 = chain.concat([cond]);
      const isWanted = (node.props || []).some((p) => attrName(p) === 'data-testid'
        && attrValue(p) === wanted);
      if (isWanted) hits.push({ chain: chain2, tag: node.tag });
      for (const ch of node.children || []) walk(ch, chain2);
      return;
    }
    for (const ch of node.children || []) walk(ch, chain);
  };
  walk(ast, []);
  return { found: hits.length, hits, testids };
}

/** 判据①：按钮恰好一个，且祖先链里没有任何条件分支（只读态也渲染） */
function checkSampleButtonVisible(src) {
  const { parse } = require('@vue/compiler-sfc');
  const parsed = parse(src, { filename: 'WorldSelector.vue' });
  const ast = parsed.descriptor.template && parsed.descriptor.template.ast;
  assert(ast, 'WorldSelector.vue 没有模板 AST');
  const { found, hits } = scanTemplate(ast, 'world-open-sample');
  assert(found === 1, `示例地图项目按钮应恰好 1 个，实际 ${found} 个`);
  // 只判**状态分支**：`v-else` / `v-else-if` / 条件里带 readOnly。
  // 外层 `v-if="worlds.length === 0"`（空态）是允许的 —— 没有世界时才显示空态，
  // 而新装机器正是“没有世界”；有世界的用户从项目面板进（见下一条判据）。
  const conds = hits[0].chain.reduce((acc, c) => acc.concat(c), []);
  const bad = conds.filter((c) => /^v-else/.test(c) || /readOnly/.test(c));
  assert(bad.length === 0,
    '示例地图项目按钮被挂在只读态分支下（' + bad.join(' / ') + '）—— 新装机器（无项目 = 只读）会看不见它');
  return conds.length ? conds.join(' / ') : '无条件分支';
}

/** 判据②：build.files 里 sample 只按显式文件打包 */
function checkSamplePackaging(pkg) {
  const files = ((pkg.build || {}).files) || [];
  const entry = files.find((f) => /^sample\//.test(String(f)) && !String(f).startsWith('!'));
  assert(entry, 'build.files 里没有 sample 条目（示例不会被装进包）');
  assert(String(entry) === 'sample/示例世界.sitian',
    `sample 必须按显式文件打包（现在是 ${entry}）—— 整目录通配会把生成器日志与 *.backups 一起塞进安装包`);
  const banned = files.filter((f) => {
    const s = String(f);
    return /^sample\/\*\*/.test(s) || /^sample\/$/.test(s) || /^sample\/\*\.\*$/.test(s)
      || /\.backups/.test(s) && !s.startsWith('!') || /gen-\*\.log/.test(s);
  });
  assert(banned.length === 0, 'build.files 里有会被打进包的目录通配 / 日志 / backups：' + banned.join(', '));
  return entry;
}

const SRC = readText(WORLD);
const PANEL_SRC = fs.existsSync(PANEL) ? readText(PANEL) : '';
const PKG_JSON = JSON.parse(readText(PKG));

check('WorldSelector：示例地图项目按钮不受任何条件分支约束（只读态也渲染）', () => {
  const detail = checkSampleButtonVisible(SRC);
  // 负向探针：把按钮**搬进**非只读分支（v-else 内）必须被同一条判据抓住
  const removed = SRC.replace(
    /\n\s*<button class="create-btn" data-testid="world-open-sample"[\s\S]*?<\/button>/,
    '');
  assert(removed !== SRC, '负向探针构造失败（没找到原按钮）');
  const moved = removed.replace(
    /(<button class="create-btn" @click="\$emit\('create-world'\)">＋ 新建世界<\/button>)/,
    '$1\n          <button class="create-btn" data-testid="world-open-sample" @click="openSampleProject">示例地图项目</button>');
  assert(moved !== removed, '负向探针构造失败（没找到 v-else 分支里的插入点）');
  let caught = false;
  try { checkSampleButtonVisible(moved); } catch (_) { caught = true; }
  assert(caught, '负向探针没抓住“按钮写进 v-else 里”（判据形同虚设）');
  return detail;
});

check('两个入口共用 store 里的同一份实现（面板不许直接调 sitianAPI）', () => {
  const STORE = readText(path.join(ROOT, 'src', 'renderer', 'src', 'store', 'projectStore.js'));
  assert(/proj\.openSampleProject\s*\(/.test(SRC), 'WorldSelector 没走 proj.openSampleProject');
  assert(/async function openSampleProject\s*\(/.test(STORE), 'projectStore 没有 openSampleProject');
  assert(/\.sampleProjectOpen\s*\(/.test(STORE), 'store 里没调 sampleProjectOpen（主进程复制）');
  assert(/openProject\s*\(\s*r\.path\s*\)/.test(STORE), 'store 里没把副本路径交给 openProject');
  // 判「调用」而不是判「出现这个词」：注释里会写“不许直接调 sitianAPI”，那是说明不是调用
  assert(!/window\s*\.\s*sitianAPI\s*\./.test(SRC), 'WorldSelector 直接调用了 sitianAPI（test_48 口径：应只经 projectStore）');
  assert(!/window\s*\.\s*sitianAPI\s*\./.test(PANEL_SRC), 'ProjectPanel 直接调用了 sitianAPI（test_48 口径：应只经 projectStore）');
  return 'store 单源';
});

check('ProjectPanel 也有示例入口（多两跳的备用路径）', () => {
  assert(/data-testid="pp-open-sample"/.test(PANEL_SRC), 'ProjectPanel 没有 pp-open-sample 按钮');
  assert(/proj\.openSampleProject\s*\(/.test(PANEL_SRC), 'ProjectPanel 的示例按钮没走 store 的 openSampleProject');
  return 'pp-open-sample';
});

check('package.json build.files：sample 只按显式文件打包', () => {
  const detail = checkSamplePackaging(PKG_JSON);
  // 负向探针：改回整目录通配必须被抓住
  const bad = JSON.parse(JSON.stringify(PKG_JSON));
  bad.build.files = bad.build.files.map((f) => (f === 'sample/示例世界.sitian' ? 'sample/**/*' : f));
  let caught = false;
  try { checkSamplePackaging(bad); } catch (_) { caught = true; }
  assert(caught, '负向探针没抓住 sample/**/*（判据形同虚设）');
  return detail;
});

const bad = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
}
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
process.exit(bad.length === 0 ? 0 : 1);
