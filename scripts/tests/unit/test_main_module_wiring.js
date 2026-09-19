#!/usr/bin/env node
/**
 * Node 单元测试：主进程「模块接线」不变式（src/main/index.js ↔ 同目录模块）
 *
 * 为什么需要这一层：
 *   index.js 顶部的 `const { A, B } = require('./config')` 是主进程唯一的导入点。
 *   **少写一个名字不会报错**——Node 照常启动、应用照常开，直到那个 IPC 通道被调用时才抛
 *   `ReferenceError: xxx is not defined`（错误只出现在渲染进程的弹窗里，主进程日志也难看懂）。
 *   实测事故（2026-09-19）：`getCurrentBaseMapKey` / `setCurrentBaseMapKey` 漏解构
 *   → 用户打开「历史剧本」必报 `Error invoking remote method 'get-current-basemap-key':
 *   ReferenceError: getCurrentBaseMapKey is not defined`。
 *
 * 本文件守三条：
 *   1) index.js 里**用到**的本地模块导出名，必须已解构（漏解构 = 运行时 ReferenceError）
 *   2) 解构了但模块没导出的名字 → 报错（解构不存在的键 = 静默 undefined）
 *   3) config.js 的持久化往返：loadConfig 必须把磁盘上的配置**读回内存**
 *      （曾经 currentBaseMapKey 只写不读 → 每次启动都丢）
 *
 * 用法：node scripts/tests/unit/test_main_module_wiring.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤并计入失败）
 * 纪律：只读仓库源码 + 只在临时目录里造 userData，绝不写仓库、绝不碰真实库。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INDEX = path.join(ROOT, 'src', 'main', 'index.js');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/**
 * 去注释（行注释 + 块注释），**保留行号**（注释内容替换成空白/换行）。
 * 不能用「正则一把梭」：本仓库 index.js 里有 `/[\\/:*?"<>|]/g` 这类正则字面量，
 * 里面的 `/*` 和引号会让朴素正则把接下来上百行代码一起当注释吃掉
 * （实测：785 行的文件被吃到 645 行，连 `get-current-basemap-key` 的那一行都不见了 →
 *  断言静默失效）。这里用带状态的扫描器：区分 代码/字符串/模板串/正则 四种上下文。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';                 // code | line | block | sq | dq | tpl | regex
  let prevSig = '';                   // 上一个有意义的代码字符（判断 `/` 是除号还是正则起点）
  const n = src.length;
  const REGEX_PREV = '(,=:[!&|?{};+-*%~^<>';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '/') {
        const canStartRegex = prevSig === '' || REGEX_PREV.indexOf(prevSig) >= 0;
        // 排除 `//` `/*` 之外的除号；仅当上一个是运算符/括号时才当正则
        if (canStartRegex) { state = 'regex'; out += c; i += 1; continue; }
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i += 1;
      if (!/\s/.test(c)) prevSig = c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; prevSig = ''; out += c; } else { out += ' '; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' ');
      i += 1; continue;
    }
    if (state === 'regex') {
      if (c === '\\') { out += c + (c2 || ''); i += 2; continue; }
      if (c === '[') {                       // 字符类内的 `/` 不是正则结束
        out += c; i += 1;
        while (i < n && src[i] !== ']') {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
          out += src[i]; i += 1;
        }
        continue;
      }
      if (c === '/') { state = 'code'; prevSig = '/'; }
      out += c; i += 1; continue;
    }
    // 字符串 / 模板串
    if (c === '\\') { out += c + (c2 || ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    out += c; i += 1;
  }
  return out;
}

/** 解析 `module.exports = { a, b, c };` 的顶层标识符（本仓库四个模块都是这种写法） */
function parseExports(src) {
  const src2 = stripComments(src);
  const at = src2.indexOf('module.exports');
  assert(at >= 0, '模块没有 module.exports');
  const open = src2.indexOf('{', at);
  const close = src2.indexOf('};', open);
  assert(open >= 0 && close > open, 'module.exports 不是对象字面量（本测试只支持这种形式）');
  return src2.slice(open + 1, close)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.split(':')[0].trim())
    .filter(s => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** 取出 index.js 里所有本地 require 的 { 解构名 } 与模块路径 */
function parseLocalRequires(src) {
  const src2 = stripComments(src);
  const out = [];
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)/g;
  let m;
  while ((m = re.exec(src2)) !== null) {
    const spec = m[3];
    if (!spec.startsWith('.')) continue;                       // 只查仓库内模块
    const names = m[1].split(',').map(s => s.trim().split(':').pop().trim()).filter(Boolean);
    out.push({ spec, names, raw: m[0] });
  }
  return out;
}

/**
 * index.js 自身**声明**过的名字（本地常量/函数/类 + 任何 require 的解构名）。
 * 必要性：index.js 里可能有与某模块导出**同名但本地自建**的实现
 * （实测：`BACKUP_KEEP` / `ILLEGAL_CHARS` / `sanitizeFileName` 是 index.js 自己的，
 *  `getVaultPath` 来自 './config' 而 './vault-watcher' 也导出了同名函数）。
 * 只有「模块导出了 + index.js 用了 + 谁都没声明」才是真接线漏项。
 */
