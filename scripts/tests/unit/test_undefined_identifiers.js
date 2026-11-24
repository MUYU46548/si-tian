#!/usr/bin/env node
/**
 * Node 单元测试：**引用未声明标识符** 静态守卫（全仓渲染层 / 主进程 / preload）
 *
 * 为什么必须有这一层：
 *   0.2.3 用户实测崩溃 —— `ScenarioMap.vue` 的 `onUnmounted` 里留着一句从格点模型（P2 前）
 *   时代残留下来的 `if (provinceGridTimer) …`，而那个变量**全仓从未声明**。
 *   打包（vite + rollup + esbuild）**不会**因此报错：未声明标识符在 JS 里是合法的
 *   “运行时去全局找”，只有真跑到那一行才抛 `ReferenceError`。于是：
 *     · `npm run build` 成功；
 *     · 92 个 CDP 用例全绿（它们不进剧本视图、也不触发卸载）；
 *     · 用户一点“历史剧本”→ 退出/切换视图 → 卸载钩子抛错。
 *   vs 本仓其它静态守卫（test_47/54/59/71…）都是“查某个字符串在不在”，**结构性地抓不到这类问题**。
 *
 * 🔴 2026-11-24 第二课 —— **“文件里声明过”不等于“这里看得见”**：
 *   0.5.1 用户实测里同时炸了两处 `ReferenceError`，而本守卫当时是**全绿**的：
 *     ① `SystemDetailView.vue` 的 `drawPlanets` 读 `planetCount`，而那个名字只在
 *        `planetLayouts` 这个 **computed 的回调内部** `const` 过 → 文件里声明过（旧的判据放过），
 *        但 `drawPlanets` 里根本看不见它 → 1~2 颗行星的系一画名字就崩。
 *     ② `planetDrawing.js` 有 4 个 Azgaar 图层函数被**落在 `createPlanetDrawing` 工厂外面**
 *        （`return {…}` 之后），而它们都要 `getState()` —— 工厂参数只在工厂体内可见
 *        → 底图一带 Azgaar 数据，行星图一帧就崩。
 *   两处都不是“全仓没声明”，而是**作用域不对**。所以判据从“文件级集合”升级为
 *   **词法作用域链**：一个引用必须能在**它所在的作用域链**上找到绑定，否则报错。
 *
 * 判据：文件里出现的**引用位置**标识符，必须能被以下之一解释 ——
 *   ① 沿**作用域链**能找到声明（const/let/var/function/class/import/参数/catch/解构）；
 *      · `var` 与函数声明按最近的**函数/程序**作用域提升（Annex B 那种块内函数声明也向上放宽，
 *        “宁可漏报不可误报”这条线不动）；
 *      · `let/const/class` 按最近**块**作用域；
 *   ② 在全局白名单里（浏览器 / Node / Vue 编译器宏）。
 * 剩下的一律报错并给出 文件:行:列 + 名字（按名字聚合，一个名字一行）。
 *
 * ⚠️ 已知的、**有意不查**的边界（写在前面，避免被当成“全查了”）：
 *   · 不查 `<template>` 里的表达式（模板编译器管，且历次崩溃不在模板侧）；
 *   · 不查作用域时序（`TDZ`：`console.log(x); let x = 1` 本守卫看不见 —— 先声明后使用不判）；
 *   · **不查“声明形态里的默认值表达式”**（`const { a = b } = c`、`function f(x = y) {}` 里的 `b` / `y`
 *     不会被当成引用）。只影响检出率，不会造成误报；
 *   · 不查 `scripts/` 下的工具脚本（它们跑不起来会当场报错，不缺这层保护）。
 *
 * 用法：node scripts/tests/unit/test_undefined_identifiers.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ===== 被测范围 =====
const TARGET_DIRS = [
  path.join(ROOT, 'src', 'renderer', 'src'),
  path.join(ROOT, 'src', 'main'),
  path.join(ROOT, 'src', 'preload'),
];

// ===== 全局白名单（出现新的真全局就往这里加，并写清它从哪来）=====
const GLOBALS = new Set([
  // 语言内置
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments', 'eval',
  'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError',
  'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON', 'Promise',
  'Reflect', 'Proxy', 'Intl', 'WeakMap', 'WeakSet', 'Map', 'Set', 'WeakRef',
  'FinalizationRegistry', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
  // 浏览器 / 渲染层
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch', 'Request',
  'Response', 'Headers', 'AbortController', 'AbortSignal', 'FormData', 'Blob',
  'File', 'FileReader', 'FileList', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'DOMParser', 'XMLSerializer', 'Image', 'ImageData', 'Path2D',
  'OffscreenCanvas', 'createImageBitmap', 'Event', 'CustomEvent', 'MouseEvent',
  'PointerEvent', 'KeyboardEvent', 'WheelEvent', 'TouchEvent', 'DragEvent',
  'ClipboardEvent', 'FocusEvent', 'InputEvent', 'UIEvent', 'ProgressEvent',
  'HTMLElement', 'HTMLCanvasElement', 'HTMLInputElement', 'HTMLDivElement',
  'Element', 'Node', 'NodeList', 'DocumentFragment', 'Selection', 'Range',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver',
  'getComputedStyle', 'matchMedia', 'devicePixelRatio', 'innerWidth', 'innerHeight',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'atob', 'btoa',
  'alert', 'confirm', 'prompt', 'print', 'scrollTo', 'scrollBy', 'open', 'close',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'postMessage',
  'performance', 'crypto', 'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort',
  'self',   // Web Worker 里的全局（src/renderer/src/workers/*.js 用 `self.onmessage`）
  'BroadcastChannel', 'WebSocket', 'EventSource', 'Notification', 'Audio', 'AudioContext',
  'SVGElement', 'CSS', 'DOMMatrix', 'DOMRect', 'FontFace', 'speechSynthesis',
  // Node / 主进程（CommonJS 包装器提供的）
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer',
  'setImmediate', 'clearImmediate', 'global', 'URLPattern',
  // Vue 编译器宏（`<script setup>` 由 @vitejs/plugin-vue 处理，不是运行时函数）
  'defineProps', 'defineEmits', 'defineExpose', 'defineOptions', 'defineSlots',
  'defineModel', 'withDefaults', 'useSlots', 'useAttrs',
]);

// ===== 结果收集 =====
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

// ===== 解析器 =====
function loadParser() {
  try {
    return require('@babel/parser');
  } catch (err) {
    return null;
  }
}

const PARSE_OPTS = {
  sourceType: 'unambiguous',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  allowNewTargetOutsideFunction: true,
  errorRecovery: false,
  plugins: ['topLevelAwait', 'importMeta', 'dynamicImport', 'classProperties',
    'classPrivateProperties', 'classPrivateMethods', 'objectRestSpread',
    'optionalChaining', 'nullishCoalescingOperator', 'numericSeparator', 'bigInt'],
};

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments']);

// ===== 作用域模型 =====
// kind: 'program' | 'function' | 'block' | 'catch'
function makeScope(kind, parent) {
  return { kind, parent, names: new Set() };
}

/** `var` 与函数声明要挂到最近的**函数/程序**作用域（提升） */
function hoistScope(scope) {
  let s = scope;
  while (s.parent && s.kind !== 'function' && s.kind !== 'program') s = s.parent;
  return s;
}

