#!/usr/bin/env node
/**
 * Node 单元测试：**引用未声明标识符** 静态守卫（全仓渲染层 / 主进程 / preload）
 *
 * 为什么必须有这一层：
 *   0.2.3 用户实测崩溃 —— `ScenarioMap.vue` 的 `onUnmounted` 里留着一句从格点模型（P2 前）
 *   时代残留下来的 `if (provinceGridTimer) …`，而那个变量**全仓从未声明**。
 *   打包（vite + rollup + esbuild）**不会**因此报错：未声明标识符在 JS 里是合法的
 *   「运行时去全局找」，只有真跑到那一行才抛 `ReferenceError`。于是：
 *     · `npm run build` 成功；
 *     · 92 个 CDP 用例全绿（它们不进剧本视图、也不触发卸载）；
 *     · 用户一点「历史剧本」→ 退出/切换视图 → 卸载钩子抛错。
 *   vs 本仓其它静态守卫（test_47/54/59/71…）都是"查某个字符串在不在"，**结构性地抓不到这类问题**。
 *
 * 判据：文件里出现的**引用位置**标识符，必须能被以下之一解释 ——
 *   ① 本文件里声明过（const/let/var/function/class/import/参数/catch/解构，**不区分作用域嵌套**，
 *      这是「宁可漏报不可误报」的刻意放宽：只要文件里任何地方声明过就不报）；
 *   ② 在全局白名单里（浏览器 / Node / Vue 编译器宏）。
 * 剩下的一律报错并给出 文件:行:列 + 名字（按名字聚合，一个名字一行）。
 *
 * ⚠️ 已知的、**有意不查**的边界（写在前面，避免被当成"全查了"）：
 *   · 不查 `<template>` 里的表达式（模板编译器管，且本轮崩溃不在模板侧）；
 *   · 不查作用域时序（`TDZ`：`console.log(x); let x = 1` 本守卫看不见）；
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

/** 递归遍历 AST（只看对象/数组，带 parent / grandparent，用于「父节点的父节点」判据） */
function walk(node, parent, cb, grand) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, parent, cb, grand);
    return;
  }
  if (typeof node.type !== 'string') return;
  cb(node, parent, grand);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const child = node[key];
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) {
        for (const c of child) { if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, node, cb, parent); }
      } else if (typeof child.type === 'string') {
        walk(child, node, cb, parent);
      }
    }
  }
}

/** 把「绑定形态」里的所有标识符塞进 out（解构 / 默认值 / rest 都覆盖） */
function collectPattern(node, out) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); return;
    case 'ObjectPattern':
      for (const p of node.properties || []) collectPattern(p, out);
      return;
    case 'ObjectProperty': collectPattern(node.value, out); return;
    case 'RestElement': collectPattern(node.argument, out); return;
    case 'ArrayPattern':
      for (const el of node.elements || []) collectPattern(el, out);
      return;
    case 'AssignmentPattern': collectPattern(node.left, out); return;
    default: return;   // 其它（MemberExpression 等）不是绑定形态，忽略
  }
}

