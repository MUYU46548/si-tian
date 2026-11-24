#!/usr/bin/env node
/**
 * Node 单元测试：**免责声明的口径一致性**（2026-11-07 拍板：不接入任何云端 AI）
 *
 * 背景（两次口径变迁，别走回头路）：
 *   · 2026-11-05：用户拍板“B 默认不联网 + 可选 AI”，于是**删掉**了“不接入任何云端 AI”这句绝对承诺，
 *     理由是它会与 S17（AI 只建议不落库）打架、并挡死“从资料库提取设定”；
 *   · 2026-11-07：用户确认“什么都提取不了”，自动提取被砍 —— **当初让路的唯一理由消失**，
 *     这句承诺**收回为硬承诺**，`AI_STANCE` 一并删除。
 *
 * 现在的口径（改文案前先读这一页）：
 *   · **默认不联网**：无账号、无遥测；联网只在主动触发处（检查更新 / 自配 Git 同步）；
 *   · **没有任何 AI 功能**：没有 AI 助手、不接大语言模型、无后台自动调用；
 *   · **不许再出现“将来若提供可选 AI”** —— 想加回来必须重新拍板并再升条款版本。
 *
 * 判据（与 1.1.0 那一版**方向相反**，看清楚再改）：
 *   1) `LOCAL_ONLY_SUMMARY` 含“默认不联网 / 没有账号 / 没有遥测 / 主动触发 / 不接入任何云端 AI”；
 *   2) `AI_STANCE` **已经不存在**（导出为 undefined，不是空数组 —— 留着空壳等于留了回头路）；
 *   3) 首启短版第 1、2 条写明“不接入任何云端 AI”，且不出现“将来若提供 / 可选 AI / 显式开启”；
 *   4) 完整声明第 2 节写明“没有任何 AI 功能”，且不含旧四条（默认关闭/自带密钥/只发那一次请求/只建议、不落库）；
 *   5) 条款版本 = 1.2.0、日期 = 2026-11-07（实质变更必须让老 ack 失效）；
 *   6) `AboutPanel.vue` **引用** `LOCAL_ONLY_SUMMARY`（不许自己再手写一份）；README 含同样短语；
 *   7) 负向探针：删掉承诺必须红 / 塞回“可选 AI”必须红 / 版本退回 1.1.0 必须红。
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

/** 口径必须出现的关键短语 */
const MUST = [
  { label: '默认不联网', re: /默认不联网/ },
  { label: '没有账号', re: /没有账号/ },
  { label: '没有遥测', re: /没有遥测/ },
  { label: '主动触发', re: /主动触发/ },
  { label: '不接入任何云端 AI', re: /不接入任何云端\s*AI/ },
];
/** 旧口径残留（出现即红）：这些都是 2026-11-05 的“可选 AI”话术 */
const FORBIDDEN = [
  { label: '可选 AI', re: /可选\s*AI/ },
  { label: '将来若提供', re: /将来若提供/ },
  { label: '显式开启', re: /显式开启/ },
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

  await check('1 LOCAL_ONLY_SUMMARY：五条口径齐（含“不接入任何云端 AI”）', async () => {
    const s = D.LOCAL_ONLY_SUMMARY || '';
    const lack = missing(s, MUST);
    assert(lack.length === 0, `缺少：${lack.join('、')}`);
    const bad = hits(s, FORBIDDEN);
    assert(bad.length === 0, `还留着旧口径：${bad.join('、')}`);
    return `${s.length} 字，五条齐`;
  });

  await check('2 AI_STANCE 已删除（留着空壳等于留了回头路）', async () => {
    assert(D.AI_STANCE === undefined, '`AI_STANCE` 还在导出 —— 2026-11-07 拍板砍 AI 通道后它应当不存在');
    return 'undefined';
  });

  await check('3 首启短版：写明“不接入任何云端 AI”，且没有“将来若提供”', async () => {
    const short = (D.DISCLAIMER_SHORT || []).join('\n');
    const lack = missing(short, MUST.filter((w) => w.label !== '主动触发'));
    assert(lack.length === 0, `短版缺少：${lack.join('、')}`);
    const bad = hits(short, FORBIDDEN);
    assert(bad.length === 0, `短版里还留着旧口径：${bad.join('、')}`);
    return `${(D.DISCLAIMER_SHORT || []).length} 条`;
  });

  await check('4 完整声明第 2 节：没有 AI、且没有旧四条约束', async () => {
    assert(/没有(任何)?\s*AI\s*功能/.test(section2Text), '第 2 节没写“没有任何 AI 功能”');
    assert(/不接入任何云端\s*AI/.test(section2Text), '第 2 节没写“不接入任何云端 AI”');
    const bad = hits(section2Text, FORBIDDEN);
    assert(bad.length === 0, `第 2 节还留着旧 AI 约束：${bad.join('、')}`);
    return '硬承诺到位，旧约束已清';
  });

  await check('5 条款版本 1.3.0 @ 2026-11-24（实质变更要让老 ack 失效）', async () => {
    // 2026-11-24：升版理由是**实质变更**——用户拍板删掉了原第 12 节
    // （适用法律与争议解决，内含【待定：司法辖区】的空条款）。
    // 删掉那条空白约定属于条款实质变化，所以版本必须动，否则老用户的 ack 会继续生效。
    assert(D.DISCLAIMER_VERSION === '1.3.0', `DISCLAIMER_VERSION=${D.DISCLAIMER_VERSION}（应为 1.3.0）`);
    assert(D.DISCLAIMER_UPDATED_AT === '2026-11-24', `DISCLAIMER_UPDATED_AT=${D.DISCLAIMER_UPDATED_AT}（应为 2026-11-24）`);
    assert(D.DISCLAIMER_ACK_KEY.includes(D.DISCLAIMER_VERSION), 'ack 键名没带版本号 —— 老确认不会被作废');
    return `v${D.DISCLAIMER_VERSION} @ ${D.DISCLAIMER_UPDATED_AT}`;
  });

  await check('6 组件与 README：引用同一份口径，不再各写一份', async () => {
    assert(/LOCAL_ONLY_SUMMARY/.test(about) && /from '\.\.\/utils\/disclaimer'/.test(about),
      'AboutPanel 没有 import LOCAL_ONLY_SUMMARY（说明它还在自己手写那句承诺）');
    const aboutText = about.replace(/<style[\s\S]*$/, '');
    assert(!/不接入任何云端\s*AI/.test(aboutText),
      'AboutPanel 又手写了一份“不接入任何云端 AI” —— 只许引用常量（单源）');
    const readmeLack = missing(readme, MUST.filter((w) => w.label === '不接入任何云端 AI'));
    assert(readmeLack.length === 0, 'README 没写“不接入任何云端 AI”');
    const readmeBad = hits(readme, FORBIDDEN);
    assert(readmeBad.length === 0, `README 里还留着旧口径：${readmeBad.join('、')}`);
    return 'AboutPanel 引用单源；README 同步';
  });

  await check('7 负向探针：删承诺 / 塞回可选 AI / 版本退回，都必须红', async () => {
    const noPromise = '司天默认不联网、没有账号、没有遥测，联网只发生在你主动触发的地方。';
    assert(missing(noPromise, MUST).includes('不接入任何云端 AI'), '负向探针没发现“承诺被删掉”');
    const sneaky = '将来若提供可选 AI 助手，口径是自带密钥、只发那一次请求。';
    assert(hits(sneaky, FORBIDDEN).length >= 3, '负向探针没抓住“可选 AI”话术');
    assert('1.1.0' !== D.DISCLAIMER_VERSION, '负向探针：版本判据失效（退回 1.1.0 没被抓住）');
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