function rootScope(scope) {
  let s = scope;
  while (s.parent) s = s.parent;
  return s;
}

/** 把“绑定形态”里的所有标识符挂进 scope（解构 / 默认值 / rest 都覆盖） */
function declarePattern(node, scope) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Identifier': scope.names.add(node.name); return;
    case 'ObjectPattern':
      for (const p of node.properties || []) declarePattern(p, scope);
      return;
    case 'ObjectProperty': declarePattern(node.value, scope); return;
    case 'RestElement': declarePattern(node.argument, scope); return;
    case 'ArrayPattern':
      for (const el of node.elements || []) declarePattern(el, scope);
      return;
    case 'AssignmentPattern': declarePattern(node.left, scope); return;
    default: return;   // 其它（MemberExpression 等）不是绑定形态，忽略
  }
}

/** 沿作用域链找绑定 */
function resolves(scope, name) {
  let s = scope;
  while (s) {
    if (s.names.has(name)) return true;
    s = s.parent;
  }
  return false;
}

const FUNCTION_LIKE = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ClassMethod', 'ClassPrivateMethod', 'ObjectMethod',
]);

/**
 * 判断一个 Identifier 节点在**语法位置上**是不是一次“引用”。
 * 返回 false = 它是键 / 标签 / 声明位（不是引用）。
 */
