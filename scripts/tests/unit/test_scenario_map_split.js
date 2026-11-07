#!/usr/bin/env node
/**
 * Node 单元测试：ScenarioMap 的“体量 + 浮层落点”判据（2026-11-03，N1.6）
 *
 * 为什么要这个文件：
 *   ① ScenarioMap.vue 之前 8,554 行 —— 判据（PLAN_AUDIT 第 4 条）是 ≤8,500，只差 54 行，
 *      但"差分"不是结构问题；真正的大头是 1,641 行 CSS。本轮把样式原样搬进
 *      `scenario-map.css`（`<style scoped src>` 仍然加同一个 scope 属性，选择器语义不变），
 *      SFC 降到 6,914 行。这条用例把"不许再涨回去"钉住（阈值给到 7,000，留 86 行余量）。
 *   ② 2026-11-03 的真 bug：六个浮层（外交 / 地形参数 / FMG / 造陆 / 地形注记 / 派生）
 *      被写进“更多”下拉的 `v-if="moreOpen"` 子树 —— 下拉一关，`v-if="xxxOpen"` 那个节点
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

  check('m1 SFC 行数 ≤6,520（判据 ≤8,500；8,554 → 6,900 → 6,800 → 6,750 → 6,650 → 6,620 → 6,590 → 6,560 → 6,520）', () => {
    const n = SRC.split('\n').length;
    assert(n <= 6520, `ScenarioMap.vue 实测 ${n} 行，超过 6,520 —— 又往这个文件里堆东西了？`
      + '新东西请进 scenario/panels/（含 toolbar/）的子组件或 scenario/ 下的模块，别塞回这里。');
    return `${n} 行`;
  });

  check('m2 样式块必须是外链（<style scoped src>）；主表 + 子组件的样式总量不许缩水', () => {
    assert(SRC.includes('<style scoped src="./scenario-map.css"></style>'),
      'ScenarioMap.vue 没有 `<style scoped src="./scenario-map.css"></style>` —— 样式块又被写回 SFC 了');
    assert(fs.existsSync(CSS), `找不到 ${CSS}`);
    const n = CSS_SRC.split('\n').length;
    // 2026-11-06：样式开始按组件拆分，主表的行数会**合法地**变少 ——
    // 所以判据从“主表 ≥1200 行”改成“主表 + 拆出去组件的样式总量 ≥ 原始 1,639 行”，
    // 这样“搬走了”和“搬丢了”才分得开。
    let panelCssLines = 0;
    const panelDir = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'panels');
    if (fs.existsSync(panelDir)) {
      for (const f of fs.readdirSync(panelDir)) {
        if (f.endsWith('.css')) panelCssLines += readText(path.join(panelDir, f)).split('\n').length;
        if (!f.endsWith('.vue')) continue;
        const m = readText(path.join(panelDir, f)).match(/<style scoped>([\s\S]*?)<\/style>/);
        if (m && m[1].trim()) panelCssLines += m[1].split('\n').length;
      }
    }
    const total = n + panelCssLines;
    assert(total >= 1639,
      `样式总量只有 ${total} 行（主表 ${n} + 子组件 ${panelCssLines}），少于原始 1,639 —— 有样式搬丢了`);
    // 反面对照：SFC 里不许再留内联样式内容
    const inline = SRC.match(/<style scoped>([\s\S]*?)<\/style>/);
    assert(!inline || !inline[1].trim(), 'ScenarioMap.vue 里还有一个带内容的内联 <style scoped> 块（双源）');
    return `${n} 行主表 + ${panelCssLines} 行子组件 = ${total}`;
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
    assert(hasMoreOpenGate, '模板里找不到 v-if="moreOpen" 的“更多”下拉 —— 这条判据会永远通过（空转）');

    const bad = [];
    for (const [w, chain] of chains) {
      if (chain.length) bad.push(`${w} 仍嵌在 ${chain.join(' > ')} 里`);
    }
    assert(!bad.length, `浮层又被塞回“更多”下拉（下拉一关它就整个消失 = 点了没反应）：${bad.join('；')}`);
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

  // 2026-11-03 实地发现：修 ①② 时把“地形注记”的整块 Teleport **复制**了一份（两个都 v-if 同一状态）
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

  // 2026-11-06：样式开始按组件拆。判据 = **搬走了就是搬走了**：组件文件得在、
  // ScenarioMap 里得用组件标签引用、老 class 不许还留在 scenario-map.css（留着就是双源）。
  // ⚠ 唯一允许留下的形态：**容器级**选择器（`.scenario-map-container.immersive .xxx`）——
  //   它挂在父组件的根上，子组件根节点会继承父 scope id，搬进子组件反而会让它失效
  //   （沉浸模式隐藏左栏就是这一条）。所以这类位置放行，别的一律算双源。
  const EXTRACTED = [
    ['LayerLockPanel.vue', 'LayerLockPanel', '.layer-lock-panel'],
    ['BurgEditorPanel.vue', 'BurgEditorPanel', '.burg-editor-panel'],
    ['BasemapSourcePanel.vue', 'BasemapSourcePanel', '.bmsrc-panel'],
    ['ScenarioManagerDialog.vue', 'ScenarioManagerDialog', '.modal-overlay'],
    ['ScenarioListPanel.vue', 'ScenarioListPanel', '.scenario-list-panel'],
    ['ProvincePropsPanel.vue', 'ProvincePropsPanel', '.province-props'],
    ['MarkerPropsPanel.vue', 'MarkerPropsPanel', '.marker-props'],
  ];
  /** 取 idx 处那条规则的**选择器**（往前找到上一个 } 或 { 为止） */
  function ruleSelectorAt(css, idx) {
    let start = idx;
    while (start > 0) {
      const ch = css[start - 1];
      if (ch === '}' || ch === '{' || (ch === ';' && css.slice(start - 2, start) === '*/')) break;
      start--;
    }
    return css.slice(start, idx).split('\n').pop().trim();
  }
  check('m7 拆出去的浮层：组件文件在 + 被组件标签引用 + 老样式不在主表里（防双源）', () => {
    const bad = [];
    for (const [file, tag, cls] of EXTRACTED) {
      const p = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'panels', file);
      if (!fs.existsSync(p)) { bad.push(`${file} 不存在（该在 scenario/panels/ 下）`); continue; }
      if (!new RegExp(`<${tag}[\\s>]`).test(SRC)) bad.push(`ScenarioMap.vue 没有引用 <${tag}>`);
      // 主表里还留着这个 class 吗？（容器级规则除外）
      let i = CSS_SRC.indexOf(cls);
      while (i >= 0) {
        const sel = ruleSelectorAt(CSS_SRC, i);
        if (!sel.startsWith('.scenario-map-container')) {
          bad.push(`scenario-map.css 里还留着 ${cls} 的样式（${sel}）—— 双源，该跟着组件走`);
          break;
        }
        i = CSS_SRC.indexOf(cls, i + 1);
      }
      const own = readText(p);
      // 组件的样式可能内联（`<style scoped>…`）也可能外链（`<style scoped src="./x.css">`）——
      // 外链时去引用的那份 CSS 里找（省份/标记面板共用 props-panel.css 就是这一种）。
      let ownCss = own;
      const srcM = own.match(/<style scoped src="([^"]+)"><\/style>/);
      if (srcM) {
        const cssPath = path.resolve(path.dirname(p), srcM[1]);
        ownCss = fs.existsSync(cssPath) ? readText(cssPath) : '';
      }
      if (!ownCss.includes(cls)) bad.push(`${file} 自己（或它 src 的 CSS）没写 ${cls}（样式丢了两边都没有）`);
    }
    assert(!bad.length, bad.join('；'));
    return `${EXTRACTED.length} 个`;
  });

  // 🔴 2026-11-07 真机抓到的事故：试点把“拆分 / 合并 / 删除”那一行拆进
  // `scenario/panels/toolbar/ProvinceOpsRow.vue` 之后，这三个按钮退回**浏览器默认样式**
  // （实测 h=23px / font=Arial 13.3px / display=inline-block / 白底黑字），
  // 而同一屏其它按钮是 h=32px / 12px / flex / 深色皮肤。
  //
  // 根因：`<style scoped>` 的父 scope id **只贴在子组件的根元素上**，子组件内部的
  // `<button>` / `<label>` 拿不到 `[data-v-父]`，于是 `.scenario-toolbar button`
  // 与 `.tool-group button` 这两条“皮肤规则”一条都不命中。
  // 这件事源码闸门看不见（class 还在、DOM 结构没变），浮层视觉演练也看不见
  // （它只覆盖 6 个浮层，不覆盖工具栏行）—— 只有真机上量 computedStyle 才现形。
  //
  // 判据：工具栏的子组件模板里出现的每一个**行内 class / button 标签**，
  // 父表（scenario-map.css）里给它写样式的规则必须带 `:deep(`（穿越组件边界）。
  function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }
  /** 抽出 css 里所有规则的选择器（@ 规则本身跳过） */
  function cssSelectors(css) {
    const out = [];
    const re = /([^{}]+)\{/g;
    let m;
    while ((m = re.exec(css))) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      out.push(sel);
    }
    return out;
  }
  /** 某个 class 名在这条选择器里是“独立 class token”吗（`.tool-group` 不算命中 `.tool-group-x`） */
  function hasClassToken(sel, cls) {
    return new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])').test(sel);
  }
  /** 这条选择器里“这一截（compound）”要求的所有 class（`.a.b:hover` -> ['a','b']） */
  function compoundClasses(compound) {
    const out = [];
    for (const m of compound.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.push(m[1]);
    return out;
  }
  /**
   * 这条规则**真的会命中**“只带这些 class 的那个元素”吗？
   *
   * 🔴 2026-11-07 必须加这一层：第一版只要选择器里出现 `.danger` 就算“父表管它”，
   * 于是 `.ctx-item.danger`（右键菜单里的危险项）把工具栏行里的 `.tool-btn.danger` 误判成
   * “父表给它写了样式但没写 :deep” —— 假红。真正的口径是：**选择器里那一截的 class
   * 必须是该元素 class 的子集**（`.ctx-item.danger` 要求元素同时有 ctx-item，它当然没有）。
   */
  function selectorAppliesTo(sel, cls, ownClasses) {
    const compounds = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const hits = compounds.filter((c) => hasClassToken(c, cls));
    if (!hits.length) return false;
    return hits.some((c) => compoundClasses(c).every((k) => ownClasses.has(k)));
  }
  const TOOLBAR_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'scenario', 'panels', 'toolbar');
  /** 工具栏行组件里用到的“行内 class”与“是否用到 button 标签”（源码级，AST 太重这里不需要） */
  function toolbarRowNeeds(src) {
    const tpl = (src.match(/<template>([\s\S]*)<\/template>/) || [, src])[1];
    // ⚠️ 根元素的 class **不需要** :deep —— `<style scoped>` 的父 scope id 会贴在子组件根节点上，
    //    所以 `.toolbar-row` 这类“根上的 class”照常命中（试点那次就是这么被误判成“没事”的）。
    //    真正的坑在**根里面**：按钮、小标签、分组框。这里先把根元素的 class 摘出去。
    const firstTag = tpl.match(/<([a-zA-Z][\w-]*)([^>]*)>/);
    const rootClasses = new Set();
    if (firstTag) {
      const cm = firstTag[2].match(/\sclass="([^"]*)"/);
      if (cm) for (const tok of cm[1].split(/\s+/)) if (tok && !tok.includes('{')) rootClasses.add(tok);
    }
    const classes = new Set();
    for (const m of tpl.matchAll(/\sclass="([^"]*)"/g)) {
      for (const tok of m[1].split(/\s+/)) if (tok && !tok.includes('{')) classes.add(tok);
    }
    // `:class="{ active: … }"` 这类动态 class 只取 key（active 等是状态，不在这里管）
    return { classes: [...classes].filter((c) => !rootClasses.has(c)),
      rootClasses: [...rootClasses], usesButton: /<button[\s>]/.test(tpl) };
  }
  check('m8 拆进 scenario/panels/toolbar/ 的行：父表必须用 :deep 给行内元素上样式（真机事故守门）', () => {
    assert(fs.existsSync(TOOLBAR_DIR), `找不到 ${TOOLBAR_DIR}`);
    const files = fs.readdirSync(TOOLBAR_DIR).filter((f) => f.endsWith('.vue'));
    // 这条判据必须**有东西可查**，否则组件全删了也全绿
    assert(files.length > 0, 'scenario/panels/toolbar/ 下没有任何 .vue —— 判据空转');
    const sels = cssSelectors(stripCssComments(CSS_SRC));
    const bad = [];
    let checked = 0;
    for (const f of files) {
      const src = readText(path.join(TOOLBAR_DIR, f));
      const { classes, usesButton } = toolbarRowNeeds(src);
      // ① button 标签：父表里必须有 `.scenario-toolbar :deep(button)` 这类穿越规则
      if (usesButton) {
        const hit = sels.some((s) => s.includes(':deep(') && /\bbutton\b/.test(s));
        checked++;
        if (!hit) bad.push(`${f} 用了 <button>，但 scenario-map.css 里没有一条带 :deep( 且选择 button 的规则`
          + ' —— 子组件里的按钮会退回浏览器默认样式（h≈23px / Arial / 白底）');
      }
      // ② 行内 class：凡是父表给它写过样式的，就必须同时有一条 :deep 版本
      const ownClasses = new Set(classes);
      for (const cls of classes) {
        // 只要“真会命中这个元素”的规则（`.ctx-item.danger` 不算管 `.danger`）
        const styling = sels.filter((s) => selectorAppliesTo(s, cls, ownClasses));
        if (!styling.length) continue;                      // 父表根本不管这个 class，跳过
        checked++;
        const deep = styling.some((s) => s.includes(':deep('));
        if (!deep) bad.push(`${f} 用了 .${cls}，父表给它写了样式但都不是 :deep(`
          + `命中：${styling.slice(0, 2).join(' / ')}) —— 子组件里这条样式不会生效`);
      }
    }
    assert(checked > 0, '一个依赖都没查到 —— 判据空转（组件模板解析规则变了？）');
    assert(!bad.length, bad.join('；'));
    return `${files.length} 个行组件 / ${checked} 项依赖`;
  });

  // 负向探针：合成一个“子组件里有 button 与小标签、父表却没写 :deep”的现场，
  // 检测逻辑必须当场点名（否则 m8 是空转，下次事故照样绿灯）。
  check('m8b 负向探针：父表只写非 :deep 的按钮规则 → 必须被判成缺 :deep', () => {
    const probeCss = stripCssComments([
      '.scenario-toolbar button { height: 32px; }',
      '.row-label { color: #94a3b8; }',
    ].join('\n'));
    const sels = cssSelectors(probeCss);
    const probeTpl = '<template><div class="toolbar-row"><label class="row-label">省份：</label>'
      + '<button>拆分</button></div></template>';
    const { classes, usesButton } = toolbarRowNeeds(probeTpl);
    assert(usesButton, '探针模板里的 <button> 没认出来');
    assert(classes.includes('row-label'), '探针模板里的 .row-label 没认出来');
    const btnDeep = sels.some((s) => s.includes(':deep(') && /\bbutton\b/.test(s));
    assert(!btnDeep, '探针对照失效：本来不该有 :deep(button)');
    const labelDeep = sels.filter((s) => hasClassToken(s, 'row-label')).some((s) => s.includes(':deep('));
    assert(!labelDeep, '探针对照失效：本来不该有 :deep(.row-label)');
    // 再验“加了 :deep 就能被认出来”（避免判据永远为红）
    const goodCss = stripCssComments('.scenario-toolbar :deep(button) { height: 32px; }'
      + '.scenario-toolbar :deep(.row-label) { color: #94a3b8; }');
    const gs = cssSelectors(goodCss);
    assert(gs.some((s) => s.includes(':deep(') && /\bbutton\b/.test(s)), '加了 :deep(button) 却没认出来');
    assert(gs.filter((s) => hasClassToken(s, 'row-label')).some((s) => s.includes(':deep(')),
      '加了 :deep(.row-label) 却没认出来');
    return '非 :deep → 红；加了 :deep → 绿';
  });

  // m8c：复合选择器不许误报（2026-11-07 真实误报：`.ctx-item.danger` 把工具栏行里的
  // `.tool-btn.danger` 判成“父表管它却没写 :deep”，于是 m8 假红）。两个方向都要验。
  check('m8c 负向探针：复合选择器（.ctx-item.danger）不许当成“管到了 .danger”', () => {
    const css = stripCssComments('.ctx-item.danger { color: #f87171; }'
      + '.scenario-toolbar :deep(button) { height: 32px; }');
    const sels = cssSelectors(css);
    const own = new Set(['tool-btn', 'danger']);        // 真实元素只有这两个 class
    assert(!selectorAppliesTo('.ctx-item.danger', 'danger', own),
      '.ctx-item.danger 要求元素也有 ctx-item —— 不该算命中 .danger（这条会误报成缺 :deep）');
    // 反过来：同一个元素自己的复合类必须认得出（别把判据改瞎）
    const own2 = new Set(['tool-btn', 'danger']);
    assert(selectorAppliesTo('.tool-btn.danger', 'danger', own2),
      '元素真有 tool-btn + danger 时，.tool-btn.danger 必须算命中');
    // 单类规则照旧命中
    assert(selectorAppliesTo('.row-label', 'row-label', new Set(['row-label'])), '单类规则应命中');
    // 父表里那条 :deep(button) 仍在（不然上面的对照没有意义）
    assert(sels.some((s) => s.includes(':deep(') && /\bbutton\b/.test(s)), '探针 CSS 里的 :deep(button) 丢了');
    return 'ctx-item.danger 不算命中；tool-btn.danger 算命中';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n=== ScenarioMap 体量与浮层落点 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

try { main(); } catch (err) { console.error(err); process.exit(1); }
