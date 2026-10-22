#!/usr/bin/env node
/**
 * Node 单测：frontmatter 噪声健壮性（2026-10-22，读料桥补强）
 *
 * 用户提醒（原话）：「真实场景中用户的 frontmatter 可能随便乱写，根本没有你预期的归类。
 * 你永远想不到用户怎么写 .md，甚至可能不按标准格式来，或者混了一堆插件产物。」
 *
 * 所以这里不测「规范长什么样」，专测**不规范时不许崩、不许静默丢**：
 *   ① 值里带空格 / 全角空格 / wikilink / 引号 → 仍然能认；
 *   ② tags 写成 `"#地点 #港口"`（字符串）、对象、数字 → 不崩，能用的就用；
 *   ③ 没有闭合 `---`、YAML 语法错、BOM、正文里 dataview `key:: value` → 条目不丢，
 *      该进「待人工」的进，且原因里能看出是解析失败；
 *   ④ 插件产物键（cssclasses / banner / dg-publish / dataview）不改变归类；
 *   ⑤ 上层写 `[[北境|北]]` / 裸名 / 别名 → 能解析；
 *   ⑥ 总数守恒：报告里的条目数 = 库里的笔记数（一个都不许吞）。
 *
 * 用法：node scripts/tests/unit/test_vault_frontmatter_noise.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));
const classify = require(path.join(ROOT, 'scripts', 'lib', 'vaultClassify.js'));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const FILES = {
  // ① 值里的空格 / 全角空格 / wikilink / 引号
  '杂/全角.md': '---\n层级:　城市　\n---\n全角空格包围。\n',
  '杂/链接值.md': '---\n层级: "[[城镇]]"\n---\n层级写成双链。\n',
  '杂/引号值.md': "---\n类型: '主要角色'\n---\n单引号。\n",
  // ② tags 的三种非法写法
  '杂/井号tags.md': '---\ntags: "#地点 #港口"\n---\n标签写成井号串。\n',
  '杂/对象tags.md': '---\ntags: {primary: 地点}\n层级: 设施\n---\n标签是对象。\n',
  '杂/数字tags.md': '---\ntags: 114514\n---\n标签是数字。\n',
  // ③ 结构坏了 / BOM / dataview
  '杂/没有闭合.md': '---\n层级: 城市\n\n这是没有闭合的 frontmatter，后面当正文。\n',
  '杂/YAML错.md': '---\n层级: [城市\n类型: 主要角色\n---\n方括号没闭合。\n',
  '杂/BOM.md': '\uFEFF---\ntags: [地点]\n---\n带 BOM 的文件。\n',
  '杂/dataview.md': '---\ntags: [地理系统]\n---\n```dataview\nTABLE file.mtime FROM #地点\n```\n正文里有 dataview 查询 `key:: value`。\n',
  // ④ 插件产物键
  '杂/插件键.md': '---\ncssclasses: [wide]\nbanner: "![[banner.png]]"\ndg-publish: true\ndataview: true\n层级: 行星\n---\n插件塞了一堆键。\n',
  // ⑤ 上层的三种写法
  '杂/父级-别名.md': '---\n层级: 城市\n上层区域: "[[北境|北]]"\n---\n带显示名的双链。\n',
  '杂/父级-裸名.md': '---\n层级: 城镇\n上层区域: 北境\n---\n裸名字（没有双链）。\n',
  '杂/父级-无.md': '---\n层级: 村庄\n上层区域: 无\n---\n明确没有上层。\n',
  // ⑤ 被指向的目标（title 与别名）
  '地带/北境.md': '---\n层级: 区域\n别名: [北地, 北方]\n---\n区域。\n',
  // ⑥ 完全空白
  '杂/空.md': '',
};

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-noisy-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return dir;
}

async function main() {
  const vault = makeVault();
  const { index, summary } = vi.buildIndex(vault, { forceFull: true, write: false });
  const report = vi.classifyReport(index);
  const cat = (rel) => (index.files[rel] && index.files[rel].classification.category) || '(缺条目)';
  const layer = (rel) => (index.files[rel] && index.files[rel].classification.layer) || null;

  await check('一：值里的空格 / 全角空格 / wikilink / 引号都能认', () => {
    eq(layer('杂/全角.md'), 'city', '全角空格包围的「城市」');
    eq(layer('杂/链接值.md'), 'town', '层级写成 [[城镇]]');
    eq(cat('杂/引号值.md'), 'character', '单引号「主要角色」');
    return '空格/wikilink/引号 3 种写法都对';
  });

  await check('二：tags 写成井号串 / 对象 / 数字 —— 不崩，能用的就用', () => {
    eq(cat('杂/井号tags.md'), 'geo', '"#地点 #港口" 应认出地点');
    eq(layer('杂/井号tags.md'), 'location', '地点 → location');
    eq(layer('杂/对象tags.md'), 'facility', '标签是对象时靠「层级」兜住');
    eq(cat('杂/数字tags.md'), 'unknown', '标签是数字 → 待人工（不猜）');
    return '井号串=geo / 对象靠层级 / 数字=待人工';
  });

  await check('三：结构坏了 / BOM / dataview —— 条目不丢，解析失败要能看出来', () => {
    // 没有闭合的 `---`：gray-matter 不认 → 归不了类，但条目必须在
    eq(cat('杂/没有闭合.md'), 'unknown', `没有闭合 → 待人工，实际 ${cat('杂/没有闭合.md')}`);
    const bad = index.files['杂/YAML错.md'];
    assert(!!bad, 'YAML 错的文件必须仍在索引里（零丢失）');
    assert(bad.parseError, 'YAML 错要留 parseError');
    const row = report.needsHuman.find((n) => n.path === '杂/YAML错.md');
    assert(row, 'YAML 错的条目必须进待人工');
    assert(/解析失败|无法/.test((row.reasons || []).join('')), `待人工原因要说明解析失败：${JSON.stringify(row.reasons)}`);
    eq(cat('杂/BOM.md'), 'geo', 'BOM 不影响 frontmatter');
    eq(cat('杂/dataview.md'), 'geo', '正文 dataview 不干扰（tags 仍生效）');
    return '未闭合/YAML错/BOM/dataview 四种都在';
  });

  await check('四：插件产物键不改变归类', () => {
    eq(layer('杂/插件键.md'), 'planet', 'cssclasses/banner/dg-publish 不影响「层级: 行星」');
    return '插件键 4 个 → 仍是行星';
  });

  await check('五：上层三种写法 —— 带显示名双链 / 裸名 / 明确「无」', () => {
    const geo = Object.fromEntries(report.geo.map((g) => [g.path, g]));
    eq(geo['杂/父级-别名.md'].parentTitle, '北境', '[[北境|北]] 应解析到北境');
    eq(geo['杂/父级-裸名.md'].parentTitle, '北境', '裸名 北境 应解析到北境');
    eq(geo['杂/父级-无.md'].parentTitle, '', '「无」= 没有上层');
    assert(!report.needsHuman.some((n) => n.path === '杂/父级-无.md' && /不存在/.test((n.reasons || []).join(''))),
      '「无」不该被当成断链');
    return '双链/裸名都解析；「无」不误报';
  });

  await check('六：总数守恒 —— 报告条目 = 库里的笔记数（一个都不吞）', () => {
    const sum = Object.values(report.byCategory).reduce((a, b) => a + b, 0);
    eq(report.total, Object.keys(FILES).length, '报告条目数');
    eq(sum, report.total, 'Σ类目 = 总数');
    eq(summary.total, report.total, '索引数 = 报告数');
    const missing = Object.keys(FILES).filter((rel) => !index.files[rel]);
    eq(missing.length, 0, `丢失的文件：${missing.join(', ')}`);
    return `${report.total} 篇全部在报告里`;
  });

  await check('七：纯函数层不因脏输入抛错', () => {
    const dirty = [
      null, undefined, 0, '', 'x', [], {},
      { path: 'a.md', fm: null, tags: null, aliases: 3, content: 7 },
      { path: 'b.md', fm: { 层级: { nested: true } }, tags: [{ a: 1 }] },
    ];
    for (const d of dirty) {
      const c = classify.classifyNote(d, {});
      assert(c && typeof c.category === 'string', `classifyNote 在脏输入上没返回类目：${JSON.stringify(d)}`);
    }
    const r = classify.buildReport([{ path: 'x.md' }, null, {}]);
    assert(typeof r.total === 'number', 'buildReport 在脏输入上崩了');
    return `${dirty.length} 种脏输入不抛错`;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