function isReference(node, parent, grand) {
  if (!parent) return false;
  switch (parent.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      if (parent.property === node && !parent.computed) return false;   // a.b 里的 b
      break;
    case 'ObjectProperty':
    case 'ObjectMethod':
      if (parent.key === node && !parent.computed && !parent.shorthand) return false;   // {a: 1} 里的 a
      break;
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ClassProperty':
    case 'ClassPrivateProperty':
      if (parent.key === node && !parent.computed) return false;
      break;
    case 'ImportSpecifier':
      if (parent.imported === node && !parent.shorthand) return false;   // import { a as b }
      return false;                                                       // imported/local 都是绑定位
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return false;
    case 'ExportSpecifier':
      // 🔴 `export { a, b } from './x'` 是**再导出**：`local` 指向的是那个模块的绑定，
      //    不是本文件的绑定（漏判会把 `export { formatDate } from './scenarioDates'` 报成未声明）。
      //    `source` 在**祖父**节点（ExportNamedDeclaration）上，父节点是 ExportSpecifier 自身。
      if (grand && grand.source) return false;
      if (parent.exported === node && parent.exported !== parent.local) return false;
      break;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      if (parent.label === node) return false;
      break;
    case 'MetaProperty':
      return false;                                                       // import.meta / new.target
    case 'VariableDeclarator':
      if (parent.id === node) return false;                               // 声明位（兜底）
      break;
    case 'CatchClause':
      if (parent.param === node) return false;
      break;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (parent.id === node) return false;
      break;
    default: break;
  }
  return true;
}

/**
 * 一个 JS 源码文本 → 按**作用域链**判未声明标识符。
 * refs 只记 `{ name, line, col, scope }`，等整棵树走完、作用域全部填好后再统一裁决
 * —— 这样“先使用后声明”（提升语义）天然成立，不必做两遍。
 */