function parseDeclaredNames(src) {
  const src2 = stripComments(src);
  const set = new Set();
  const addAll = (str) => str.split(',').forEach(s => {
    const n = s.trim().split(':').pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) set.add(n);
  });
  let m;
  const reReq = /const\s*\{([^}]*)\}\s*=\s*require\(/g;
  while ((m = reReq.exec(src2)) !== null) addAll(m[1]);
  const reSimple = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/g;
  while ((m = reSimple.exec(src2)) !== null) set.add(m[1]);
  const reFn = /\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(src2)) !== null) set.add(m[1]);
  return set;
}

/** 给「用途扫描」用的源码：把 require 解构语句整段抹掉（否则解构行自己就算一次「使用」） */
function sourceWithoutRequireLines(src) {
  return stripComments(src).replace(
    /const\s*\{[^}]*\}\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)\s*;?/g,
    (full, _q, spec) => (spec.startsWith('.') ? '\n'.repeat((full.match(/\n/g) || []).length) : full),
  );
}

let TMP = '';
let USER_DATA = '';

async function resolveTmpRoot() {
  const candidates = [
    process.env.SITIAN_TEST_TMP,
    process.env.TEMP,
    process.env.TMP,
    (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
    path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
    path.join(os.homedir(), '.sitian-test-tmp'),
  ].filter(Boolean);
  const tried = [];
  for (const base of candidates) {
    const dir = path.join(base, `sitian-wiring-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      USER_DATA = path.join(dir, 'userData');
      await fsp.mkdir(USER_DATA, { recursive: true });
      return;
    } catch (e) {
      tried.push(`${base} → ${e.code || e.message}`);
    }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

async function main() {
  await resolveTmpRoot();

  const indexSrc = await fsp.readFile(INDEX, 'utf-8');
  const requires = parseLocalRequires(indexSrc);
  const usageSrc = sourceWithoutRequireLines(indexSrc);
  const declaredAnywhere = parseDeclaredNames(indexSrc);

  assert(requires.length >= 3, `index.js 里的本地 require 只解析出 ${requires.length} 个，解析器可能失效了`);

  // ── 1/2) 解构 ↔ 导出 双向一致 ───────────────────────────────────────────
  await check('index.js 的本地 require 无「用到却没解构」/「解构了却没导出」', async () => {
    const problems = [];
    const report = [];
    for (const r of requires) {
      const abs = path.resolve(path.dirname(INDEX), r.spec);
      const file = fs.existsSync(abs + '.js') ? abs + '.js' : abs;
      assert(fs.existsSync(file), `找不到被 require 的模块：${r.spec}`);
      const exported = parseExports(await fsp.readFile(file, 'utf-8'));
      const declared = new Set(r.names);
      const missing = exported.filter(n => !declaredAnywhere.has(n) && new RegExp(`\\b${n}\\b`).test(usageSrc));
      const phantom = [...declared].filter(n => !exported.includes(n));
      if (missing.length) problems.push(`${r.spec} 用到但没解构 → ${missing.join(', ')}`);
      if (phantom.length) problems.push(`${r.spec} 解构了但该模块没导出 → ${phantom.join(', ')}`);
      report.push(`${r.spec}: 导出 ${exported.length} / 解构 ${declared.size}${missing.length || phantom.length ? ' ✗' : ' ✓'}`);
    }
    assert(problems.length === 0,
      '模块接线不一致（这类问题不会在启动时报错，只在对应 IPC 被调用时抛 ReferenceError）：\n    ' + problems.join('\n    '));
    return report.join('；');
  });

  // ── 3) config 持久化往返（读回 + 写盘）────────────────────────────────
  await check('config.js：loadConfig 读回 currentBaseMapKey（只写不读 = 每次启动丢配置）', async () => {
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return { app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' } };
      }
      return origLoad.apply(this, arguments);
    };
    let cfg;
    try {
      cfg = require(path.join(ROOT, 'src', 'main', 'config.js'));
    } finally {
      Module._load = origLoad;
    }

    const onDisk = {
      vaultPath: 'E:/图书馆/ROSA',
      windowMode: 'default',
      closeQuitsApp: true,
      currentBaseMapKey: 'desite',
      lastProjectPath: 'E:/SiTianProjects/世界.sitian',
    };
    await fsp.writeFile(path.join(USER_DATA, 'config.json'), JSON.stringify(onDisk, null, 2), 'utf-8');
    await cfg.loadConfig();

    eq(cfg.getVaultPath(), onDisk.vaultPath, 'vaultPath 未读回');
    eq(cfg.getWindowMode(), onDisk.windowMode, 'windowMode 未读回');
    eq(cfg.getCloseQuitsApp(), onDisk.closeQuitsApp, 'closeQuitsApp 未读回');
    eq(cfg.getCurrentBaseMapKey(), onDisk.currentBaseMapKey, 'currentBaseMapKey 未读回');
    eq(cfg.getLastProjectPath(), onDisk.lastProjectPath, 'lastProjectPath 未读回');

    await cfg.setCurrentBaseMapKey('德斯特星');
    const written = JSON.parse(await fsp.readFile(path.join(USER_DATA, 'config.json'), 'utf-8'));
    eq(written.currentBaseMapKey, '德斯特星', '写入未落到 config.json');
    eq(written.vaultPath, onDisk.vaultPath, '写入覆盖了其它配置键');
    return '5 个配置键读回一致 + 写盘保留其它键';
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 主进程模块接线单元测试（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }

  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    if (TMP) await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
