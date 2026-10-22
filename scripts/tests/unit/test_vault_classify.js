#!/usr/bin/env node
/**
 * Node 单测：读料桥的启发归类 / 空间推断 / 零静默丢失（2026-10-22，三刀序列·第二刀）
 *
 * 判据（施工单任务二）：
 *   ① 字段识别不靠白名单：整份 frontmatter（层级/类型/类别/组织类型/归属大类/书名…）参与归类；
 *   ② 不挑目录结构：任意路径/文件名都能产出条目（标准目录缺失时全库扫描）；
 *   ③ 识别不了的**每条都有报告**（路径 + 为什么 + 凭据），总数守恒（total = Σ各类目）；
 *   ④ 空间关系逐级推断：显式字段 → 正文双链 → 正文句式；推断的标 inferred，找不到的进待人工，
 *      **不造名字、不把没解析到的父级当成事实**；
 *   ⑤ 只读：`buildIndex({write:false})` 不在库里建 `.sitian`、不改任何笔记（文件数+mtime 快照对比）；
 *   ⑥ 结构目录优先于 frontmatter（`99 模板/世界模板.md` 写着「层级: 世界」也还是模板）。
 *
 * 用法：node scripts/tests/unit/test_vault_classify.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));
const classify = require(path.join(ROOT, 'scripts', 'lib', 'vaultClassify.js'));
const { extractGeodata, normalizeId } = require(path.join(ROOT, 'scripts', 'extract-data.js'));

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
  '世界/潮汐界.md': '---\n层级: 世界\n---\n世界的中心。\n',
  '区域/北境.md': '---\n层级: 区域\n上层区域: "[[潮汐界]]"\n---\n北境。\n',
  '城/风岬港.md': '---\n层级: 城市\n---\n位于北境的海港。\n',
  '城/桥头镇.md': '---\n层级: 城镇\n---\n与 [[北境]] 相连。\n',
  '城/孤港.md': '---\n层级: 城市\n---\n一座孤港，没有写它在哪。\n',
  '城/断链城.md': '---\n层级: 城市\n上层区域: "[[不存在的地方]]"\n---\n断链。\n',
  '杂/没有线索.md': '只有一段话，没有任何可用的字段。\n',
  '杂/深林.md': '---\ntags: [森林]\n---\n林子。\n',
  '人物/艾琳.md': '---\ntags: [人物]\n---\n她是灯塔守。\n',
  '组织/灰塔议会.md': '---\n组织类型: 组织机构\n---\n控制船运。\n',
  '物品/灰塔徽记.md': '---\n类别: 遗物\n---\n信物。\n',
  '事件/灰塔之变.md': '---\n层级: 事件\n---\n那一年分裂了。\n',
  '资料收藏/剪报.md': '> 一段剪报。\n',
  '99 模板/世界模板.md': '---\n层级: 世界\n---\n模板示例。\n',
};

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-classify-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return dir;
}

function snapshot(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.sitian') { out.push(['.sitian', 0, 0]); continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push([path.relative(root, full).replace(/\\/g, '/'), fs.statSync(full).size, Math.round(fs.statSync(full).mtimeMs)]);
    }
  })(root);
  out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(out);
}

async function main() {
  const vault = makeVault();
  const before = snapshot(vault);
  const { index, summary } = vi.buildIndex(vault, { forceFull: true, write: false });
  const report = vi.classifyReport(index);
  const entry = (rel) => index.files[rel];

  await check('一：整份 frontmatter 参与归类（层级/类型/类别/组织类型 + 标签 + 目录）', () => {
    eq(entry('区域/北境.md').classification.category, 'geo', '层级=区域 → geo');
    eq(entry('区域/北境.md').classification.layer, 'region', '层级=区域 → layer');
    eq(entry('事件/灰塔之变.md').classification.category, 'event', '层级=事件 → event（不是地点）');
    eq(entry('物品/灰塔徽记.md').classification.category, 'item', '类别=遗物 → item');
    eq(entry('组织/灰塔议会.md').classification.category, 'organization', '组织类型 → organization');
    eq(entry('人物/艾琳.md').classification.category, 'character', 'tags=[人物] → character');
    eq(entry('杂/深林.md').classification.category, 'geo', 'tags=[森林] → geo');
    eq(entry('杂/深林.md').classification.layer, 'location', '森林 → location（后缀/标签）');
    eq(entry('资料收藏/剪报.md').classification.category, 'reference', '资料收藏目录 → reference');
    assert(entry('区域/北境.md').classification.evidence.length > 0, '必须留「凭什么这么判」的证据');
    return '8 类信号各命中；证据非空';
  });

  await check('二：结构目录优先于 frontmatter（模板里的「层级: 世界」不是世界）', () => {
    eq(entry('99 模板/世界模板.md').classification.category, 'meta', '模板目录 → meta');
    eq(entry('99 模板/世界模板.md').classification.layer, null, '模板不应产出 layer');
    return '99 模板/世界模板.md → meta';
  });

  await check('三：识别不了的每条都有报告；总数守恒（零静默丢失）', () => {
    const unknown = report.needsHuman.filter((n) => n.category === 'unknown');
    assert(unknown.some((n) => n.path === '杂/没有线索.md'), '无信号笔记应进待人工');
    const row = unknown.find((n) => n.path === '杂/没有线索.md');
    assert(row.reasons.length > 0, '待人工必须写原因');
    const sum = Object.values(report.byCategory).reduce((a, b) => a + b, 0);
    eq(sum, report.total, 'Σ各类目 = 总数');
    eq(report.total, summary.total, '报告总数 = 索引条目数');
    eq(report.total, Object.keys(FILES).length, '报告总数 = 写进库的笔记数');
    return `待人工 ${report.needsHuman.length} 条；总数 ${report.total} 守恒`;
  });

  await check('四：空间关系 —— 显式字段 / 正文句式 / 双链三档，推断与事实分开', () => {
    const geo = Object.fromEntries(report.geo.map((g) => [g.path, g]));
    eq(geo['区域/北境.md'].parentTitle, '潮汐界', '显式上层');
    eq(geo['区域/北境.md'].parentInferred, false, '显式上层不算推断');
    eq(geo['城/风岬港.md'].parentTitle, '北境', '正文「位于北境的海港」');
    eq(geo['城/风岬港.md'].parentInferred, true, '正文推断必须标记');
    eq(geo['城/风岬港.md'].signal, 'text', '推断信号 = text');
    eq(geo['城/桥头镇.md'].parentTitle, '北境', '正文双链');
    eq(geo['城/桥头镇.md'].parentInferred, true, '双链推断必须标记');
    eq(geo['城/桥头镇.md'].signal, 'wikilink', '推断信号 = wikilink');
    // 找不到上层 → 待人工，不硬塞一个
    eq(geo['城/孤港.md'].parentTitle, '', '孤港不该被猜出上层');
    assert(report.needsHuman.some((n) => n.path === '城/孤港.md' && /上层/.test((n.reasons || []).join(''))),
      '孤港应进「找不到上层」待人工');
    // 指了不存在的地方 → 点名断链，不是静默丢
    const broken = report.needsHuman.find((n) => n.path === '城/断链城.md');
    assert(broken && /不存在的地方/.test(broken.reasons.join('')), `断链父级要点名：${JSON.stringify(broken)}`);
    // 世界是根，不该被要求有上层
    assert(!report.needsHuman.some((n) => n.path === '世界/潮汐界.md'), '世界不该进「找不到上层」');
    return '显式 1 / 句式 1 / 双链 1 / 待人工 2（孤港+断链）';
  });

  await check('五：只读 —— 不建 .sitian、不改任何笔记（快照逐字节一致）', () => {
    const after = snapshot(vault);
    eq(after, before, '库快照');
    assert(!fs.existsSync(path.join(vault, '.sitian')), '只读模式不应创建 .sitian');
    return `${Object.keys(FILES).length} 篇未改动；无 .sitian`;
  });

  await check('六：通用提取 —— 只把 geo 变成节点，非地理留在报告里；父级推断进节点', async () => {
    const data = await extractGeodata(vault, { generic: true, writeCache: false, forceFull: true, collectReport: true });
    eq(data.nodeCount, report.geo.length, '节点数 = 报告地理实体数');
    const byName = Object.fromEntries(data.nodes.map((n) => [n.name, n]));
    eq(byName['风岬港'].parentId, normalizeId('北境'), '推断父级进 parentId');
    assert(byName['风岬港'].parentInferred === true, '节点上要标 parentInferred（别把推断当事实）');
    eq(byName['孤港'].parentId, null, '没线索的父级必须为空');
    assert(!byName['艾琳'] && !byName['灰塔议会'] && !byName['剪报'], '人物/组织/资料收藏不该进地图节点');
    assert(data.report && data.report.generic, '必须带回通用扫描报告');
    eq(data.report.generic.byCategory.character, 1, '报告里能查到人物 1 篇');
    assert(data.report.generic.needsHuman >= 2, '报告里要带待人工数');
    assert(!fs.existsSync(path.join(vault, '.sitian')), '提取只读（writeCache:false）也不该建 .sitian');
    return `节点 ${data.nodeCount} / 人物留在报告 / 无 .sitian`;
  });

  await check('七：不挑目录结构 —— 没有标准目录时自动走全库扫描（结果与 generic 一致）', async () => {
    const auto = await extractGeodata(vault, { writeCache: false, forceFull: true });
    eq(auto.nodeCount, report.geo.length, '自动回退的节点数应与 generic 一致');
    return `自动回退 ${auto.nodeCount} 个节点`;
  });

  await check('八：确定性 —— 同一份库跑两次，报告逐字节相同', () => {
    const a = JSON.stringify(vi.classifyReport(index));
    const b = JSON.stringify(vi.classifyReport(index));
    eq(a, b, '两次报告');
    return `${a.length} 字节一致`;
  });

  await check('九：输出目录守卫 —— 不许往库里写报告', () => {
    let threw = false;
    try { classify.assertOutOutsideVault(path.join(vault, '报告'), vault); } catch (e) { threw = true; }
    assert(threw, '库内输出目录应抛错');
    assert(classify.assertOutOutsideVault(path.join(os.tmpdir(), 'x-scan'), vault) === true, '库外应通过');
    return '库内拒绝 / 库外通过';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
