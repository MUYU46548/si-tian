#!/usr/bin/env node
/**
 * Node 单元测试：`<script setup>` 里 **同一个 ref 有的地方写 `.value`、有的地方漏了** 的静态守卫
 *
 * ── 为什么必须有这一层（2026-10-14 用户实测崩溃）──────────────────────────────
 * `ScenarioMap.vue` 的「自动河流」绘制块里写的是裸 `ctx.save()` / `ctx.moveTo(...)`，
 * 而同一个文件里其它地方一律写 `ctx.value.xxx`。`ctx` 是 `const ctx = ref(null)`，
 * 在 `<script setup>` 里 **只有模板**会自动解包 ref —— 函数体里 `ctx` 就是 `{ value }`，
 * 于是 `ctx.save` 是 `undefined`：
 *   · 压缩后报 `Ce.save is not a function`（用户看到的原话）；
 *   · 它抛在 `renderFrame()` 里 → **从那一行起后面全不画**（省界/标签/小地图/势力名都没了）；
 *   · 连续 3 帧 → 渲染护栏暂停 → 用户看到「地图出不来，点什么都没反应」。
 *
 * 为什么既有守卫都没抓到：
 *   · `test_undefined_identifiers.js` 查的是「**未声明**的标识符」—— `ctx` 声明得好好的；
 *   · `npm run build` 不报错（属性访问在运行时才炸）；
 *   · 102 个 CDP 用例没有一个点过「自动河流」，那一整块**默认永远不执行**。
 *
 * ── 判据（刻意收窄，宁可漏报不可误报）────────────────────────────────────────
 * 报的是「**自相矛盾**」：同一个顶层 ref 的名字
 *   ① 在本文件里出现过 ≥2 次 `.value`（说明作者知道它要解包，不是模板 ref 那种惯用裸写）；
 *   ② **同时**又在值位置被裸用（`.方法(...)` 或 `X(...)`）；
 *   ③ 且这个裸用**不是**白名单里的"故意存元素/组件引用的 ref"（名字以 Ref 结尾等）。
 *
 * 为什么不用"所有裸 ref 都报"：本仓有 500+ 处刻意的裸 ref —— 模板 ref（`fooRef` 交给
 * `ref="fooRef"`）、Pinia store 的 ref（`store.something`）等等。全报 = 守卫当场变噪音，
 * 下场就是被人加一堆 `// eslint-disable` 式的白名单，真正的缺陷照样溜过去。
 * 收窄到"自相矛盾"这一条，**本次这个崩溃一定被抓到**，而误报面极小。
 *
 * ⚠️ 有意不查的边界（写在前面，避免被当成"全查了"）：
 *   · 不查模板里的表达式（模板本来就该裸用 ref）；
 *   · 一个文件里从没写过 `.value` 的 ref（无法与"故意裸用"区分，放过）；
 *   · 不查别名/解构得到的 ref。
 *
 * 用法：node scripts/tests/unit/test_vue_ref_unwrap_guard.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function loadParser() {
  try { return require('@babel/parser'); } catch (_) { return null; }
}

function listVue(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listVue(full, out);
    else if (e.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

/** 取 <script setup> 块（带起始行偏移）；非 setup 块返回 null */
function setupBlock(source) {
  const re = /<script\b([^>]*)>/g;
  let m;
  while ((m = re.exec(source))) {
    const attrs = m[1] || '';
    if (!/(^|\s)setup(\s|$|=)/.test(attrs)) continue;
    if (/\bsrc\s*=/.test(attrs)) return null;
    const start = re.lastIndex;
    const end = source.indexOf('</script>', start);
    if (end < 0) return null;
    return { code: source.slice(start, end), lineOffset: source.slice(0, start).split('\n').length - 1 };
  }
  return null;
}

function declarePattern(node, scope) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Identifier': scope.add(node.name); return;
    case 'ObjectPattern': for (const p of node.properties || []) declarePattern(p, scope); return;
    case 'ObjectProperty': declarePattern(node.value, scope); return;
    case 'RestElement': declarePattern(node.argument, scope); return;
    case 'ArrayPattern': for (const el of node.elements || []) declarePattern(el, scope); return;
    case 'AssignmentPattern': declarePattern(node.left, scope); return;
    default: return;
  }
}

function eachChild(node, cb) {
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const c = node[k];
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c)) { for (const x of c) if (x && typeof x.type === 'string') cb(x); }
    else if (typeof c.type === 'string') cb(c);
  }
}

/** 名字像"故意存元素/组件引用的 ref"→ 白名单（这些裸用是**正确**用法） */
function looksLikeTemplateRef(name) {
  return /Ref$/.test(name) || /^_?el[A-Z]/.test(name);
}

