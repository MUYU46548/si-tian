#!/usr/bin/env node
// scripts/zero-assumption-scan.cjs — 零假设设定解析的探针（**只读**）
//
// 三种用法（默认全库预抽；产品形态是**按需单篇**，2026-11-07 第二轮）：
//   全库（读数/对照，已不是产品形态）：
//     node scripts/zero-assumption-scan.cjs --dir <目录> \
//          [--expected <json>] [--json build/_zero/out.json]
//   按需单篇（产品形态：打开某篇 / 问某件事时才抽）：
//     node scripts/zero-assumption-scan.cjs --file "<某篇.md>" [--json <out>] [--show-evidence]
//   抽检 N 篇（判据：单篇 < --max-ms，默认 300ms）：
//     node scripts/zero-assumption-scan.cjs --dir <库> --sample 10 [--seed 7] [--json <out>]
//
// 判据（给了 --expected 才算并决定退出码，只对全库模式）：
//   · 召回 ≥ --min-recall（默认 0.70）：expected.entities 里抽出多少
//   · 假阳性 ≤ --max-fp（默认 0.10）：抽出的名字里“标注与通用词都不是”的比例
//   · 通用词不泄漏：expected.generic_words_must_not_extract 一条都不许被抽出
//   · 时间锚：expected.time_expectations 的绝对锚必须全中；相对表达必须**标出是否已定锚**
// 单篇/抽检模式：只判**耗时**（--max-ms）；名字对不对要人抽检（机器没法替人判“这是不是实体”）。
//
// 只读：不写库、不写 `.sitian`、不建缓存。产物只写 `--json` 指定的路径。
'use strict';

const fs = require('fs');
const path = require('path');
const ZA = require('./lib/zeroAssumption.js');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = arg('dir');
const FILE = arg('file');
const EXPECTED = arg('expected', '');
const OUT = arg('json', '');
const SAMPLE = Number(arg('sample', '0'));
const SEED = Number(arg('seed', '7'));
const MAX_MS = Number(arg('max-ms', '300'));
const MIN_RECALL = Number(arg('min-recall', '0.70'));
const MAX_FP = Number(arg('max-fp', '0.10'));
const QUIET = process.argv.includes('--quiet');
const SHOW_EV = process.argv.includes('--show-evidence');

if (!DIR && !FILE) {
  console.error('用法：\n'
    + '  node scripts/zero-assumption-scan.cjs --dir <目录> [--expected <json>] [--json <out>]\n'
    + '  node scripts/zero-assumption-scan.cjs --file <单篇> [--json <out>] [--show-evidence]\n'
    + '  node scripts/zero-assumption-scan.cjs --dir <库> --sample 10 [--seed 7] [--max-ms 300]');
  process.exit(2);
}

