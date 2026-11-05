#!/usr/bin/env node
/**
 * Node 单元测试：**免责声明的口径一致性**（2026-11-05，用户拍板“B 默认不联网 + 可选 AI”）
 *
 * 背景：这条承诺以前有 3~4 份实现（`utils/disclaimer.js` 两处 + `AboutPanel.vue` + `README.md`），
 * 而且写的是**绝对承诺**“不接入任何云端 AI”。用户 2026-11-05 拍板 B 档之后，那句话就与
 * `DECISIONS_20261104.md` §S17（AI = 只建议、不落库）打架了 —— 也挡住了“从资料库提取设定”。
 *
 * 现在的口径（改文案前先读这一页）：
 *   · **默认不联网**：无账号、无遥测；联网只在用户主动触发处（检查更新 / 自配 Git / 显式开启的 AI）；
 *   · **本版本不含任何 AI 入口**（这句必须保留 —— 不能为了将来方便而把话说满）；
 *   · 将来若提供 AI 助手，四条固定约束：默认关闭 / 自带密钥 / 只发那一次请求 / 只建议不落库。
 *
 * 判据：
 *   1) `LOCAL_ONLY_SUMMARY` 含“默认不联网 / 没有账号 / 没有遥测 / 主动触发”，且**不含**绝对承诺；
 *   2) `AI_STANCE` 四条齐全（默认关闭 / 自带密钥 / 只发那一次请求 / 只建议、不落库）；
 *   3) 首启短版第 1、2 条与上述口径一致（不许出现“不接入任何云端 AI”）；
 *   4) 完整声明第 2 节真的把 `AI_STANCE` 嵌进去了（不是另写一份），且写明“本版本没有任何 AI 入口”；
 *   5) 条款版本升过（1.1.0）且日期是 2026-11-05 —— 实质变更必须让老 ack 失效，否则
 *      用户手里那份“已同意”覆盖的是旧条款（这条是声明自己设计的机制，改文案就得升）；
 *   6) `AboutPanel.vue` **引用** `LOCAL_ONLY_SUMMARY`（不许自己再手写一份）；
 *      `README.md` 含同样的关键短语，且不再出现绝对承诺；
 *   7) 负向探针：把“不接入任何云端 AI”塞回去必须红；删掉四条约束里的任一条必须红。
 *
 * 用法：node scripts/tests/unit/test_disclaimer_copy.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const results = [];
let TMP = '';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

/** disclaimer.js 是 ESM（纯函数 + 无外部 import），复制到临时目录直接 import */
async function importDisclaimer() {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-disclaimer-'));
  const dir = path.join(TMP, 'd');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), '{"type":"module"}', 'utf-8');
  const body = readText(path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'disclaimer.js'));
  await fsp.writeFile(path.join(dir, 'disclaimer.js'), body, 'utf-8');
  return import(pathToFileURL(path.join(dir, 'disclaimer.js')).href);
}

/** 绝对承诺（B 档之后就是假话）：出现即红 */
const ABSOLUTE = [
  { label: '不接入任何云端 AI', re: /不接入任何云端\s*AI/ },
  { label: '不含任何大语言模型（不带时间限定的绝对说法）', re: /不含任何大语言模型(?!.*本版本)/ },
];
/** 口径必须出现的关键短语 */
const MUST = [
  { label: '默认不联网', re: /默认不联网/ },
  { label: '没有账号', re: /没有账号/ },
  { label: '没有遥测', re: /没有遥测/ },
  { label: '主动触发', re: /主动触发/ },
];
/** AI 四条约束 */
const AI_MUST = [
  { label: '默认关闭', re: /默认关闭/ },
  { label: '自带密钥', re: /自带密钥/ },
  { label: '只发那一次请求', re: /只发那一次请求/ },
  { label: '只建议、不落库', re: /只建议、不落库/ },
];

function hits(text, list) { return list.filter((w) => w.re.test(text)).map((w) => w.label); }
function missing(text, list) { return list.filter((w) => !w.re.test(text)).map((w) => w.label); }

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ' —— ' + detail : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    console.log(`  ❌ ${name} —— ${(err && err.message) || err}`);
  }
}