function analyze(parser, code, label, lineOffset, findings, seedNames) {
  let ast;
  try {
    ast = parser.parse(code, PARSE_OPTS);
  } catch (err) {
    findings.push({ file: label, line: lineOffset + (err.loc ? err.loc.line : 0), col: (err.loc && err.loc.column) || 0, name: '<语法错误>：' + String(err.message).split('\n')[0] });
    return;
  }

  const program = makeScope('program', null);
  for (const n of seedNames || []) program.names.add(n);
  const refs = [];

  function recordRef(node, scope, parent, grand) {
    if (!isReference(node, parent, grand)) return;
    refs.push({
      name: node.name,
      line: lineOffset + ((node.loc && node.loc.start.line) || 0),
      col: ((node.loc && node.loc.start.column) || 0) + 1,
      scope,
    });
  }

  function visit(node, scope, parent, grand) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope, parent, grand);
      return;
    }
    if (typeof node.type !== 'string') return;

    // ---- 引用位置 ----
    if (node.type === 'Identifier') { recordRef(node, scope, parent, grand); return; }

    // ---- 作用域边界（这几类要显式建域，并且只把该进的身位下钻进去）----
    if (FUNCTION_LIKE.has(node.type)) {
      // 函数名声明在**外层**（函数声明）/ 自身（函数表达式）；箭头函数没有名字
      if (node.type === 'FunctionDeclaration' && node.id) scope.names.add(node.id.name);
      else if (node.type === 'FunctionExpression' && node.id) scope.names.add(node.id.name);
      const fn = makeScope('function', scope);
      for (const p of node.params || []) declarePattern(p, fn);
      if (node.body) {
        if (node.body.type === 'BlockStatement') {
          // 函数体的**顶层**不再另起一块（参数与 body 顶层同域）
          for (const stmt of node.body.body || []) visit(stmt, fn, node.body, node);
        } else {
          visit(node.body, fn, node, parent);   // 箭头函数表达式体
        }
      }
      return;
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      let cs;
      if (node.type === 'ClassDeclaration') {
        if (node.id) scope.names.add(node.id.name);
        cs = makeScope('block', scope);          // 类体自带一层（方法名不外泄）
      } else {
        cs = makeScope('block', scope);
        if (node.id) cs.names.add(node.id.name); // 类表达式的名字只在自身体内可见
      }
      if (node.superClass) visit(node.superClass, scope, node, parent);
      visit(node.body, cs, node, parent);
      return;
    }

    if (node.type === 'BlockStatement') {
      const bs = makeScope('block', scope);
      for (const stmt of node.body || []) visit(stmt, bs, node, parent);
      return;
    }

    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const fs = makeScope('block', scope);   // `for (let i…)` 的 i 不许漏到循环外
      for (const key of ['init', 'left', 'right', 'test', 'update']) {
        if (node[key]) visit(node[key], fs, node, parent);
      }
      visit(node.body, fs, node, parent);
      return;
    }

    if (node.type === 'SwitchStatement') {
      visit(node.discriminant, scope, node, parent);
      const ss = makeScope('block', scope);   // 所有 case 共用一个块域
      for (const c of node.cases || []) visit(c, ss, node, parent);
      return;
    }

    if (node.type === 'CatchClause') {
      const cs = makeScope('catch', scope);
      if (node.param) declarePattern(node.param, cs);
      visit(node.body, cs, node, parent);
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const target = node.kind === 'var' ? hoistScope(scope) : scope;
      for (const d of node.declarations || []) {
        if (d && d.id) declarePattern(d.id, target);
        if (d && d.init) visit(d.init, scope, d, node);
      }
      return;   // id 已在 declarePattern 里处理，不许再当引用
    }

    if (node.type === 'ImportDeclaration') {
      const root = rootScope(scope);
      for (const sp of node.specifiers || []) if (sp.local) root.names.add(sp.local.name);
      return;
    }

    // ---- 普通节点：继续下钻 ----
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (child && typeof child === 'object') visit(child, scope, node, parent);
    }
  }

  visit(ast, program, null, null);

  // ---- 统一裁决（此时作用域已全部填好）----
  for (const r of refs) {
    if (GLOBALS.has(r.name)) continue;
    if (resolves(r.scope, r.name)) continue;
    findings.push({ file: label, line: r.line, col: r.col, name: r.name });
  }
}

/** 取一个文件里**所有 `<script>` 块**的“程序顶层声明名”（`<script>` 与 `<script setup>` 是合并编译的） */
function topLevelNames(parser, blocks) {
  const out = [];
  for (const blk of blocks) {
    let ast;
    try { ast = parser.parse(blk.code, PARSE_OPTS); } catch (_) { continue; }
    for (const stmt of ast.program.body || []) {
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations || []) {
          const names = new Set();
          declarePattern(d.id, { names });
          for (const n of names) out.push(n);
        }
      } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id) {
        out.push(stmt.id.name);
      } else if (stmt.type === 'ImportDeclaration') {
        for (const sp of stmt.specifiers || []) if (sp.local) out.push(sp.local.name);
      }
    }
  }
  return out;
}

/** 取 .vue 里的所有 `<script>` 块（`<script setup>` / `<script>`），带行偏移 */
function scriptBlocks(source) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(source))) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;      // 外链脚本没有内联代码
    const before = source.slice(0, m.index);
    const lineOffset = before.split('\n').length - 1;
    out.push({ code: m[2], lineOffset });
  }
  return out;
}

function listFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (/\.(js|mjs|vue)$/.test(e.name)) out.push(full);
  }
  return out;
}

function scanRepo(parser) {
  const findings = [];
  const files = [];
  for (const d of TARGET_DIRS) listFiles(d, files);
  files.sort();
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.vue')) {
      const blocks = scriptBlocks(src);
      // `<script>` 与 `<script setup>` 合并编译：顶层名字两边互相可见，所以先取并集当种子
      const seed = topLevelNames(parser, blocks);
      for (const blk of blocks) analyze(parser, blk.code, rel, blk.lineOffset, findings, seed);
    } else {
      analyze(parser, src, rel, 0, findings);
    }
  }
  return { findings, scanned: files.length };
}

