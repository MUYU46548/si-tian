#!/usr/bin/env node
/**
 * Node 单元测试：**面板类组件的可读性闸门**（2026-11-05）
 *
 * 与剧本 / 行星 / 区域三张同口径（用户原话：“不要再让我看到一大堆乱七八糟的按钮和根本看不懂的文字”，
 * 以及“分不清删还是复制”）。这几张面板是列表行内操作，最容易“只有图标 + 只有 title”。
 *
 * 判据（读模板 AST，秒级）：
 *   1) 每个组件里**每个按钮都有中文可见文字**或插值 —— 只允许广义白名单：
 *      通用符号（× 关闭 / Ｘ / ＋ ／ − 缩放 / ⤢ 适屏）、色块（class 或 :style 底色）、
 *      图标选择器（icon-pick / marker-btn 这类“选图”而非“点动作”）。
 *   2) 整个模板的可见文字（文本 + title）**零工程术语**（Burg / FMG / Azgaar / provenance / 落库…）。
 *   3) 列表行内操作**不许退回“悬停才出现”**（`.row-actions` 的 opacity 不许是 0）——
 *      用户实测过“分不清删还是复制、也找不到”。
 *   4) 三条负向探针：空按钮必须红 / 塞术语必须红 / 把 opacity 改回 0 必须红。
 *
 * 用法：node scripts/tests/unit/test_toolbar_ux_panels.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { parse } = require(path.join(ROOT, 'node_modules', '@vue', 'compiler-sfc'));

// 受闸门的组件（加新面板就往这里加一行；路径相对 components/）
const FILES = [
  { file: 'ObjectListPanel.vue', desc: '对象列表（地形/标记/路线/文本的行内操作）' },
  { file: 'NodeDetailPanel.vue', desc: '节点详情（解绑/删除航道/移除标签/新建/聚落编辑）' },
  { file: 'ClusterPanel.vue', desc: '地点簇（新建 / 改名 / 解散）' },
  { file: 'ZoomControls.vue', desc: '缩放控件（全图 / 选区）' },
  { file: 'EagleEye.vue', desc: '小地图（打开 / 大小 / 关闭）' },
];

const CJK = /[\u4e00-\u9fff]/;
// 通用符号：只有“谁都认得、且语义唯一”的才进来（× 关闭 / − ＋ 缩放 / ⤢ 适屏 / Ｘ 全角叉）
const SYMBOLS = ['×', '✕', '✖', '⨯', '＋', '+', '−', '-', '⤢', 'Ｘ', '↺', '↻'];
// “选图”类（选颜色/选图标），不是“点一下就执行一个动作”
const PICKERS = /swatch|color-btn|color-chip|color-dot|color-swatch|icon-pick|marker-btn|palette/i;
// 披露/折叠（列表行首的 ▸/▾）：这不是“动作按钮”，是“这一行能不能展开”的标准写法，
// 眼睛一看就知道；给它加字反而会把列表挤歪（用户没说错的是“动作按钮”，不是“加减号/箭头”）。
const DISCLOSURE = /fold-btn|collapse|expand|chevron/i;
const JARGON = [
  { label: 'Burg', re: /Burg/ },
  { label: 'FMG', re: /FMG/ },
  { label: 'Azgaar', re: /Azgaar/ },
  { label: 'provenance', re: /provenance/i },
  { label: '落库', re: /落库/ },
  { label: '单源', re: /单源/ },
  { label: '格距（别误伤“网格距离”）', re: /(?<!网)格距/ },
  { label: '回执', re: /回执/ },
  { label: '幂等', re: /幂等/ },
  { label: 'N3a', re: /N3a/ },
];

function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

// ---- AST 小工具（与 test_toolbar_ux_area.js 同口径） ----
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
  if (node.type === 5) return '{{ }}';   // 插值：运行时就是文字
  if (node.type === 3) return '';        // 注释
  let out = '';
  for (const ch of node.children || []) out += textOf(ch);
  return out;
}

function scanButtons(ast) {
  const buttons = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 1 && n.tag === 'button') {
      buttons.push({
        text: textOf(n).replace(/\s+/g, ' ').trim(),
        line: n.loc.start.line,
        cls: attrOf(n, 'class') + ' ' + dynAttr(n, ':class'),
        style: dynAttr(n, ':style'),
      });
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(ast);
  return buttons;
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

/** 判据 1：每个按钮都要有中文 / 插值 / 白名单 */
function nakedButtons(buttons) {
  return buttons.filter((b) => {
    if (CJK.test(b.text)) return false;
    if (b.text.includes('{{')) return false;
    if (SYMBOLS.includes(b.text)) return false;
    if (PICKERS.test(b.cls)) return false;
    if (DISCLOSURE.test(b.cls)) return false;
    if (/background/.test(b.style || '')) return false;
    return true;
  }).map((b) => `L${b.line}“${b.text}”(${b.cls.trim() || '无 class'})`);
}