/** 一个 JS 源码文本 → { declared:Set, used:Map<name, {line,col}> } */
function analyze(parser, code, label, lineOffset, findings) {
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: false,
      plugins: ['topLevelAwait', 'importMeta', 'dynamicImport', 'classProperties',
        'classPrivateProperties', 'classPrivateMethods', 'objectRestSpread',
        'optionalChaining', 'nullishCoalescingOperator', 'numericSeparator', 'bigInt'],
    });
  } catch (err) {
    findings.push({ file: label, line: lineOffset + (err.loc ? err.loc.line : 0), col: (err.loc && err.loc.column) || 0, name: '<语法错误>：' + String(err.message).split('\n')[0] });
    return;
  }

  const declared = new Set();
  const used = new Map();

  // ---- ① 先收绑定 ----
  walk(ast, null, (node) => {
    switch (node.type) {
      case 'VariableDeclarator': collectPattern(node.id, declared); break;
      // 🔴 类的**方法**与**对象字面量的方法**（`{ async set({host}) {} }`、`class A { paint(grid) {} }`）
      //    也是函数：漏掉它们的 `params` 会把每一个方法参数都报成"未声明"（首版实测 30+ 条误报）
      case 'ClassMethod':
      case 'ClassPrivateMethod':
      case 'ObjectMethod':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) collectPattern(node.id, declared);
        for (const p of node.params || []) collectPattern(p, declared);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) collectPattern(node.id, declared);
        break;
      case 'CatchClause':
        if (node.param) collectPattern(node.param, declared);
        break;
      case 'ImportDeclaration':
        for (const s of node.specifiers || []) if (s.local) declared.add(s.local.name);
        break;
      default: break;
    }
  });

  // ---- ② 再收引用 ----
  walk(ast, null, (node, parent, grand) => {
    if (node.type !== 'Identifier') return;
    const name = node.name;
    if (!parent) return;
    switch (parent.type) {
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (parent.property === node && !parent.computed) return;   // a.b 里的 b
        break;
      case 'ObjectProperty':
      case 'ObjectMethod':
        if (parent.key === node && !parent.computed && !parent.shorthand) return;   // {a: 1} 里的 a
        break;
      case 'ClassMethod':
      case 'ClassPrivateMethod':
      case 'ClassProperty':
      case 'ClassPrivateProperty':
        if (parent.key === node && !parent.computed) return;
        break;
      case 'ImportSpecifier':
        if (parent.imported === node && !parent.shorthand) return;   // import { a as b }
        return;                                                       // imported/local 都是绑定位
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        return;
      case 'ExportSpecifier':
        // 🔴 `export { a, b } from './x'` 是**再导出**：`local` 指向的是那个模块的绑定，
        //    不是本文件的绑定（漏判会把 `export { formatDate } from './scenarioDates'` 报成未声明）。
        //    `source` 在**祖父**节点（ExportNamedDeclaration）上，父节点是 ExportSpecifier 自身。
        if (grand && grand.source) return;
        if (parent.exported === node && parent.exported !== parent.local) return;
        break;
      case 'LabeledStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        if (parent.label === node) return;
        break;
      case 'MetaProperty':
        return;                                                       // import.meta / new.target
      default: break;
    }
    if (!used.has(name)) {
      used.set(name, { line: lineOffset + ((node.loc && node.loc.start.line) || 0), col: ((node.loc && node.loc.start.column) || 0) + 1 });
    }
  });

  for (const [name, at] of used) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    findings.push({ file: label, line: at.line, col: at.col, name });
  }
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
      for (const blk of scriptBlocks(src)) analyze(parser, blk.code, rel, blk.lineOffset, findings);
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
    assert(f.length === 1, `期望 1 条，实际 ${f.length} 条：${JSON.stringify(f)}`);
    assert(f[0].name === 'neverDeclaredTimer', `期望报 neverDeclaredTimer，实际 ${f[0].name}`);
    return '1 条，名字正确';
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

  // ---- 真扫全仓 ----
  let scan = { findings: [], scanned: 0 };
  try {
    scan = scanRepo(parser);
  } catch (err) {
    scan = { findings: [{ file: '<扫描失败>', line: 0, col: 0, name: String((err && err.message) || err) }], scanned: 0 };
  }

  check(`全仓扫描：${scan.scanned} 个文件里没有「引用未声明标识符」`, () => {
    const f = scan.findings;
    if (!f.length) return `${scan.scanned} 个文件 / 0 条`;
    // 按名字聚合，一个名字一行（同名的多处引用只报第一处 + 计数）
    const byName = new Map();
    for (const it of f) {
      const key = it.name;
      if (!byName.has(key)) byName.set(key, { first: it, count: 0 });
      byName.get(key).count++;
    }
    const lines = [...byName.entries()].map(([name, v]) =>
      `  · ${name}  ← ${v.first.file}:${v.first.line}:${v.first.col}${v.count > 1 ? `（共 ${v.count} 处）` : ''}`).join('\n');
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