const TEXT_EXT = new Set(['.md', '.txt']);
function walk(root, out = []) {
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const p = path.join(root, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(path.extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

function loadDoc(absPath, root) {
  const text = fs.readFileSync(absPath, 'utf8');
  const rel = root ? path.relative(root, absPath).replace(/\\/g, '/') : path.basename(absPath);
  return { path: rel, text, docKind: ZA.classifyDocKind(text), sentences: ZA.splitSentences(text) };
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const round = (x, n = 3) => { const f = 10 ** n; return Math.round(x * f) / f; };

function writeJson(payload) {
  if (!OUT) return;
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  if (!QUIET) console.log(`结果：${OUT}`);
}

function describeEntity(e) {
  const bits = [`${e.name}`, `${e.confidence}`, `×${e.count}`, e.suffix ? `后缀:${e.suffix}` : '无后缀',
    `主语位 ${e.subjectCount}`, `谓词 ${(e.subjectPredicates && e.subjectPredicates.length) || 0}/${e.predicates.length}`];
  return bits.join(' · ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 单篇（产品形态）：只解析这一篇
// ═══════════════════════════════════════════════════════════════════════════
if (FILE) {
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) { console.error(`文件不存在：${abs}`); process.exit(2); }
  const doc = loadDoc(abs, path.dirname(abs));
  const t0 = nowMs();
  const r = ZA.extractDocument(doc);
  const ms = nowMs() - t0;

  const payload = {
    mode: 'single',
    file: abs,
    docKind: r.docKind,
    ms: round(ms, 2),
    maxMs: MAX_MS,
    entities: r.entities.map((e) => ({
      name: e.name, confidence: e.confidence, count: e.count, suffix: e.suffix,
      subjectCount: e.subjectCount, predicates: e.predicates, subjectPredicates: e.subjectPredicates,
      evidence: SHOW_EV ? e.evidence : e.evidence.slice(0, 1),
    })),
    events: r.events,
    times: r.times,
    dropped: r.dropped.length,
  };
  writeJson(payload);

  if (!QUIET) {
    console.log(`单篇 ${path.basename(abs)} · 类型 ${r.docKind} · ${Buffer.byteLength(doc.text, 'utf8')} 字节 · 耗时 ${ms.toFixed(1)}ms（闸门 ${MAX_MS}ms）`);
    console.log(`实体 ${r.entities.length}：`);
    for (const e of r.entities) console.log(`  · ${describeEntity(e)}`);
    if (!r.entities.length) console.log('  （没有过闸的名字 —— 宁缺勿造）');
    console.log(`事件 ${r.events.length} · 绝对锚 ${r.times.anchors.length} · 相对表达 ${r.times.relatives.length}`);
    if (SHOW_EV) for (const e of r.entities) console.log(`  ${e.name} ← ${e.evidence[0].path}:${e.evidence[0].line} ${e.evidence[0].text.slice(0, 60)}`);
    if (ms > MAX_MS) console.log(`❗ 单篇耗时 ${ms.toFixed(1)}ms 超过闸门 ${MAX_MS}ms`);
  }
  process.exit(ms > MAX_MS ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 抽检 N 篇（判据：单篇耗时；假阳性要人抽检）
// ═══════════════════════════════════════════════════════════════════════════
if (SAMPLE > 0) {
  const abs = path.resolve(DIR);
  const files = walk(abs);
  // 确定性抽样：按 (seed, 相对路径) 的哈希排序取前 N —— 同一批人重跑读数一致
  const hash32 = (s) => {
    let h = 2166136261 ^ SEED;
    for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  const picked = files
    .map((p) => ({ p, rel: path.relative(abs, p).replace(/\\/g, '/') }))
    .sort((a, b) => hash32(a.rel) - hash32(b.rel))
    .slice(0, SAMPLE);

  const rows = [];
  let over = 0;
  for (const { p, rel } of picked) {
    const doc = loadDoc(p, abs);
    const t0 = nowMs();
    const r = ZA.extractDocument(doc);
    const ms = nowMs() - t0;
    if (ms > MAX_MS) over += 1;
    rows.push({
      path: rel, docKind: r.docKind, ms: round(ms, 2), bytes: Buffer.byteLength(doc.text, 'utf8'),
      entities: r.entities.map((e) => ({
        name: e.name, confidence: e.confidence, count: e.count, suffix: e.suffix,
        subjectCount: e.subjectCount, predicates: e.predicates,
      })),
      events: r.events.length,
    });
  }
  const times = rows.map((r) => r.ms);
  const payload = {
    mode: 'sample', dir: DIR, seed: SEED, n: rows.length, maxMs: MAX_MS,
    ms: { max: round(Math.max(...times), 2), mean: round(times.reduce((a, b) => a + b, 0) / times.length, 2) },
    overGate: over,
    docKinds: rows.reduce((acc, r) => { acc[r.docKind] = (acc[r.docKind] || 0) + 1; return acc; }, {}),
    rows,
  };
  writeJson(payload);

  if (!QUIET) {
    console.log(`抽检 ${rows.length} 篇（seed ${SEED}）· 耗时 最大 ${payload.ms.max}ms / 均 ${payload.ms.mean}ms · 超闸门 ${over} 篇（闸门 ${MAX_MS}ms）`);
    console.log(`文档类型：${Object.entries(payload.docKinds).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    for (const r of rows) {
      console.log(`\n── ${r.path}  [${r.docKind}] ${r.bytes}B ${r.ms}ms · 实体 ${r.entities.length}`);
      const shown = r.entities.slice(0, 12).map((e) => `${e.name}(${e.confidence})`);
      console.log(`   ${shown.join('、') || '（无）'}`);
    }
  }
  process.exit(over ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 全库（读数/对照；产品形态不这么用 —— 13.6k 候选 / 166s）
// ═══════════════════════════════════════════════════════════════════════════
const absRoot = path.resolve(DIR);
const files = walk(absRoot).map((p) => loadDoc(p, absRoot));

// 文档类型闸门：**表格页（索引/剪报）、流水账、对话体、AI 审阅稿**不抽设定实体。
// 真机实测：这几类在 1373 篇的库上贡献了大量假阳性（07 资料收藏 / 01 索引 / 96 事务管理 / 对话稿）。
const proseFiles = files.filter((f) => !ZA.SKIP_KINDS.has(f.docKind));
const skipped = files.filter((f) => ZA.SKIP_KINDS.has(f.docKind));

const blacklist = new Set([...ZA.DEFAULT_BLACKLIST]);
const { kept, dropped, stats: exStats } = ZA.extractEntities(proseFiles, { blacklist });
const times = ZA.extractTimes(proseFiles);
const events = ZA.extractEvents(proseFiles, kept, times);

const result = {
  mode: 'dir',
  dir: DIR,
  files: files.length,
  entities: kept,
  droppedSample: dropped.slice(0, 12),
  events,
  times,
  stats: {
    filesSkipped: skipped.length,
    skippedKinds: skipped.reduce((acc, f) => { acc[f.docKind] = (acc[f.docKind] || 0) + 1; return acc; }, {}),
    grams: exStats && exStats.grams,
    candidates: exStats && exStats.candidates,
    kept: kept.length,
    dropped: dropped.length,
    events: events.length,
    anchors: times.anchors.length,
    relatives: times.relatives.length,
    relativesUnanchored: times.relatives.filter((r) => !r.anchored).length,
    byConfidence: kept.reduce((acc, k) => { acc[k.confidence] = (acc[k.confidence] || 0) + 1; return acc; }, {}),
  },
};

let decision = null;
if (EXPECTED) {
  const exp = JSON.parse(fs.readFileSync(EXPECTED, 'utf8').replace(/^\uFEFF/, ''));
  const got = kept.map((k) => k.name);
  const want = exp.entities || [];
  const hit = want.filter((n) => got.includes(n));
  const genericSet = exp.generic_words_must_not_extract || [];
  const fpNames = got.filter((n) => !want.includes(n) && !genericSet.includes(n));
  const genericLeak = got.filter((n) => genericSet.includes(n));
  const recall = want.length ? hit.length / want.length : 1;
  // 假阳性率的分母 = 抽出总数（含通用词泄漏，因为它们也是错误输出）
  const fp = got.length ? (fpNames.length + genericLeak.length) / got.length : 0;

  const absText = times.anchors.map((a) => a.text.replace(/\s+/g, ' '));
  const absWant = (exp.time_expectations && exp.time_expectations.absolute) || [];
  const absMiss = absWant.filter((w) => !absText.some((t) => t.replace(/\s+/g, ' ').includes(w.replace(/\s+/g, ' '))));

  const relWant = (exp.time_expectations && exp.time_expectations.relative) || [];
  const relGot = times.relatives.map((r) => r.text);
  const relMiss = relWant.filter((w) => !relGot.some((g) => g.includes(w) || w.includes(g)));

  decision = {
    recall: round(recall), fp: round(fp),
    hit: hit.length, want: want.length,
    missing: want.filter((n) => !got.includes(n)),
    fpNames: fpNames.slice(0, 20),
    genericLeak,
    absMiss, relMiss,
    eventExpect: (exp.events || []).length,
    eventFound: events.length,
    pass: recall >= MIN_RECALL && fp <= MAX_FP && genericLeak.length === 0 && absMiss.length === 0,
  };
  result.decision = decision;
}

writeJson(result);

if (!QUIET) {
  const st = result.stats;
  console.log(`文件 ${result.files}（跳过表格/流水账/对话/审阅稿 ${st.filesSkipped}）`
    + ` · 过闸实体 ${st.kept}（高/中/低 ${st.byConfidence.high || 0}/${st.byConfidence.mid || 0}/${st.byConfidence.low || 0}）`
    + ` · 丢弃 ${st.dropped} · 事件 ${st.events} · 绝对锚 ${st.anchors} · 相对表达 ${st.relatives}（未定锚 ${st.relativesUnanchored}）`);
  if (Object.keys(st.skippedKinds).length) {
    console.log('跳过的文档类型：' + Object.entries(st.skippedKinds).map(([k, v]) => `${k} ${v}`).join(' / '));
  }
  if (decision) {
    console.log(`召回 ${(decision.recall * 100).toFixed(1)}%（${decision.hit}/${decision.want}）`
      + ` · 假阳性 ${(decision.fp * 100).toFixed(1)}%（${decision.fpNames.length + decision.genericLeak.length}/${result.entities.length}）`
      + ` · 事件 ${decision.eventFound}（标注 ${decision.eventExpect}）`);
    if (decision.missing.length) console.log('没抽到：' + decision.missing.join('、'));
    if (decision.fpNames.length) console.log('假阳性：' + decision.fpNames.join('、'));
    if (decision.genericLeak.length) console.log('❗通用词泄漏：' + decision.genericLeak.join('、'));
    if (decision.absMiss.length) console.log('❗漏掉的绝对锚：' + decision.absMiss.join('、'));
    if (decision.relMiss.length) console.log('❗漏掉的相对表达：' + decision.relMiss.join('、'));
    console.log(decision.pass ? '结论：✅ 达标' : `结论：❌ 未达标（要 召回≥${MIN_RECALL} / 假阳性≤${MAX_FP}）`);
  }
}

if (EXPECTED) process.exit(decision.pass ? 0 : 1);
process.exit(0);