async function main() {
  const D = await importDisclaimer();
  const about = readText(path.join(ROOT, 'src', 'renderer', 'src', 'components', 'AboutPanel.vue'));
  const readme = readText(path.join(ROOT, 'README.md'));
  const section2 = D.DISCLAIMER_FULL.find((s) => s.n === 2) || { blocks: [] };
  const section2Text = section2.blocks.map((b) => [b.text || '', ...(b.items || [])].join('\n')).join('\n');

  await check('1 LOCAL_ONLY_SUMMARY：四条口径齐 + 没有绝对承诺', async () => {
    const s = D.LOCAL_ONLY_SUMMARY || '';
    const lack = missing(s, MUST);
    assert(lack.length === 0, `缺少：${lack.join('、')}`);
    const bad = hits(s, ABSOLUTE);
    assert(bad.length === 0, `还有绝对承诺：${bad.join('、')}`);
    return `${s.length} 字，四条齐`;
  });

  await check('2 AI_STANCE：四条约束齐全（用户拍板 B 档的那四条）', async () => {
    const arr = D.AI_STANCE || [];
    assert(arr.length >= 4, `只有 ${arr.length} 条（应 ≥4）`);
    const t = arr.join('\n');
    const lack = missing(t, AI_MUST);
    assert(lack.length === 0, `缺少：${lack.join('、')}`);
    const bad = hits(t, ABSOLUTE);
    assert(bad.length === 0, `AI 口径里还有绝对承诺：${bad.join('、')}`);
    return `${arr.length} 条`;
  });

  await check('3 首启短版：第 1、2 条与新口径一致', async () => {
    const short = (D.DISCLAIMER_SHORT || []).join('\n');
    const lack = missing(short, MUST.filter((w) => w.label !== '主动触发'));
    assert(lack.length === 0, `短版缺少：${lack.join('、')}`);
    const bad = hits(short, ABSOLUTE);
    assert(bad.length === 0, `短版里还有绝对承诺：${bad.join('、')}`);
    assert(/显式开启|你自己显式开启/.test(short), '短版没写“AI 必须显式开启”（这是 B 档的要点）');
    return `${(D.DISCLAIMER_SHORT || []).length} 条`;
  });

  await check('4 完整声明第 2 节：嵌入 AI_STANCE + 写明“本版本没有任何 AI 入口”', async () => {
    const bad = hits(section2Text, ABSOLUTE);
    assert(bad.length === 0, `第 2 节还有绝对承诺：${bad.join('、')}`);
    for (const w of AI_MUST) {
      assert(w.re.test(section2Text), `第 2 节没把 AI_STANCE 嵌进去（缺“${w.label}”）—— 不许另写一份`);
    }
    assert(/本版本没有任何\s*AI\s*入口|本版本没有\s*AI\s*入口/.test(section2Text),
      '第 2 节没写“本版本没有任何 AI 入口”（不写这句就等于承诺了不存在的功能）');
    return '四条约束都在，且限定了当前版本';
  });

  await check('5 条款版本已升：实质变更要让老 ack 失效', async () => {
    assert(D.DISCLAIMER_VERSION && D.DISCLAIMER_VERSION !== '1.0.0',
      `DISCLAIMER_VERSION 还是 ${D.DISCLAIMER_VERSION} —— 改了实质内容不升版本，用户手里的“已同意”覆盖的是旧条款`);
    assert(D.DISCLAIMER_UPDATED_AT === '2026-11-05', `DISCLAIMER_UPDATED_AT=${D.DISCLAIMER_UPDATED_AT}（应为 2026-11-05）`);
    assert(D.DISCLAIMER_ACK_KEY.includes(D.DISCLAIMER_VERSION), 'ack 键名没带版本号 —— 老确认不会被作废');
    return `v${D.DISCLAIMER_VERSION} @ ${D.DISCLAIMER_UPDATED_AT}`;
  });

  await check('6 组件与 README：引用同一份口径，不再各写一份', async () => {
    assert(/LOCAL_ONLY_SUMMARY/.test(about) && /from '\.\.\/utils\/disclaimer'/.test(about),
      'AboutPanel 没有 import LOCAL_ONLY_SUMMARY（说明它还在自己手写那句承诺）');
    const aboutText = about.replace(/<style[\s\S]*$/, '');
    const aboutBad = hits(aboutText, ABSOLUTE);
    assert(aboutBad.length === 0, `AboutPanel 里还有绝对承诺：${aboutBad.join('、')}`);
    const readmeBad = hits(readme, ABSOLUTE);
    assert(readmeBad.length === 0, `README 里还有绝对承诺：${readmeBad.join('、')}`);
    // README 手抄不了 import，至少要求同样的四个短语都在
    const readmeLack = missing(readme, MUST);
    assert(readmeLack.length === 0, `README 缺少：${readmeLack.join('、')}`);
    assert(/只建议、不落库/.test(readme), 'README 没写 AI 的“只建议、不落库”口径');
    return 'AboutPanel 引用单源；README 四条齐';
  });

  await check('7 负向探针：把绝对承诺塞回去 / 删掉一条 AI 约束，都必须红', async () => {
    // ① 绝对承诺
    const fakeBad = '司天是**完全本地**的桌面工具：不接入任何云端 AI 服务。';
    assert(hits(fakeBad, ABSOLUTE).length === 1, '负向探针没抓住“不接入任何云端 AI”');
    // ② 删掉一条约束
    const trimmed = (D.AI_STANCE || []).filter((t) => !/只发那一次请求/.test(t)).join('\n');
    assert(missing(trimmed, AI_MUST).includes('只发那一次请求'), '负向探针没发现少了一条 AI 约束');
    // ③ 版本没升
    assert(D.DISCLAIMER_VERSION !== '1.0.0', '版本判据与预期不符');
    return '三条都抓到了';
  });

  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - bad.length}/${results.length} 通过 ===`);
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  if (bad.length) {
    for (const f of bad) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
