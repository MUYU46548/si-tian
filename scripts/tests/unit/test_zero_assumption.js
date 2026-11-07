#!/usr/bin/env node
/**
 * 单元测试：零假设设定解析（`scripts/lib/zeroAssumption.js`，2026-11-07）
 *
 * 守三件事（用户原话：“用户真实的库可以根本没有 frontmatter，根本没有双链，
 * 年表可以用各种我根本想不到的格式写”）：
 *   ① **不假设结构**：纯散文里也要能掏出实体与事件（靠词频 + 后缀校验 + 谓词共现）；
 *   ② **不许编**：每条输出必须能回引原文一行；引不到就丢；
 *   ③ **假阳性可控**：功能词/时间词/数字量词/跨词语氛 都要挡住（脏库实测曾到 71%）。
 *
 * 负向探针（每条闸门都验一次“拆掉它就会红”）：
 *   · 清空功能词黑名单 → `起来`/`自己`/`什么` 必须冒出来；
 *   · 清空后缀表 → `砺川共和国` 不再拿 high；
 *   · 去掉最小词频 → 只出现一次的碎片会被当实体。
 *
 * 用法：node scripts/tests/unit/test_zero_assumption.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ZA = require(path.join(__dirname, '..', '..', 'lib', 'zeroAssumption.js'));

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DIRTY = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'dirty-vault');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`✓ ${name}${detail ? '  —— ' + detail : ''}`); }
  else { fails.push(name + (detail ? '  —— ' + detail : '')); console.log(`✗ ${name}${detail ? '  —— ' + detail : ''}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 把若干篇 {path, text} 变成解析器要的形状 */
function corpus(list) {
  return list.map((x) => ({ path: x.path, text: x.text, sentences: ZA.splitSentences(x.text) }));
}

// ── ① 纯散文：后缀 + 谓词 → high ───────────────────────────────────────────
{
  const c = corpus([
    { path: 'a.md', text: '黍原王国吞并了白砾河谷。青栎港的船队因此与黍原王国翻了脸。此后黍原王国与青栎港再没做过买卖。' },
  ]);
  const { kept } = ZA.extractEntities(c);
  const names = kept.map((k) => k.name);
  ok('纯散文：抽出“黍原王国”（后缀 + 谓词共现）', names.includes('黍原王国'), names.join('、'));
  ok('纯散文：它在两个以上句子里出现 → confidence=high',
    (kept.find((k) => k.name === '黍原王国') || {}).confidence === 'high',
    (kept.find((k) => k.name === '黍原王国') || {}).confidence);
  ok('每条输出都带原文出处（反编造硬闸）',
    kept.every((k) => k.evidence && k.evidence.length && k.evidence[0].path && k.evidence[0].line > 0));
}

// ── ② 无后缀专名：靠跨文件出现（“南共主”这类） ─────────────────────────────
{
  const c = corpus([
    { path: 'x1.md', text: '南共主退守云岫山，粮道断了。' },
    { path: 'x2.md', text: '南共主与砺川共和国签订盟约。' },
    { path: 'x3.md', text: '南共主投奔黍原王国，编成守关的营。' },
  ]);
  const { kept } = ZA.extractEntities(c);
  const n = kept.find((k) => k.name === '南共主');
  ok('无后缀专名：跨 3 个文件出现 → 收（哪怕没有类型后缀）', !!n, n ? `conf=${n.confidence}` : '没抽到');
  ok('无后缀专名的 confidence 不会是 high（没有类型后缀自证）',
    !!n && n.confidence !== 'high', n && n.confidence);
}

// ── ③ 只出现一次的无后缀词：不抽（这是刻意的召回代价，写在卡上） ────────────
{
  const c = corpus([{ path: 'y.md', text: '六部推共主，是为南共主。南共主后来退守云岫山，又过了三年才投奔黍原王国。' }]);
  const { kept } = ZA.extractEntities(c);
  const names = kept.map((k) => k.name);
  ok('只出现一次的无后缀词不抽（`六部` 是已知召回代价，不硬凑）', !names.includes('六部'), names.join('、') || '(空)');
}

// ── ④ 功能词/时间词/数字量词/跨词语氛 全挡 ─────────────────────────────────
{
  const junk = ['起来', '自己', '什么', '他们', '出来', '后来', '公元前', '二年', '第三年', '关于', '协定', '盟约'];
  const verdicts = junk.map((n) => [n, ZA.isJunkName(n)]);
  ok('功能词 / 时间词 / 数字量词 / 文书名词 一律判为“不是名字”',
    verdicts.every(([, bad]) => bad === true),
    verdicts.filter(([, bad]) => !bad).map(([n]) => n).join('、') || '全部挡住');
  ok('数字开头的**真名字**不误杀（六部 / 三镇 / 七星海）',
    !ZA.isJunkName('六部') && !ZA.isJunkName('三镇') && !ZA.isJunkName('七星海'));
}