/** 一个 .vue 的 <script setup> → { findings, refs, valueCounts } */
function analyzeVue(parser, file, source) {
  const blk = setupBlock(source);
  if (!blk) return { findings: [], refs: 0, valueCounts: new Map() };
  let ast;
  try {
    ast = parser.parse(blk.code, {
      sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
      plugins: ['topLevelAwait', 'dynamicImport', 'optionalChaining', 'nullishCoalescingOperator',
        'objectRestSpread', 'classProperties', 'numericSeparator', 'bigInt'],
    });
  } catch (err) {
    return { findings: [{ file, line: 0, col: 0, name: '<语法错误>：' + String(err.message).split('\n')[0] }], refs: 0, valueCounts: new Map() };
  }

  // ① 顶层 ref 绑定 + `.value` 出现次数（从源码文本数，避免再走一遍 AST）
  const refNames = new Set();
  const top = new Set();
  for (const stmt of ast.program.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        declarePattern(d.id, top);
        if (!d.init || d.id.type !== 'Identifier') continue;
        const c = d.init;
        if (c.type === 'CallExpression' && c.callee.type === 'Identifier'
            && (c.callee.name === 'ref' || c.callee.name === 'shallowRef' || c.callee.name === 'computed')) {
          refNames.add(d.id.name);
        }
      }
    }
    if (stmt.type === 'FunctionDeclaration' && stmt.id) top.add(stmt.id.name);
    if (stmt.type === 'ClassDeclaration' && stmt.id) top.add(stmt.id.name);
    if (stmt.type === 'ImportDeclaration') { for (const sp of stmt.specifiers || []) if (sp.local) top.add(sp.local.name); }
  }
  if (!refNames.size) return { findings: [], refs: 0, valueCounts: new Map() };

  const valueCounts = new Map();
  for (const name of refNames) {
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.value\\b', 'g');
    valueCounts.set(name, (blk.code.match(re) || []).length);
  }

  const naked = [];                 // 值位置裸用的 ref 名（按出现位置记一次）
  const posKey = (node) => (node && node.loc ? `${node.loc.start.line}@${node.loc.start.column}` : null);

  const resolvesToTopRef = (chain, name) => {
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].has(name)) return i === 0 && refNames.has(name);
    }
    return refNames.has(name);
  };

  const visit = (node, chain) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    const cur = chain[chain.length - 1];

    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        if (node.id) cur.add(node.id.name);
        const s = new Set();
        for (const p of node.params || []) declarePattern(p, s);
        const sub = [...chain, s];
        if (node.body) visit(node.body, sub);
        return;
      }
      case 'BlockStatement': {
        const sub = [...chain, new Set()];
        for (const stmt of node.body || []) visit(stmt, sub);
        return;
      }
      case 'CatchClause': {
        const s = new Set();
        declarePattern(node.param, s);
        const sub = [...chain, s];
        if (node.body) visit(node.body, sub);
        return;
      }
      case 'VariableDeclaration': {
        for (const d of node.declarations || []) {
          declarePattern(d.id, cur);
          if (d.init) visit(d.init, chain);
        }
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.id) cur.add(node.id.name);
        const sub = [...chain, new Set()];
        if (node.superClass) visit(node.superClass, sub);
        if (node.body) visit(node.body, sub);
        return;
      }
      case 'ImportDeclaration':
        for (const sp of node.specifiers || []) if (sp.local) cur.add(sp.local.name);
        return;
      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement': {
        const sub = [...chain, new Set()];
        for (const k of ['init', 'left', 'right', 'test', 'update', 'body']) if (node[k]) visit(node[k], sub);
        return;
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        // 🔴 关键：`X.value.foo()` 里的 X 是**正确**用法（`.value` 就在下一层）。
        //    只有"直接取属性"（`X.foo`）才是漏写。
        const prop = node.property;
        const isValue = prop && !node.computed && prop.type === 'Identifier' && prop.name === 'value';
        if (!isValue && node.object && node.object.type === 'Identifier') {
          const name = node.object.name;
          if (resolvesToTopRef(chain, name)) {
            naked.push({ name, line: blk.lineOffset + node.object.loc.start.line, col: node.object.loc.start.column + 1 });
          }
        }
        visit(node.object, chain);
        if (node.computed) visit(node.property, chain);
        return;
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        if (node.callee && node.callee.type === 'Identifier' && resolvesToTopRef(chain, node.callee.name)) {
          naked.push({ name: node.callee.name, line: blk.lineOffset + node.callee.loc.start.line, col: node.callee.loc.start.column + 1 });
        }
        for (const a of node.arguments || []) visit(a, chain);
        if (node.callee && node.callee.type !== 'Identifier') visit(node.callee, chain);
        return;
      }
      case 'ObjectProperty':
      case 'ObjectMethod':
        for (const k of ['value', 'body']) if (node[k]) visit(node[k], chain);
        for (const p of node.params || []) visit(p, chain);
        return;
      default:
        eachChild(node, (c) => visit(c, chain));
    }
  };

  for (const stmt of ast.program.body) visit(stmt, [top]);

  const findings = [];
  const seen = new Set();
  for (const f of naked) {
    if (!refNames.has(f.name)) continue;
    if (looksLikeTemplateRef(f.name)) continue;                       // 白名单：模板/组件 ref
    if ((valueCounts.get(f.name) || 0) < 2) continue;                 // 从没写过 .value → 无法判定
    const key = `${f.name}@${f.line}@${f.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ file, line: f.line, col: f.col, name: f.name, valueCount: valueCounts.get(f.name) });
  }
  return { findings, refs: refNames.size, valueCounts };
}

function main() {
  const parser = loadParser();
  check('解析器可用（@babel/parser）', () => {
    assert(parser, '找不到 @babel/parser —— 本守卫依赖它（@vue/compiler-sfc 的硬依赖）');
    return 'ok';
  });
  if (!parser) return report();

  // ── 反向探针：守卫必须先能抓到"我们自己刚修的那一行"
  check('反向探针 A：刚修过的形态（同文件里有 .value，却又裸用 ctx.save()）必须被报出', () => {
    const src = `<script setup>
import { ref } from 'vue';
const ctx = ref(null);
function a() { ctx.value.save(); ctx.value.restore(); }
function b() { ctx.save(); ctx.moveTo(1, 2); }
</script>
<template><canvas/></template>`;
    const { findings } = analyzeVue(parser, '<probe>', src);
    assert(findings.length === 2, `期望 2 条（save / moveTo 两处裸用），实际 ${findings.length}：${JSON.stringify(findings)}`);
    assert(findings.every((f) => f.name === 'ctx'), '报的名字必须是 ctx');
    return '2 条，名字正确';
  });

  check('反向探针 B：合法写法不许误报（.value 链 / 局部遮蔽 / 模板 ref / 模板表达式）', () => {
    const src = `<script setup>
import { ref } from 'vue';
const ctx = ref(null);
const wrapEl = ref(null);
function a() { ctx.value.save(); ctx.value.moveTo(1, 2); }
function b() { const ctx = { save() {} }; ctx.save(); }
function c() { ctx.value && ctx.value.clearRect(0, 0, 1, 1); }
function d() { wrapEl.value.focus(); }
function e(o) { return o.ctx.save(); }
const cfg = { ctx: ctx.value };
function f() { for (const ctx of []) { ctx.save(); } }
</script>
<template><canvas ref="wrapEl"/></template>`;
    const { findings } = analyzeVue(parser, '<probe>', src);
    assert(findings.length === 0, `误报 ${findings.length} 条：${JSON.stringify(findings)}`);
    return '0 条误报';
  });

  check('反向探针 C：从来没写过 `.value` 的 ref 不报（无法与"故意裸用"区分）', () => {
    const src = `<script setup>
import { ref } from 'vue';
const mapRef = ref(null);
function a() { mapRef.focusOn(1, 2); }
</script>`;
    const { findings } = analyzeVue(parser, '<probe>', src);
    assert(findings.length === 0, '只有一个裸用、没有 .value 参照 → 应当放过（宁可漏报）');
    return 'ok';
  });

  check('反向探针 D：普通 <script>（非 setup）不参与本守卫', () => {
    const src = `<script>
const ctx = ref(null);
function f() { ctx.value.save(); ctx.save(); }
</script>`;
    const { findings } = analyzeVue(parser, '<probe>', src);
    assert(findings.length === 0, '非 setup 块不该被扫（那里 ref 的语义不同）');
    return 'ok';
  });

  let scanned = 0, refTotal = 0;
  const all = [];
  for (const f of listVue(SRC)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const r = analyzeVue(parser, rel, fs.readFileSync(f, 'utf8'));
    scanned++;
    refTotal += r.refs;
    all.push(...r.findings);
  }

  check(`全仓 ${scanned} 个 .vue 里没有「同一个 ref 有的写 .value 有的漏」`, () => {
    if (!all.length) return `${scanned} 个组件 / ${refTotal} 个顶层 ref / 0 条`;
    const lines = all.map((it) =>
      `  · ${it.file}:${it.line}:${it.col}  裸用 ref「${it.name}」（同文件另有 ${it.valueCount} 处写了 .value）→ 补 .value`
    ).join('\n');
    throw new Error(`发现 ${all.length} 处漏写 .value（运行时会 undefined，且**不会**在构建期报错）：\n${lines}`);
  });

  report();
}

function report() {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main();