/** 判据 2：可见文字零工程术语 */
function jargonHits(strings) {
  return strings
    .filter((s) => JARGON.some((w) => w.re.test(s.text)))
    .map((s) => `L${s.line}“${s.text.slice(0, 40)}”`);
}

/** 判据 3：列表行内操作不许退回“悬停才出现”（opacity: 0） */
function hoverOnlyActions(src) {
  const hits = [];
  const re = /\.row-actions[^{]*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    const op = /opacity\s*:\s*([0-9.]+)/.exec(body);
    if (op && Number(op[1]) === 0) hits.push(op[1]);
  }
  return hits;
}

// ---- 跑 ----
const results = [];
let failedNeg = false;

function run(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ' —— ' + detail : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    console.log(`  ❌ ${name} —— ${(err && err.message) || err}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

for (const item of FILES) {
  const file = path.join(ROOT, 'src', 'renderer', 'src', 'components', item.file);
  const src = readText(file);
  const parsed = parse(src, { filename: item.file });
  const ast = parsed.descriptor.template && parsed.descriptor.template.ast;
  if (!ast) {
    console.log(`  ❌ ${item.file}：没有模板 AST`);
    results.push({ name: `${item.file} AST`, ok: false, detail: '无模板' });
    continue;
  }
  const buttons = scanButtons(ast);
  const visible = visibleStrings(ast);

  run(`${item.file}：每个按钮都有名字（${item.desc}）`, () => {
    assert(buttons.length >= 3, `只找到 ${buttons.length} 个按钮 —— 判据扫空等于没测`);
    const bad = nakedButtons(buttons);
    assert(bad.length === 0, `还有只有图标的按钮：${bad.slice(0, 8).join(' | ')}`);
    return `${buttons.length} 个按钮：都有中文 / 插值 / 白名单`;
  });

  run(`${item.file}：可见文字零工程术语`, () => {
    const bad = jargonHits(visible);
    assert(bad.length === 0, `还有工程术语：${bad.slice(0, 6).join(' | ')}`);
    return `${visible.length} 处可见文字，0 命中`;
  });

  run(`${item.file}：行内操作不许“悬停才出现”（opacity: 0）`, () => {
    const hits = hoverOnlyActions(src);
    assert(hits.length === 0, `.row-actions 又有 opacity: 0 了（${hits.length} 处）—— 用户实测找不到`);
    return '不是 opacity: 0';
  });
}

run('负向探针：塞一个空按钮进任意组件必须红', () => {
  const bad = nakedButtons([{ text: '', line: 999, cls: 'plain', style: '' }]);
  assert(bad.length === 1, '负向探针没抓住空按钮 —— 判据是恒真的');
  failedNeg = true;
  return '抓到了';
});
run('负向探针：塞工程术语必须红', () => {
  const bad = jargonHits([{ text: '改完立即落库', line: 998 }]);
  assert(bad.length === 1, '负向探针没抓住术语');
  return '抓到了';
});
run('负向探针：把 .row-actions 改回 opacity: 0 必须红', () => {
  const hits = hoverOnlyActions('.row-actions { opacity: 0; transition: .15s; }');
  assert(hits.length === 1, '负向探针没抓住悬停才出现的样式');
  return '抓到了';
});

const bad = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - bad.length}/${results.length} 通过 ===`);
if (bad.length) {
  for (const f of bad) console.log(`  ❌ ${f.name}: ${f.detail}`);
  process.exit(1);
}
if (!failedNeg) { console.log('  ❌ 负向探针没有真正跑过'); process.exit(1); }
process.exit(0);