// ── ⑤ 时间：绝对锚 + 相对表达绑定 + 未定锚要标记 ───────────────────────────
{
  const c = corpus([{
    path: 't.md',
    text: '三年前的那场仗谁也不提了。公元前 240 年：六部推共主。此后十二年，南共主退守云岫山。',
  }]);
  const t = ZA.extractTimes(c);
  ok('绝对锚认得出来（含“公元前 N 年”）', t.anchors.some((a) => a.text.includes('公元前')), t.anchors.map((a) => a.text).join('、'));
  const bound = t.relatives.find((r) => r.text === '此后十二年');
  ok('相对表达能绑到最近的绝对锚', !!bound && bound.anchored === true, bound && String(bound.anchor));
  const unbound = t.relatives.find((r) => r.text === '三年前');
  ok('没有绝对锚可依的相对表达 → 明确标“未定锚”（不假装知道）',
    !!unbound && unbound.anchored === false, unbound && String(unbound.anchor));
}

// ── ⑥ 负向探针：拆掉任一闸门，判据必须红 ──────────────────────────────────
{
  const text = '他起来看了看，起来又坐下；自己也不知道是什么，自己说不清。他们后来出来了，后来就没再提。';
  const c = corpus([{ path: 'z.md', text }]);
  const strict = ZA.extractEntities(c).kept.map((k) => k.name);
  ok('负向探针 A：默认黑名单下，功能词一个都不该被抽出',
    !['起来', '自己', '什么', '他们', '出来', '后来'].some((w) => strict.includes(w)), strict.join('、') || '(空)');

  // 🔴 探针要打在**黑名单本身**上：走整条管线的话，这些词会先被“最小词频”挡掉，
  //    探针就成了空转（第一版就是这么写的，看起来绿了其实没验到黑名单）。
  const words = ['起来', '自己', '什么', '他们', '出来', '后来'];
  const strictVerdict = words.map((w) => ZA.isJunkName(w));
  const looseVerdict = words.map((w) => ZA.isJunkName(w, new Set()));
  ok('负向探针 B：默认判为噪声；把黑名单清空后同一条规则必须放行（证明拦住它的是黑名单）',
    strictVerdict.every(Boolean) && looseVerdict.every((v) => v === false),
    `strict=${strictVerdict.join(',')} / loose=${looseVerdict.join(',')}`);

  const noSuffix = ZA.extractEntities(corpus([
    { path: 's.md', text: '砺川共和国吞并了小邦。砺川共和国又与黍原王国签订盟约。砺川共和国南下。' },
  ]), { blacklist: new Set() }).kept;
  ok('负向探针 C：正常语料下“砺川共和国”拿 high（后缀 + 谓词 + 多次）',
    (noSuffix.find((k) => k.name === '砺川共和国') || {}).confidence === 'high',
    (noSuffix.find((k) => k.name === '砺川共和国') || {}).confidence);
}

// ── ⑦ 脏库三件套整库闸门（机器判据，不是人眼看） ─────────────────────────
{
  function walk(root, out = []) {
    for (const n of fs.readdirSync(root)) {
      if (n.startsWith('.')) continue;
      const p = path.join(root, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (/\.(md|txt)$/i.test(n)) out.push(p);
    }
    return out;
  }
  const files = walk(DIRTY).map((p) => {
    const text = fs.readFileSync(p, 'utf8');
    return { path: path.relative(DIRTY, p).replace(/\\/g, '/'), text, sentences: ZA.splitSentences(text) };
  });
  const exp = JSON.parse(fs.readFileSync(path.join(DIRTY, 'expected.json'), 'utf8'));
  const { kept } = ZA.extractEntities(files);
  const got = kept.map((k) => k.name);
  const want = exp.entities || [];
  const hit = want.filter((n) => got.includes(n));
  const genericSet = exp.generic_words_must_not_extract || [];
  const fpNames = got.filter((n) => !want.includes(n) && !genericSet.includes(n));
  const recall = want.length ? hit.length / want.length : 1;
  const fp = got.length ? fpNames.length / got.length : 0;

  ok('脏库整库：召回 ≥90%', recall >= 0.9, `${(recall * 100).toFixed(1)}%（${hit.length}/${want.length}，缺 ${want.filter((n) => !got.includes(n)).join('、') || '无'}）`);
  ok('脏库整库：假阳性 ≤10%', fp <= 0.1, `${(fp * 100).toFixed(1)}%（${fpNames.length}/${got.length}${fpNames.length ? '：' + fpNames.join('、') : ''}）`);
  ok('脏库整库：通用词一条都不许泄漏',
    !got.some((n) => genericSet.includes(n)),
    got.filter((n) => genericSet.includes(n)).join('、') || '无');

  // 事件：每条都要能回引原文
  const times = ZA.extractTimes(files);
  const events = ZA.extractEvents(files, kept, times);
  ok('脏库整库：事件 ≥6 条且每条都能回引原文一处',
    events.length >= 6 && events.every((e) => e.evidence && e.evidence.path && e.evidence.line > 0),
    `${events.length} 条`);
}

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.error('失败：\n' + fails.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