// ===== 主流程 =====
function main() {
  const parser = loadParser();

  check('解析器可用（@babel/parser）', () => {
    assert(parser, '找不到 @babel/parser —— 本守卫的判据依赖它（它是 @vue/compiler-sfc 的硬依赖）');
    return 'ok';
  });

  if (!parser) { report(); return; }

  // ---- 自证：守卫本身必须先被证明能抓到问题（反向探针）----
  check('反向探针 A：未声明标识符必须被报出', () => {
    const f = [];
    analyze(parser, 'function a(){ if (neverDeclaredTimer) clearTimeout(neverDeclaredTimer); }', '<probe>', 0, f);
    // 同一名字的两处引用都要报（引用位置各算一条，报告时按名字聚合）
    assert(f.length === 2, `期望 2 条（同一个名字两处引用），实际 ${f.length} 条：${JSON.stringify(f)}`);
    assert(f.every((x) => x.name === 'neverDeclaredTimer'), `期望全报 neverDeclaredTimer，实际 ${JSON.stringify(f)}`);
    return '2 处引用、名字正确';
  });

  check('反向探针 B：合法写法不许误报（属性名 / 解构 / 标签 / import / 简写）', () => {
    const code = [
      "import { ref as r2 } from 'vue';",
      "const b = 1;",
      "const c = { a: 1, b };",                      // b 是简写 → 引用（已声明）；a 是键 → 不是
      "const { x, y: yy = 2, ...rest } = c;",
      "outer: for (const k of []) { if (k) break outer; }",
      "function f(p = 1, ...ps) { return p + ps.length + x + yy + rest.a + b + r2 + window.innerWidth + Math.max(1, 2); }",
      "export { f };",
      "export { formatDate } from './nowhere';",      // 再导出：local 不是本文件绑定
      "const obj = { async set({ host = '', username = '' } = {}) { return host + username; }, get(target, key) { return target[key]; } };",
      "class C { constructor(opts = {}) { this.o = opts; } paint(grid, gridWidth) { return grid + gridWidth + this.o; } }",
      "export { obj, C };",
    ].join('\n');
    const f = [];
    analyze(parser, code, '<probe>', 0, f);
    assert(f.length === 0, `误报 ${f.length} 条：${JSON.stringify(f)}`);
    return '0 条误报';
  });

  // 🔴 2026-11-24：这两条就是 0.5.1 用户实测的两个崩溃形状 —— 旧的“文件级集合”判据两条全放过。
  check('反向探针 C：兄弟函数读不到别人的局部 const 必须被报（0.5.1 planetCount 形状）', () => {
    const code = [
      "import { computed } from 'vue';",
      "const layouts = computed(() => {",
      "  const planetCount = 2;",                       // 只在 computed 回调里
      "  return new Array(planetCount);",
      "});",
      "function drawPlanets() { return planetCount < 3 ? 1 : 2; }",   // 这里看不见
    ].join('\n');
    const f = [];
    analyze(parser, code, '<probe>', 0, f);
    assert(f.some((x) => x.name === 'planetCount'), `期望报 planetCount，实际 ${JSON.stringify(f)}`);
    assert(f.length === 1, `期望恰好 1 条，实际 ${f.length} 条：${JSON.stringify(f)}`);
    return '报出 planetCount';
  });

  check('反向探针 D：工厂参数不许在工厂外被引用（0.5.1 getState 形状）', () => {
    const code = [
      "export function createDrawing(getState) {",
      "  function inside() { return getState().zoom; }",
      "  return { inside };",
      "}",
      "function outside() { return getState().zoom; }",   // 工厂外：getState 不存在
    ].join('\n');
    const f = [];
    analyze(parser, code, '<probe>', 0, f);
    assert(f.length === 1, `期望 1 条，实际 ${f.length} 条：${JSON.stringify(f)}`);
    assert(f[0].name === 'getState', `期望报 getState，实际 ${f[0].name}`);
    return '报出 getState（工厂内的那条不许报）';
  });

  check('反向探针 E：合法作用域不许误报（参数 / 闭包 / var 提升 / 块域 / 循环 / catch / 方法）', () => {
    const code = [
      "function outer(a) {",
      "  let i = 0;",
      "  { let blockOnly = 1; i += blockOnly; }",        // 块级 let 在块内可见
      "  for (let k = 0; k < 2; k++) { i += k; }",       // 循环变量在循环内可见
      "  for (var v = 0; v < 2; v++) { i += v; }",
      "  i += v;",                                        // var 提升到函数域 → 可见
      "  try { i += 1; } catch (e) { i += e ? 1 : 0; }",  // catch 参数在其体内可见
      "  const inner = function named() { return named; };",   // 函数表达式的名字在自身内可见
      "  const arrow = () => a + i + helper(1);",              // 闭包 + 顶层函数
      "  class K { m(p) { return p + i; } }",
      "  const obj = { m(p) { return p + i; }, get g() { return i; } };",
      "  return inner() + arrow() + new K().m(1) + obj.m(1) + obj.g;",
      "}",
      "function helper(n) { return n; }",
      "const spread = { ...{ z: 1 } };",
      "const arr = [1, ...[]];",
      "const fn = ({ q, w: ww = 2 }) => q + ww + spread.z + arr.length;",
      "export { outer, fn };",
    ].join('\n');
    const f = [];
    analyze(parser, code, '<probe>', 0, f);
    assert(f.length === 0, `误报 ${f.length} 条：${JSON.stringify(f)}`);
    return '0 条误报';
  });

  // Annex B 的刻意放宽：`{ function hoisted(){} }` 这种**块内函数声明**，浏览器会按 var 语义
  // 提到函数/程序域。真正的规范语义是“提到块顶、现代引擎另做 Annex B 提升”，
  // 这里选择**不放宽也不硬判**——按块域处理，块外引用就报。写清楚，免得以后被当成误报改回去。
  check('反向探针 E2：块内函数声明出块引用必须被报（Annex B 不伪造放宽）', () => {
    const code = [
      "function outer() {",
      "  { function hoisted() { return 1; } }",
      "  return hoisted();",          // 块外：严格模式/模块下确实不可见
      "}",
    ].join('\n');
    const f = [];
    analyze(parser, code, '<probe>', 0, f);
    assert(f.length === 1 && f[0].name === 'hoisted', `期望报 hoisted，实际 ${JSON.stringify(f)}`);
    return '报出 hoisted';
  });

  check('反向探针 F：shadowing 与 for-let 出域必须被区分', () => {
    const ok = "function a(x) { { let x = 1; return x; } }";           // 内层遮挡，合法
    const bad = "function b() { for (let k = 0; k < 1; k++) {} return k; }";  // k 出域
    const f1 = []; analyze(parser, ok, '<probe-ok>', 0, f1);
    assert(f1.length === 0, `遮挡写法被误报：${JSON.stringify(f1)}`);
    const f2 = []; analyze(parser, bad, '<probe-bad>', 0, f2);
    assert(f2.length === 1 && f2[0].name === 'k', `for-let 出域未报：${JSON.stringify(f2)}`);
    return '遮挡 0 误报 / for-let 出域报出';
  });

  // ---- 真扫全仓 ----
  let scan = { findings: [], scanned: 0 };
  try {
    scan = scanRepo(parser);
  } catch (err) {
    scan = { findings: [{ file: '<扫描失败>', line: 0, col: 0, name: String((err && err.message) || err) }], scanned: 0 };
  }

  check(`全仓扫描：${scan.scanned} 个文件里没有“引用未声明标识符”`, () => {
    const f = scan.findings;
    if (!f.length) return `${scan.scanned} 个文件 / 0 条`;
    // 按名字聚合，一个名字一行（同名的多处引用只报第一处 + 计数）
    const byName = new Map();
    for (const it of f) {
      const key = it.name;
      if (!byName.has(key)) byName.set(key, { first: it, count: 0 });
      byName.get(key).count++;
    }
    const lines = [...byName.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([name, v]) =>
        `  · ${name}  ← ${v.first.file}:${v.first.line}:${v.first.col}${v.count > 1 ? `（共 ${v.count} 处）` : ''}`)
      .join('\n');
    throw new Error(`发现 ${byName.size} 个未声明标识符：\n${lines}`);
  });

  report();
}

function report() {
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main();
