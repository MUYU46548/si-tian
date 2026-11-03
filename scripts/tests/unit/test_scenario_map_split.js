#!/usr/bin/env node
/**
 * Node 单元测试：ScenarioMap 的「体量 + 浮层落点」判据（2026-11-03，N1.6）
 *
 * 为什么要这个文件：
 *   ① ScenarioMap.vue 之前 8,554 行 —— 判据（PLAN_AUDIT 第 4 条）是 ≤8,500，只差 54 行，
 *      但"差分"不是结构问题；真正的大头是 1,641 行 CSS。本轮把样式原样搬进
 *      `scenario-map.css`（`<style scoped src>` 仍然加同一个 scope 属性，选择器语义不变），
 *      SFC 降到 6,914 行。这条用例把"不许再涨回去"钉住（阈值给到 7,000，留 86 行余量）。
 *   ② 2026-11-03 的真 bug：六个浮层（外交 / 地形参数 / FMG / 造陆 / 地形注记 / 派生）
 *      被写进「更多」下拉的 `v-if="moreOpen"` 子树 —— 下拉一关，`v-if="xxxOpen"` 那个节点
 *      连存在都不存在，表现是"点了没反应"。当时只靠 `drill_diplomacy_overlay.py` 在真机上抓。
 *      本用例用 `@vue/compiler-sfc` 打**模板 AST 的祖先链**，把这条做成秒级源码闸门。
 *
 * 用法：node scripts/tests/unit/test_scenario_map_split.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VUE = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ScenarioMap.vue');
const CSS = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'scenario-map.css');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 本仓 index=LF、工作树可能被 autocrlf 变 CRLF —— 读源码先归一化（2026-11-03 假红的来源） */
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

const SRC = readText(VUE);
const CSS_SRC = fs.existsSync(CSS) ? readText(CSS) : '';

const WRAPS = [
  ['diplomacy-wrap', '外交表'],
  ['terrain-gen-wrap', '地形生成参数'],
  ['fmg-wrap', 'FMG 模板地形'],
  ['landmass-wrap', '造陆'],
  ['derive-wrap', '文化/宗教/势力派生'],
  ['terrain-labels-wrap', '地形注记'],
];

function attrName(prop) {
  if (!prop) return '';
  if (prop.type === 6) return prop.name;                       // 静态属性 data-testid="x"
  if (prop.type === 7) return prop.rawName || prop.name;        // v-if / :foo / @click
  return '';
}
function attrValue(prop) {
  if (!prop) return '';
  if (prop.type === 6) return (prop.value && prop.value.content) || '';
  return (prop.exp && prop.exp.content) || '';
}
function label(node) {
  const bits = [node.tag];
  for (const p of node.props || []) {
    const n = attrName(p);
    if (n === 'class' || n === 'data-testid' || n === 'v-if') bits.push(`${n}="${attrValue(p)}"`);
  }
  const line = node.loc && node.loc.start ? node.loc.start.line : '?';
  return `<${bits.join(' ')}> @L${line}`;
}

/** 模板 AST → `{ chains, hasMoreOpenGate, testids }`（唯一实现；m4 与自检探针共用） */
function scanTemplate(ast) {
  const chains = new Map();
  const testids = new Set();
  const counts = new Map();
  let hasMoreOpenGate = false;
  const walk = (node, chain) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 1) {
      const chain2 = chain.concat([node]);
      for (const p of node.props || []) {
        const n = attrName(p);
        if (n === 'v-if' && /moreOpen/.test(attrValue(p))) hasMoreOpenGate = true;
        if (n === 'data-testid') {
          const v = attrValue(p);
          testids.add(v);
          counts.set(v, (counts.get(v) || 0) + 1);
        }
      }
      for (const p of node.props || []) {
        if (attrName(p) !== 'data-testid') continue;
        const v = attrValue(p);
        if (WRAPS.some(([w]) => w === v)) {
          const blocked = chain2.slice(0, -1).filter((a) => (a.props || []).some(
            (q) => attrName(q) === 'v-if' && /moreOpen/.test(attrValue(q))));
          chains.set(v, blocked.map(label));
        }
      }
      for (const ch of node.children || []) walk(ch, chain2);
      return;
    }
    for (const ch of (node.children || [])) walk(ch, chain);
  };
  walk(ast, []);
  return { chains, hasMoreOpenGate, testids, counts };
}

