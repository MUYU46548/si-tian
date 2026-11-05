#!/usr/bin/env node
/**
 * Node 单元测试：**生成即录账本**（provenance，N3a-1 / A8）
 *   utils/genProvenance.js          —— 规范参数 / 指纹 / 记录 / 不可变增删 / 校验（零依赖）
 *   utils/genProvenanceReplay.js    —— 造陆记录的重放与对拍
 *
 * 判据（"可回放、可对拍"这句话的可执行版本）：
 *   a. **同参数同 seed 生成两次 → 同一个 id、同一个 digest**（id 里不许掺时间戳/随机数）；
 *   b. 换 seed / 换 provinceCount → digest 必须变；而**执行期参数**（force / keepHandEdits）
 *      不许影响 digest（它们只改"怎么写"，不改"生成什么"）；
 *   c. `append / drop / provenanceOf` 都是**不可变**的（入参数组一个元素都不能动），
 *      且同一条记录重复追加**不叠加**（id 幂等）；
 *   d. 重放一条**真造陆记录**：两次重放 digest 相同且等于记录里的 digest；
 *      把记录里的 digest 改一个字符 → 必须报 `digest-mismatch`（不是"静默通过"）；
 *   e. `canonicalParams` 键序无关、非有限数（NaN / ±Infinity，含嵌套）**当场抛**；
 *   f. **源码闸门（一条 undo 的守卫）**：`provinceEditing.js` 的 `generate-landmass`
 *      那条 `execute({...})` **块内**必须出现 provenance 写入 —— 账本与数据同进同退；
 *      同一个块里必须 undo / redo 两侧都有（只写一侧 = 撤销后账还在，正是要防的半截状态）。
 *
 * 用法：node scripts/tests/unit/test_gen_provenance.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const STORE_MODULES = path.join(ROOT, 'src', 'renderer', 'src', 'store', 'geodataModules');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function assertThrows(fn, m) {
  let threw = false;
  try { fn(); } catch (_) { threw = true; }
  assert(threw, m);
}

/** 收集相对 import 的依赖闭包（与 test_landmass.js 同一套做法：复制到临时目录 + 补 .js 后缀） */
/** 收集依赖（支持 ./x、./sub/x、../y；统一补 .js）—— 复刻浏览器侧的无后缀导入 */
function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  return seen;
}

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-prov-'));
  for (const [f, src] of collectDeps(names)) {
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`));
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixed);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return { tmp, url: (f) => pathToFileURL(path.join(tmp, f)).href };
}

// ══════════════════════════════════════════════════════════════════════════
// 源码闸门用的扫描器（JS 侧的 `strip_comments` 等价物）
//   为什么要自己写而不是正则一把梭：本仓库的注释里就带着 `execute({` / `'{'` 这类片段，
//   朴素正则会把它们当成代码、或者把接下来上百行代码一起吃进注释（仓库里踩过：
//   785 行的文件被吃到 645 行，断言静默失效）。这里用带状态的扫描器，区分
//   代码 / 行注释 / 块注释 / 字符串 / 模板串 / 正则，输出**等长**的两份：
//     · `text` = 只抹注释（保留字符串内容 → 能搜 `type: 'generate-landmass'`）；
//     · `code` = 注释与字符串内容都抹成空格（只剩代码结构 → 可安全做花括号配对）。
//   两份下标一一对应，所以"在 text 里找到标记、回到 code 里取块"是可靠的。
// ══════════════════════════════════════════════════════════════════════════
function scanSource(src) {
  const code = src.split('');
  const text = src.split('');
  const n = src.length;
  const REGEX_PREV = '(,=:[!&|?{};+-*%~^<>';
  const blank = (arr, a, b) => {
    for (let k = a; k < b && k < n; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  let state = 'code';               // code | line | block | str
  let quote = '';
  let prevSig = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { blank(code, i, i + 2); blank(text, i, i + 2); state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { blank(code, i, i + 2); blank(text, i, i + 2); state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; i += 1; continue; }
      if (c === '/' && (prevSig === '' || REGEX_PREV.indexOf(prevSig) >= 0)) {
        // 正则字面量：整段抹掉（本闸门不需要读正则内容）
        let k = i + 1;
        let inClass = false;
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '[') inClass = true;
          else if (src[k] === ']') inClass = false;
          else if (src[k] === '/' && !inClass) { k += 1; break; }
          k += 1;
        }
        blank(code, i, k); blank(text, i, k); i = k; continue;
      }
      if (!/\s/.test(c)) prevSig = c;
      i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; prevSig = ''; i += 1; continue; }
      blank(code, i, i + 1); blank(text, i, i + 1); i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { blank(code, i, i + 2); blank(text, i, i + 2); state = 'code'; i += 2; continue; }
      blank(code, i, i + 1); blank(text, i, i + 1); i += 1; continue;
    }
    // state === 'str'：字符串内容在 code 里抹掉、在 text 里保留
    if (c === '\\') { blank(code, i, i + 2); i += 2; continue; }
    if (c === quote) { state = 'code'; i += 1; continue; }
    blank(code, i, i + 1); i += 1; continue;
  }
  return { code: code.join(''), text: text.join('') };
}

/** 从 `markerIdx` 往前找最近的 `execute({`，再按花括号配对取出整块（返回 code 里的原文切片） */
function executeBlockOf(scan, markerIdx, label) {
  const at = scan.code.lastIndexOf('execute({', markerIdx);
  assert(at >= 0, `${label}：标记之前找不到 \`execute({\`（入口函数被改名了？）`);
  const open = scan.code.indexOf('{', at);
  assert(open > at, `${label}：\`execute({\` 后面没有对象字面量`);
  let depth = 0;
  let i = open;
  for (; i < scan.code.length; i++) {
    const ch = scan.code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  assert(depth === 0, `${label}：execute({ ... }) 的花括号没配平（扫描器把字符串/注释判错了）`);
  return scan.code.slice(at, i);
}

/** 断言某块里 undo / redo **两侧**都写了账本 */
function assertProvenanceInUndoRedo(block, label) {
  const undoAt = block.indexOf('undo:');
  const redoAt = block.indexOf('redo:');
  assert(undoAt >= 0 && redoAt > undoAt, `${label}：块里找不到 undo:/redo: 的顺序`);
  const undoPart = block.slice(undoAt, redoAt);
  const redoPart = block.slice(redoAt);
  assert(/provenance/i.test(undoPart),
    `${label}：undo 回调里没有 provenance —— 撤销后账还在（数据没了、账还在 = 半截状态）`);
  assert(/provenance/i.test(redoPart),
    `${label}：redo 回调里没有 provenance —— 重做后数据回来了、账没回来`);
}

async function main() {
  const { tmp, url } = loadModules(['genProvenance.js', 'genProvenanceReplay.js']);
  const G = await import(url('genProvenance.js'));
  const R = await import(url('genProvenanceReplay.js'));
  const P = await import(url('terrainParams.js'));
  const L = await import(url('landmass.js'));

  const PARAMS = {
    seed: 7, continentCount: 3, landRatio: 0.32, shape: 'continent',
    roughness: 0.45, sizeVariance: 0.4, provinceCount: 180,
  };
  const SUMMARY = { rings: 3, holes: 1, verts: 2048, rivers: 12, riverPoints: 360 };

  // ── a 确定性：同参数 + 同 seed → 同 id / 同 digest ────────────────────────
  check('a1 同参数同 seed 两次 → 同 id、同 digest', () => {
    const r1 = G.makeGenRecord({ kind: 'landmass', key: 'bm1', params: PARAMS, seed: 7, result: SUMMARY });
    const r2 = G.makeGenRecord({ kind: 'landmass', key: 'bm1', params: { ...PARAMS }, seed: 7, result: { ...SUMMARY } });
    assert(r1.id === r2.id, `id 不同：${r1.id} vs ${r2.id}`);
    assert(r1.digest === r2.digest, `digest 不同：${r1.digest} vs ${r2.digest}`);
    assert(/^gen_landmass_[0-9a-f]{8}$/.test(r1.id), `id 形状不对：${r1.id}（应为 gen_<kind>_<8位hex>）`);
    return `${r1.id} / ${r1.digest}`;
  });

  check('a2 `at` 不进 digest（换时间戳 ≠ 换生成）', () => {
    const r1 = G.makeGenRecord({ kind: 'landmass', key: 'bm1', params: PARAMS, seed: 7, at: '2026-01-01T00:00:00.000Z', result: SUMMARY });
    const r2 = G.makeGenRecord({ kind: 'landmass', key: 'bm1', params: PARAMS, seed: 7, at: '2026-11-02T09:00:00.000Z', result: SUMMARY });
    assert(r1.id === r2.id && r1.digest === r2.digest, 'at 混进了 digest —— 同一组参数两次生成就永远对不上了');
    assert(r1.at !== r2.at, '两条记录的时间戳应该各自保留');
    return 'id 不受 at 影响';
  });

  check('a3 记录形状 + payload 小（只收标量，不收数据本体）', () => {
    const r = G.makeGenRecord({ kind: 'landmass', key: 'bm1', params: PARAMS, seed: 7, result: SUMMARY });
    for (const f of ['id', 'kind', 'key', 'at', 'seed', 'params', 'digest', 'summary']) {
      assert(Object.prototype.hasOwnProperty.call(r, f), `记录缺字段 ${f}`);
    }
    const bytes = JSON.stringify(r).length;
    assert(bytes < 1200, `单条记录 ${bytes} 字节 —— 账本太大了（只该存计数/占比）`);
    return `8 字段 / ${bytes}B`;
  });

  // ── b 参数敏感：生成相关参数变 → digest 变；执行期参数变 → 不变 ─────────────
  check('b1 换 seed → digest 变', () => {
    const a = G.makeGenRecord({ kind: 'landmass', key: 'k', params: PARAMS, seed: 7, result: SUMMARY });
    const b = G.makeGenRecord({ kind: 'landmass', key: 'k', params: { ...PARAMS, seed: 8 }, seed: 8, result: SUMMARY });
    assert(a.digest !== b.digest, '换 seed 后 digest 没变 —— 账本认不出"换了个世界"');
    return `${a.digest} ≠ ${b.digest}`;
  });

  check('b2 换 provinceCount → digest 变', () => {
    const a = G.makeGenRecord({ kind: 'landmass', key: 'k', params: PARAMS, seed: 7, result: SUMMARY });
    const b = G.makeGenRecord({ kind: 'landmass', key: 'k', params: { ...PARAMS, provinceCount: 400 }, seed: 7, result: SUMMARY });
    assert(a.digest !== b.digest, '换铺底块数后 digest 没变 —— 生成的省份数量是不同的，账必须能分辨');
    return `${a.digest} ≠ ${b.digest}`;
  });

  check('b3 执行期参数（force / keepHandEdits / 整份高度图）不进指纹', () => {
    const a = G.makeGenRecord({ kind: 'terrain', key: 'k', params: PARAMS, seed: 7, result: SUMMARY });
    const b = G.makeGenRecord({
      kind: 'terrain', key: 'k', seed: 7, result: SUMMARY,
      params: {
        ...PARAMS, force: true, keepHandEdits: false, onProgress: () => {}, token: 3,
        heightmap: { h: [1, 2, 3, 4], grid: { cellsX: 2, cellsY: 2 } },
      },
    });
    assert(a.digest === b.digest, '执行期参数进了指纹 —— "同参数"会永远对不上（FMG 的整份高度图尤其致命）');
    return '同一 digest';
  });

  check('b4 换 kind → digest 变（造陆与地形不能撞 id）', () => {
    const a = G.makeGenRecord({ kind: 'landmass', key: 'k', params: PARAMS, seed: 7, result: SUMMARY });
    const b = G.makeGenRecord({ kind: 'terrain', key: 'k', params: PARAMS, seed: 7, result: SUMMARY });
    assert(a.digest !== b.digest, '两种生成的 digest 撞了');
    return `${a.digest} ≠ ${b.digest}`;
  });

  // ── c 不可变 + 幂等 ──────────────────────────────────────────────────────
  check('c1 appendGenRecord 不可变 + 同 id 不叠加', () => {
    const empty = [];
    const r1 = G.makeGenRecord({ kind: 'landmass', key: 'A', params: PARAMS, seed: 7, result: SUMMARY });
    const r2 = G.makeGenRecord({ kind: 'culture', key: 'A', params: PARAMS, seed: 7, result: { cultures: 5, cells: 900 } });
    const l1 = G.appendGenRecord(empty, r1);
    const l2 = G.appendGenRecord(l1, r2);
    assert(empty.length === 0, 'appendGenRecord 改了入参数组');
    assert(l1.length === 1 && l2.length === 2, `长度不对：${empty.length}/${l1.length}/${l2.length}`);
    const l2b = G.appendGenRecord(l2, r1);
    assert(l2b.length === 2, `同一条记录重复追加叠出了 ${l2b.length} 条（应原位替换）`);
    assert(l2b.filter((r) => r.id === r1.id).length === 1, '同 id 出现多条');
    assert(l2.length === 2 && l2[0] === r1, 'appendGenRecord 动了已有数组的元素');
    return `长度 0 → 1 → 2（重复追加仍是 2）`;
  });

  check('c2 dropGenRecord 不可变、只删目标 id', () => {
    const r1 = G.makeGenRecord({ kind: 'landmass', key: 'A', params: PARAMS, seed: 7, result: SUMMARY });
    const r2 = G.makeGenRecord({ kind: 'culture', key: 'A', params: PARAMS, seed: 7, result: { cultures: 5 } });
    const list = [r1, r2];
    const dropped = G.dropGenRecord(list, r1.id);
    assert(list.length === 2, 'dropGenRecord 改了入参数组');
    assert(dropped.length === 1 && dropped[0] === r2, '删错了记录');
    assert(G.dropGenRecord(list, 'gen_nope_00000000').length === 2, '删不存在的 id 不该少记录');
    return '原数组 2 条不变';
  });

  check('c3 provenanceOf 按 key 过滤、返回副本', () => {
    const recA = G.makeGenRecord({ kind: 'landmass', key: 'A', params: PARAMS, seed: 7, result: SUMMARY });
    const recB = G.makeGenRecord({ kind: 'culture', key: 'B', params: PARAMS, seed: 7, result: { cultures: 5 } });
    const list = [recA, recB];
    const onlyA = G.provenanceOf(list, 'A');
    assert(onlyA.length === 1 && onlyA[0] === recA, '按 key 过滤不对');
    onlyA.push('x');
    assert(list.length === 2, 'provenanceOf 返回的是原数组（不是副本）');
    assert(G.provenanceOf(list).length === 2, '不带 key 时应返回整个列表的副本');
    return 'A → 1 条 / 全部 → 2 条';
  });

  // ── e canonicalParams：键序无关 + 拒绝非有限数 ────────────────────────────
  check('e1 canonicalParams 键序无关（嵌套对象也一样）', () => {
    const p1 = { seed: 7, landRatio: 0.32, bbox: { minX: -10, minY: -5, maxX: 10, maxY: 5 } };
    const p2 = { bbox: { maxY: 5, maxX: 10, minY: -5, minX: -10 }, landRatio: 0.32, seed: 7 };
    const a = G.canonicalParams(p1);
    const b = G.canonicalParams(p2);
    assert(a === b, `键序影响了指纹：\n${a}\n${b}`);
    assert(a.indexOf('"bbox"') > 0 && a.indexOf('"landRatio"') > 0, '规范串缺字段');
    return a;
  });

  check('e2 canonicalParams 拒绝非有限数（顶层 + 嵌套）', () => {
    assertThrows(() => G.canonicalParams({ seed: 7, landRatio: NaN }), 'NaN 没被拒绝');
    assertThrows(() => G.canonicalParams({ relief: Infinity }), 'Infinity 没被拒绝');
    assertThrows(() => G.canonicalParams({ bbox: { minX: -Infinity, maxX: 10 } }), '嵌套的 -Infinity 没被拒绝');
    assertThrows(() => G.canonicalParams({ seed: 7, list: [1, NaN] }), '数组里的 NaN 没被拒绝');
    assert(G.canonicalParams({ seed: 7, x: 0 }) === '{"seed":7,"x":0}', '正常参数应能规范化');
    return 'NaN / ±Infinity / 嵌套 / 数组 全部抛 TypeError';
  });

  check('e3 summary 只收标量（塞数组当场抛 = payload 小闸门）', () => {
    assertThrows(() => G.summaryOf({ rings: 1, heights: [1, 2, 3] }), 'summary 收下了数组 —— 这正是"把高度图塞进账本"的入口');
    assertThrows(() => G.summaryOf({ grid: { cols: 3 } }), 'summary 收下了嵌套对象');
    const s = G.summaryOf({ b: 2, a: 1, nan: NaN });
    assert(JSON.stringify(s) === '{"a":1,"b":2}', `摘要应排序且丢掉非有限数，实际 ${JSON.stringify(s)}`);
    return JSON.stringify(s);
  });

  // ── d 真造陆记录的重放与对拍 ─────────────────────────────────────────────
  check('d1 真造陆记录：两次重放 digest 相同，且等于记录里的 digest', () => {
    const bbox = { minX: -300, minY: -200, maxX: 300, maxY: 200 };
    const paramsIn = { seed: 11, continentCount: 2, landRatio: 0.3, shape: 'continent', roughness: 0.4, sizeVariance: 0.4, provinceCount: 40 };
    const norm = P.normalizeLandParams(paramsIn).params;
    const gen = L.generateLandmass(norm, bbox);
    // 与 store 里 generate-landmass 的写法逐字一致（params 带上 bbox，摘要走 landmassSummary）
    const rec = G.makeGenRecord({
      kind: 'landmass', key: 'bm-replay',
      params: { ...norm, bbox },
      seed: norm.seed,
      result: G.landmassSummary(gen),
    });
    const r1 = R.replayLandmassRecord(rec);
    const r2 = R.replayLandmassRecord(rec);
    assert(r1.ok === true, `第一次重放没通过：${r1.reason} ${r1.detail || ''}`);
    assert(r2.ok === true, `第二次重放没通过：${r2.reason} ${r2.detail || ''}`);
    assert(r1.digest === rec.digest, `重放 digest ≠ 记录 digest（${r1.digest} vs ${rec.digest}）`);
    assert(r2.digest === r1.digest, '两次重放 digest 不同 —— 生成器不纯（掺了时间/随机）');
    assert(r1.summary.rings === gen.rings.length, '重放摘要的环数对不上');
    return `${rec.id} · ${r1.summary.rings} 环 / ${r1.summary.verts} 顶点 / ${r1.summary.rivers} 河`;
  });

  check('d2 记录被篡改 → digest-mismatch（不是静默通过）', () => {
    const bbox = { minX: -300, minY: -200, maxX: 300, maxY: 200 };
    const norm = P.normalizeLandParams({ seed: 11, continentCount: 2, provinceCount: 40 }).params;
    const gen = L.generateLandmass(norm, bbox);
    const rec = G.makeGenRecord({
      kind: 'landmass', key: 'bm-tamper', params: { ...norm, bbox }, seed: norm.seed,
      result: G.landmassSummary(gen),
    });
    const tampered = { ...rec, digest: rec.digest === '00000000' ? '11111111' : '00000000' };
    const r = R.replayLandmassRecord(tampered);
    assert(r.ok === false, '改掉 digest 后仍然通过 —— 校验是假的');
    assert(r.reason === 'digest-mismatch', `期望 digest-mismatch，实际 ${r.reason}`);
    // 参数被改也要报（改 seed = 另一块大陆）
    const seeded = R.replayLandmassRecord({ ...rec, seed: rec.seed + 1 });
    assert(seeded.ok === false, '改 seed 后仍然通过');
    assert(seeded.reason === 'seed-mismatch', `期望 seed-mismatch，实际 ${seeded.reason}`);
    // 记录里没有图幅 → 明确拒绝，不静默拿默认框糊过去
    const noBox = R.replayLandmassRecord({ ...rec, params: { ...rec.params, bbox: undefined } });
    assert(noBox.ok === false && noBox.reason === 'bad-bbox', `期望 bad-bbox，实际 ${noBox.reason}`);
    return `${r.reason} / ${seeded.reason} / ${noBox.reason}`;
  });

  check('d3 verifyRecord：只验 summary 也可以，改了 summary 就报', () => {
    const rec = G.makeGenRecord({ kind: 'terrain', key: 'k', params: PARAMS, seed: 7, result: { cells: 100, spacing: 12.5 } });
    assert(G.verifyRecord(rec, {}).ok === true, '原样校验应通过');
    const bad = G.verifyRecord(rec, { summary: { cells: 101, spacing: 12.5 } });
    assert(bad.ok === false && bad.reason === 'digest-mismatch', `期望 digest-mismatch，实际 ${bad.reason}`);
    assert(G.verifyRecord(null, {}).reason === 'no-record', '空记录应报 no-record');
    assert(G.verifyRecord(rec, { kind: 'culture' }).reason === 'kind-mismatch', '换 kind 应报 kind-mismatch');
    return 'ok / digest-mismatch / no-record / kind-mismatch';
  });

  // ── f 源码闸门：账本必须写在**同一条 execute** 里 ─────────────────────────
  check('f1 provinceEditing.js：generate-landmass 的 execute 块内 undo+redo 都写账本', () => {
    const src = fs.readFileSync(path.join(STORE_MODULES, 'provinceEditing.js'), 'utf8');
    const scan = scanSource(src);
    const marker = scan.text.indexOf("type: 'generate-landmass'");
    assert(marker >= 0, '找不到 `type: \'generate-landmass\'`（入口被改名了？闸门失效）');
    const block = executeBlockOf(scan, marker, 'generate-landmass');
    assert(/provenance/i.test(block), 'generate-landmass 的 execute 块里没有 provenance —— 账本没跟数据同一条命令');
    assertProvenanceInUndoRedo(block, 'generate-landmass');
    return `块内 ${block.length}B，undo/redo 各有账本写入`;
  });

  check('f2 provinceEditing.js：derive-culture 的 execute 块内 undo+redo 都写账本', () => {
    const src = fs.readFileSync(path.join(STORE_MODULES, 'provinceEditing.js'), 'utf8');
    const scan = scanSource(src);
    const marker = scan.text.indexOf("type: 'derive-culture'");
    assert(marker >= 0, '找不到 `type: \'derive-culture\'`');
    const block = executeBlockOf(scan, marker, 'derive-culture');
    assert(/provenance/i.test(block), 'derive-culture 的 execute 块里没有 provenance');
    assertProvenanceInUndoRedo(block, 'derive-culture');
    return `块内 ${block.length}B，undo/redo 各有账本写入`;
  });

  check('f3 scenarioEditing.js：synthesizeTerrainInto 的 execute 块内 undo+redo 都写账本', () => {
    const src = fs.readFileSync(path.join(STORE_MODULES, 'scenarioEditing.js'), 'utf8');
    const scan = scanSource(src);
    const fnAt = scan.text.indexOf('function synthesizeTerrainInto(');
    assert(fnAt >= 0, '找不到 synthesizeTerrainInto（地形推演的唯一实现被改名了？）');
    const execAt = scan.code.indexOf('execute({', fnAt);
    assert(execAt > 0, 'synthesizeTerrainInto 里没有 execute({');
    const block = executeBlockOf(scan, execAt + 'execute('.length, 'synthesize-terrain');
    assert(/provenance/i.test(block), '地形推演的 execute 块里没有 provenance');
    assertProvenanceInUndoRedo(block, 'synthesize-terrain');
    return `块内 ${block.length}B，undo/redo 各有账本写入`;
  });

  check('f4 扫描器自检：字符串里的 execute({ 不能被当成代码', () => {
    const scan = scanSource([
      '// execute({ 注释里的不算',
      "const s = \"execute({ 字符串里的也不算\";",
      'execute({',
      "  type: 'generate-landmass',",
      '  undo: () => { setProvenance(k, before); },',
      '  redo: () => { setProvenance(k, after); },',
      '});',
    ].join('\n'));
    const marker = scan.text.indexOf("type: 'generate-landmass'");
    const block = executeBlockOf(scan, marker, '自检');
    assert(block.indexOf('// ' + 'execute') < 0, '注释内容漏进了代码扫描结果');
    assertProvenanceInUndoRedo(block, '自检');
    return '注释/字符串已抹，块只剩代码';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 留就留 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('用例自身崩溃：', err); process.exit(1); });
