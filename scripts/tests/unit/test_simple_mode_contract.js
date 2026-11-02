#!/usr/bin/env node
/**
 * Node 单元测试：简易模式（M3 / N3b-2）的**源码契约**
 *
 * 为什么要有这一层：简易模式的价值全在两条**结构约束**上，而这两条都不是"跑一下能看出来"的 ——
 *   ① **零数据分叉**：它必须只调既有 store 能力、不碰持久化。一旦有人图省事在组件里
 *      `window.sitianAPI.saveXxx` / `localStorage.setItem`，.sitian 就会长出第二份事实源，
 *      而这种分叉在界面上完全不报错（只是"切回完整模式数据不见了"）。
 *   ② **同一能力只一份实现**：画省份 / 导出 PNG 的入口只在剧本编辑器里，简易模式必须交回去，
 *      不许在这儿写第二份几何 / 导出逻辑。
 * 本仓的无头 CDP 用例这轮不可用（5180/9222 被占用），所以判据落在**源码**上：
 *   a) 四个步骤与四个动作的 data-testid 齐备（挂载后验得到的前提）；
 *   b) 每个 `store.xxx(` 调用都能在 store 的真实导出面（geodata.js / geodataModules）里找到，
 *      项目侧 `proj.xxx(` 同理（projectStore 的导出面）；
 *   c) 不出现 `window.sitianAPI` / `ipcRenderer` / `localStorage.setItem` / `sessionStorage.setItem`；
 *   d) App.vue 的入口与会话接线齐备，且**不用 Teleport**（本仓无头环境里 Teleport 子节点进不了 DOM）。
 *
 * 判据的**已知放宽**（宁可漏报不误报，与本仓 test_undefined_identifiers 同一口径）：
 *   · "导出面"取每个文件里**最后一个** `return { … }` 块（模块工厂 / defineStore 的出口）；
 *   · 只要名字能在导出面里找到，或该文件里有 `function <同名>(`，就算既有能力 —— 不校验签名。
 *
 * 用法：node scripts/tests/unit/test_simple_mode_contract.js
 * 退出码：0 = 全通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SFC = 'src/renderer/src/components/SimpleMode.vue';
const APP = 'src/renderer/src/App.vue';
const GEO = 'src/renderer/src/store/geodata.js';
const PSTORE = 'src/renderer/src/store/projectStore.js';
const MODULES_DIR = 'src/renderer/src/store/geodataModules';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/** 剥注释：判据不许被注释里的示例骗过（模板里的 HTML 注释也要剥 —— 里面写了解释 Teleport 的话） */
function codeOnly(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取文件里**最后一个** `return { … }` 块（= 模块工厂 / defineStore 的导出面） */
function lastReturnBlock(src) {
  const code = codeOnly(src);
  let from = 0;
  let best = '';
  while (true) {
    const at = code.indexOf('return {', from);
    if (at < 0) break;
    let i = code.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    best = code.slice(at, end + 1);
    from = end + 1;
  }
  return best;
}

/** 导出面里的标识符集合（含键名与值名；刻意放宽，见文件头） */
function surfaceNames(rel) {
  const set = new Set();
  const block = lastReturnBlock(read(rel));
  for (const m of block.matchAll(/[A-Za-z_$][\w$]*/g)) set.add(m[0]);
  return set;
}

/** 某文件里以 `function <name>(` 声明过的名字 */
function declaredFunctions(src) {
  return new Set([...codeOnly(src).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
}

function moduleFiles() {
  return fs.readdirSync(path.join(ROOT, MODULES_DIR)).filter((f) => f.endsWith('.js')).sort();
}

/** 收集一个 SFC/JS 源码里的 `obj.method(` 调用名（去重） */
function callsOf(code, obj) {
  const re = new RegExp(`\\b${obj}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  return [...new Set([...code.matchAll(re)].map((m) => m[1]))];
}

/** store 方法名 → 出处（'' = 找不到 = 失败） */
function buildStoreIndex() {
  const geoSurface = surfaceNames(GEO);
  const geoFns = declaredFunctions(read(GEO));
  const byModule = new Map();   // name -> 模块文件名
  const fnInModule = new Map(); // name -> 模块文件名（function 声明兜底）
  for (const f of moduleFiles()) {
    const rel = `${MODULES_DIR}/${f}`;
    const src = read(rel);
    for (const n of surfaceNames(rel)) if (!byModule.has(n)) byModule.set(n, f);
    for (const n of declaredFunctions(src)) if (!fnInModule.has(n)) fnInModule.set(n, f);
  }
  return function resolve(name) {
    if (geoSurface.has(name) || geoFns.has(name)) return 'store/geodata.js';
    if (byModule.has(name)) return `store/geodataModules/${byModule.get(name)}`;
    if (fnInModule.has(name)) return `store/geodataModules/${fnInModule.get(name)}（function 声明）`;
    return '';
  };
}

function main() {
  // ── a) 组件本体与测试钩子 ──────────────────────────────────────────────
  check('a1 组件存在且是 <script setup>（无 Options API）', () => {
    assert(exists(SFC), `找不到 ${SFC}`);
    const src = read(SFC);
    assert(src.includes('<script setup>'), 'SimpleMode.vue 不是 <script setup>');
    assert(!/export\s+default\s*\{/.test(codeOnly(src)), 'SimpleMode.vue 里出现了 Options API 的 export default');
    return 'ok';
  });

  check('a2 四个步骤 / 四个动作的 data-testid 都是字面量（挂载后验得到）', () => {
    const src = read(SFC);
    const need = [
      'simple-mode', 'simple-status', 'simple-close',
      'simple-step-1', 'simple-step-2', 'simple-step-3', 'simple-step-4',
      'simple-action-1', 'simple-action-2', 'simple-action-3', 'simple-action-4',
    ];
    const miss = need.filter((t) => !src.includes(`data-testid="${t}"`));
    assert(!miss.length, `缺 testid：${miss.join(' / ')}`);
    // 必须是字面量（源码闸门要能直接读到），不许拼出来
    assert(!/data-testid="simple-(step|action)-['"`]\s*\+/.test(src), 'testid 不许用字符串拼接生成');
    return `${need.length} 个`;
  });

  check('a3 「切换到完整模式」= emit(close)，且写明同一个 .sitian', () => {
    const src = read(SFC);
    assert(/defineEmits\(\s*\[[^\]]*'close'/.test(src), "defineEmits 里没有 'close'");
    assert(/emit\(\s*'close'\s*\)/.test(src), "没有 emit('close')（按钮会是死的）");
    assert(src.includes('.sitian'), '没有向用户说明"数据是同一个 .sitian 文件"');
    assert(/emit\(\s*'enter-scenario'/.test(src), "没有 emit('enter-scenario')（画省份 / 导出 PNG 交不回剧本编辑器）");
    return 'ok';
  });

  check('a4 只读态复用 store.isReadOnly / store.readOnlyReason（不自己造一套判断）', () => {
    const src = codeOnly(read(SFC));
    assert(/store\.isReadOnly/.test(src), '没有读 store.isReadOnly');
    assert(/store\.readOnlyReason/.test(src), '没有读 store.readOnlyReason');
    assert(!/writeMode\s*===/.test(src), '自己判断写模式了（应只读 store.isReadOnly）');
    return 'ok';
  });

  // ── b) 只调用真实存在的 store 能力 ─────────────────────────────────────
  check('b1 简易模式调用的每个 store.xxx 都是既有能力', () => {
    const resolve = buildStoreIndex();
    const calls = callsOf(codeOnly(read(SFC)), 'store');
    assert(calls.length >= 3, `几乎没有调用 store（找到 ${calls.length} 个）—— 状态/动作应该来自 store`);
    const unknown = [];
    const hit = [];
    for (const name of calls) {
      const from = resolve(name);
      if (from) hit.push(`${name} ← ${from}`);
      else unknown.push(name);
    }
    assert(!unknown.length, `调用了 store 上不存在的动作：${unknown.join(', ')}`);
    // 四个动作各自必须真的落到既有能力上（名字改写时这里先红）
    for (const must of ['generateLandmass', 'importFromScenariosJson', 'addBaseMap']) {
      assert(calls.includes(must), `没有复用既有能力：store.${must}(…) 不见了`);
    }
    // 光"模块里有这个 function"不够 —— 装配进 store 的出口必须是同一个模块（漏了 spread = 画布上没有它）
    const geo = codeOnly(read(GEO));
    for (const spread of ['...scenarioEditingModule', '...provinceEditingModule']) {
      assert(geo.includes(spread), `geodata.js 没有 ${spread}（模块能力没装配进 store）`);
    }
    return hit.join('；');
  });

  check('b2 新建 / 打开项目走 projectStore 的既有动作（与项目面板同一条）', () => {
    const src = codeOnly(read(SFC));
    assert(/from\s+['"][^'"]*store\/projectStore['"]/.test(src) || /useProjectStore/.test(src),
      '没有接 projectStore（第①步就没法真的新建 / 打开项目）');
    const calls = callsOf(src, 'proj');
    const surface = surfaceNames(PSTORE);
    const fns = declaredFunctions(read(PSTORE));
    const unknown = calls.filter((n) => !surface.has(n) && !fns.has(n));
    assert(!unknown.length, `projectStore 上没有这些动作：${unknown.join(', ')}`);
    for (const must of ['createProject', 'openProject']) {
      assert(calls.includes(must), `没有复用 projectStore.${must}(…)`);
    }
    return calls.join(' / ');
  });

  check('b3 不自己造几何 / 落库：不出现"第二套"解析或导出的实现', () => {
    const src = codeOnly(read(SFC));
    // .map 的解析必须是共用件（azgaar-parser），不许在组件里手搓
    assert(/from\s+['"][^'"]*utils\/azgaar-parser['"]/.test(src),
      '没有复用 utils/azgaar-parser（.map 解析的唯一实现）');
    assert(!/JSON\.parse\(\s*text\s*\)/.test(src), '自己在组件里解析 .map 文本了（应走 parseMapFile）');
    // 导出 PNG 不许在这里实现（它依赖 ScenarioMap 的 canvas/timeline）
    assert(!/toDataURL|createObjectURL|rasterizeSvg/.test(src),
      '组件里出现了导出位图的实现（导出只能在剧本编辑器那边，不能复制一份）');
    return 'ok';
  });

  // ── c) 零数据分叉 ─────────────────────────────────────────────────────
  check('c1 不碰持久化：无 window.sitianAPI / ipcRenderer / localStorage.setItem', () => {
    const src = codeOnly(read(SFC));
    const bad = [];
    if (/window\.sitianAPI/.test(src)) bad.push('window.sitianAPI');
    if (/\bipcRenderer\b/.test(src)) bad.push('ipcRenderer');
    if (/localStorage\.setItem/.test(src)) bad.push('localStorage.setItem');
    if (/sessionStorage\.setItem/.test(src)) bad.push('sessionStorage.setItem');
    if (/from\s+['"]electron['"]/.test(src)) bad.push("import … from 'electron'");
    assert(!bad.length, `零数据分叉被破坏：${bad.join(' / ')}`);
    return '干净';
  });

  check('c2 不新增持久化键（localStorage / sessionStorage 读也不算"无状态"）', () => {
    const src = codeOnly(read(SFC));
    assert(!/localStorage|sessionStorage/.test(src), '出现了 Web Storage（简易模式不新增任何持久化状态）');
    return 'ok';
  });

  // ── d) App.vue 的入口与会话接线 ───────────────────────────────────────
  check('d1 App.vue 有「简易模式」按钮（可见文字）+ 面板挂在自身模板里', () => {
    const app = read(APP);
    assert(app.includes('data-testid="simple-mode-open"'), 'App.vue 缺 data-testid="simple-mode-open"');
    assert(/data-testid="simple-mode-open"[\s\S]{0,400}?>\s*简易模式\s*</.test(app),
      '入口按钮的文字不是「简易模式」（必须看得见，不能只有一个图标）');
    assert(/<simple-mode\b[\s\S]{0,200}?v-if="simpleOpen"/.test(app), '面板没有用 v-if="simpleOpen" 挂在 App 模板里');
    assert(/defineAsyncComponent\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/components\/SimpleMode\.vue['"]\s*\)\s*\)/.test(app),
      'SimpleMode 不是 defineAsyncComponent（会拖首屏）');
    return 'ok';
  });

  check('d2 不用 Teleport（本仓无头环境里 Teleport 子节点进不了 DOM）', () => {
    for (const rel of [APP, SFC]) {
      const src = codeOnly(read(rel));
      assert(!/<\s*[Tt]eleport\b/.test(src), `${rel} 里出现了 Teleport —— 面板会验不到`);
    }
    return 'ok';
  });

  check('d3 「画省份 / 导出」交回剧本编辑器：走 switchModule(scenario) 同一条入口', () => {
    const app = codeOnly(read(APP));
    assert(/function\s+handleSimpleEnterScenario/.test(app), 'App.vue 没有接 enter-scenario');
    const fn = app.slice(app.indexOf('async function handleSimpleEnterScenario'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert(/switchModule\(\s*'scenario'\s*\)/.test(body),
      "handleSimpleEnterScenario 没有走 switchModule('scenario')（那是顶部「历史剧本」的同一条调用）");
    assert(!/window\.sitianAPI/.test(body), '这一跳里直接调了 sitianAPI（应只经既有入口）');
    return 'ok';
  });

  check('d4 App.vue 仍然不 import projectStore（组件层才连它）', () => {
    const app = codeOnly(read(APP));
    assert(!/from\s+['"][^'"]*projectStore['"]/.test(app) && !/import\s*\(\s*['"][^'"]*projectStore['"]\s*\)/.test(app),
      'App.vue 直接 import 了 projectStore（test_46 / test_55 的口径，勿在 App 里直连）');
    return 'ok';
  });

  // ── 汇总 ─────────────────────────────────────────────────────────────
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n=== ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed ? 1 : 0);
}

main();