function main() {
  const { parse } = require('@vue/compiler-sfc');
  const parsed = parse(SRC, { filename: 'ScenarioMap.vue' });
  const ast = parsed.descriptor.template && parsed.descriptor.template.ast;

  check('m1 SFC 行数 ≤7,000（判据 ≤8,500；本轮从 8,554 降到 6,900 级）', () => {
    const n = SRC.split('\n').length;
    assert(n <= 7000, `ScenarioMap.vue 实测 ${n} 行，超过 7,000 —— 样式/逻辑又涨回去了吧？`);
    return `${n} 行`;
  });

  check('m2 样式块必须是外链（<style scoped src>），且 CSS 文件真的在', () => {
    assert(SRC.includes('<style scoped src="./scenario-map.css"></style>'),
      'ScenarioMap.vue 没有 `<style scoped src="./scenario-map.css"></style>` —— 样式块又被写回 SFC 了');
    assert(fs.existsSync(CSS), `找不到 ${CSS}`);
    const n = CSS_SRC.split('\n').length;
    assert(n >= 1200, `scenario-map.css 只有 ${n} 行，像是被截断了（原来 1,639 行样式）`);
    // 反面对照：SFC 里不许再留内联样式内容
    const inline = SRC.match(/<style scoped>([\s\S]*?)<\/style>/);
    assert(!inline || !inline[1].trim(), 'ScenarioMap.vue 里还有一个带内容的内联 <style scoped> 块（双源）');
    return `${n} 行 CSS`;
  });

  check('m3 CSS 里该有的骨架选择器都在（不是空文件/搬漏）', () => {
    for (const sel of ['.scenario-map-container', '.scenario-toolbar', '.toolbar-more', '.scenario-canvas-wrap']) {
      assert(CSS_SRC.includes(sel), `scenario-map.css 缺选择器 ${sel}`);
    }
    assert(!CSS_SRC.includes('</style>'), 'scenario-map.css 里混进了 </style>（把 SFC 标签也搬了）');
    return '4 个骨架选择器';
  });

  check('m4 模板 AST：六个浮层不许再挂在 v-if="moreOpen" 的子树里（2026-11-03 的真 bug）', () => {
    assert(ast, '拿不到模板 AST');
    const { chains, hasMoreOpenGate } = scanTemplate(ast);

    const missing = WRAPS.filter(([w]) => !chains.has(w)).map(([w, n]) => `${w}(${n})`);
    assert(!missing.length, `模板里找不到这些浮层包装节点：${missing.join(', ')}`);
    assert(hasMoreOpenGate, '模板里找不到 v-if="moreOpen" 的「更多」下拉 —— 这条判据会永远通过（空转）');

    const bad = [];
    for (const [w, chain] of chains) {
      if (chain.length) bad.push(`${w} 仍嵌在 ${chain.join(' > ')} 里`);
    }
    assert(!bad.length, `浮层又被塞回「更多」下拉（下拉一关它就整个消失 = 点了没反应）：${bad.join('；')}`);
    return `6 个浮层都在容器直接子节点下`;
  });

  // 负向探针：把"病"合成一份最小模板，检测器必须当场点名（否则 m4 是空转）
  check('m4b 负向探针：合成一个嵌在 moreOpen 下的浮层 → 检测器必须报出来', () => {
    const { parse: parse2 } = require('@vue/compiler-sfc');
    const probe = [
      '<template>',
      '  <div class="scenario-map-container">',
      '    <div class="toolbar-more" v-if="moreOpen">',
      '      <div data-testid="fmg-wrap"></div>',
      '    </div>',
      '  </div>',
      '</template>',
    ].join('\n');
    const p = parse2(probe, { filename: 'probe.vue' });
    const { chains, hasMoreOpenGate } = scanTemplate(p.descriptor.template.ast);
    assert(hasMoreOpenGate, '探针里没认出 v-if="moreOpen" 的门');
    const chain = chains.get('fmg-wrap');
    assert(chain && chain.length === 1, `检测器没能点名被嵌的浮层：${JSON.stringify(chain)}`);
    return chain[0];
  });

  check('m5 模板 AST：外交表两条入口都在（“更多”里 + 势力色板行）', () => {
    const ids = scanTemplate(ast).testids;
    assert(ids.has('diplomacy-open'), '找不到“更多 → 外交”入口（data-testid="diplomacy-open"）');
    assert(ids.has('diplomacy-open-palette'), '找不到势力色板行的快捷入口（diplomacy-open-palette）');
    return '2 条入口';
  });

  // 2026-11-03 实地发现：修 ①② 时把「地形注记」的整块 Teleport **复制**了一份（两个都 v-if 同一状态）
  //   → 面板一开就是两个一模一样的面板精确重叠；`querySelector` 只看得到第一个，所以旧的 DOM 用例全绿。
  check('m6 六个浮层包装节点在模板里**恰好各一次**（重复 = 两块面板精确重叠）', () => {
    const { counts } = scanTemplate(ast);
    const bad = WRAPS
      .map(([w, n]) => [w, n, counts.get(w) || 0])
      .filter(([, , c]) => c !== 1)
      .map(([w, n, c]) => `${w}(${n}) × ${c}`);
    assert(!bad.length, `浮层包装节点重复或缺失：${bad.join('，')} —— 模板里同一块面板只许有一份`);
    return `${WRAPS.length} 个各 1 份`;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n=== ScenarioMap 体量与浮层落点 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

try { main(); } catch (err) { console.error(err); process.exit(1); }
