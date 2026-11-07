#!/usr/bin/env node
// scripts/zero-assumption-scan.cjs — 零假设设定解析的探针（**只读**）
//
// 用法：
//   node scripts/zero-assumption-scan.cjs --dir scripts/tests/fixtures/dirty-vault \
//        --expected scripts/tests/fixtures/dirty-vault/expected.json
//   node scripts/zero-assumption-scan.cjs --dir <真实库> --json build/_zero/out.json   # 只读，不写库
//
// 判据（给了 --expected 才算并决定退出码）：
//   · 召回 ≥ --min-recall（默认 0.70）：expected.entities 里抽出多少
//   · 假阳性 ≤ --max-fp（默认 0.10）：抽出的名字里“标注与通用词都不是”的比例
//   · 通用词不泄漏：expected.generic_words_must_not_extract 一条都不许被抽出
//   · 时间锚：expected.time_expectations 的绝对锚必须全中；相对表达必须**标出是否已定锚**
'use strict';

const fs = require('fs');
const path = require('path');
const ZA = require('./lib/zeroAssumption.js');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = arg('dir');
const EXPECTED = arg('expected', '');
const OUT = arg('json', '');
const MIN_RECALL = Number(arg('min-recall', '0.70'));
const MAX_FP = Number(arg('max-fp', '0.10'));
const QUIET = process.argv.includes('--quiet');

if (!DIR) {
  console.error('用法：node scripts/zero-assumption-scan.cjs --dir <目录> [--expected <json>] [--json <out>]');
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

const abs = path.resolve(DIR);
const files = walk(abs).map((p) => {
  const text = fs.readFileSync(p, 'utf8');
  const docKind = ZA.classifyDocKind(text);
  return { path: path.relative(abs, p).replace(/\\/g, '/'), text, docKind, sentences: ZA.splitSentences(text) };
});

// 文档类型闸门：**表格页（索引/剪报）与流水账页不抽设定实体**。
// 真机实测这两类在 1373 篇的库上贡献了大量假阳性（07 资料收藏 / 01 索引 / 96 事务管理）。
const KNOWN_SKIP = new Set(['table', 'changelog']);
const proseFiles = files.filter((f) => !KNOWN_SKIP.has(f.docKind));
const skipped = files.filter((f) => KNOWN_SKIP.has(f.docKind));

const blacklist = new Set([...ZA.DEFAULT_BLACKLIST]);
const { kept, dropped, stats: exStats } = ZA.extractEntities(proseFiles, { blacklist });
const times = ZA.extractTimes(proseFiles);
const events = ZA.extractEvents(proseFiles, kept, times);

const result = {
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

function round(x) { return Math.round(x * 1000) / 1000; }

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

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  if (!QUIET) console.log(`结果：${OUT}`);
}

if (!QUIET) {
  const st = result.stats;
  console.log(`文件 ${result.files}（跳过表格/流水账 ${st.filesSkipped}）· 过闸实体 ${st.kept}（高/中/低 ${st.byConfidence.high || 0}/${st.byConfidence.mid || 0}/${st.byConfidence.low || 0}）`
    + ` · 丢弃 ${st.dropped} · 事件 ${st.events} · 绝对锚 ${st.anchors} · 相对表达 ${st.relatives}（未定锚 ${st.relativesUnanchored}）`);
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
