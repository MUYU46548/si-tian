#!/usr/bin/env node
/**
 * Node 单元测试：应用内使用手册（src/renderer/src/utils/userGuide.js）
 *
 * 为什么值得单独守：
 *   手册是**给用户的操作说明**，它错了比没有更坏（用户照着点，点不到那个按钮）。
 *   而它又天然会腐烂：工具栏改个名字、快捷键换一个字母，手册不会自己跟着变。
 *   这一层守三类：
 *     ① 结构骨架（每节 id/title/keywords/blocks 齐、id 唯一、block 类型在枚举内）；
 *     ② **可操作性**：每节至少含一条 steps 或 list（纯段落节 = 读完不知道点哪里）；
 *     ③ 搜索真能用（空查询返回全部；命中的关键词真的能搜到；乱码查询返回空）。
 *   再加一条**反向探针**：这些断言在被破坏的数据上必须真的变红（否则是空转）。
 *
 * 用法：node scripts/tests/unit/test_user_guide.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'userGuide.js');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const BLOCK_TYPES = new Set(['p', 'steps', 'list', 'key', 'warn', 'tip']);

/** 与本文件同源的骨架校验（供"反向探针"复用同一套判据 —— 判据只写一处） */
function skeletonProblems(sections) {
  const out = [];
  if (!Array.isArray(sections) || !sections.length) return ['章节数组为空'];
  const ids = new Set();
  for (const s of sections) {
    const tag = (s && s.id) || '<无 id>';
    if (!s || typeof s !== 'object') { out.push('章节不是对象'); continue; }
    if (!s.id) out.push(`${tag}: 缺 id`);
    if (ids.has(s.id)) out.push(`${tag}: id 重复`);
    ids.add(s.id);
    if (!s.title) out.push(`${tag}: 缺 title`);
    if (!Array.isArray(s.keywords) || !s.keywords.length) out.push(`${tag}: 缺 keywords（搜索不到）`);
    if (!Array.isArray(s.blocks) || !s.blocks.length) out.push(`${tag}: 缺 blocks`);
    if (!s.cite) out.push(`${tag}: 缺 cite（维护者回溯不到出处）`);
    const kinds = new Set((s.blocks || []).map((b) => b && b.t));
    for (const k of kinds) {
      if (!BLOCK_TYPES.has(k)) out.push(`${tag}: 未知 block 类型 ${k}`);
    }
    // 可操作性：纯 'p'/'warn'/'tip' 的节读完不知道去哪儿点
    if (!kinds.has('steps') && !kinds.has('list') && !kinds.has('key')) {
      out.push(`${tag}: 没有任何可照做的内容（steps / list / key 至少要有一个）`);
    }
    for (const b of (s.blocks || [])) {
      if (!b || b.v === undefined || b.v === null || b.v === '') out.push(`${tag}: 有空的 block 内容`);
      if ((b.t === 'steps' || b.t === 'list') && !Array.isArray(b.v)) out.push(`${tag}: ${b.t} 的 v 必须是数组`);
      if (b.t === 'key' && !Array.isArray(b.v)) out.push(`${tag}: key 的 v 必须是 [键, 说明] 数组`);
    }
  }
  return out;
}

async function main() {
  let mod = null;
  await check('模块可加载且导出 GUIDE_SECTIONS / searchGuide / guideStats', async () => {
    mod = await import(pathToFileURL(SRC).href);
    assert(Array.isArray(mod.GUIDE_SECTIONS), 'GUIDE_SECTIONS 不是数组');
    assert(typeof mod.searchGuide === 'function', 'searchGuide 不是函数');
    assert(typeof mod.guideStats === 'function', 'guideStats 不是函数');
    return `${mod.GUIDE_SECTIONS.length} 节`;
  });
  if (!mod) { report(); return; }
  const { GUIDE_SECTIONS, searchGuide, guideStats } = mod;

  await check('章节骨架完整（id/title/keywords/blocks/cite 齐、类型合法、每节可照做）', () => {
    const bad = skeletonProblems(GUIDE_SECTIONS);
    assert(bad.length === 0, bad.join('；'));
    const st = guideStats();
    assert(st.sections === GUIDE_SECTIONS.length, 'guideStats.sections 与数组长度不一致');
    assert(st.keywords > 40, `关键词太少（${st.keywords}）—— 搜不到的章节等于不存在`);
    return `${st.sections} 节 / ${st.keywords} 个关键词`;
  });

  await check('搜索：空查询=全部、关键词命中、乱码=空、跨节同词能全给出', () => {
    assert(searchGuide('').length === GUIDE_SECTIONS.length, '空查询必须返回全部（手册顺序 = 推荐阅读顺序）');
    assert(searchGuide('   ').length === GUIDE_SECTIONS.length, '空白查询等同空查询');
    const hit = searchGuide('铺底');
    assert(hit.length >= 1 && hit.some((s) => s.id === 'province-batch'), `搜「铺底」应命中批量铺底节：${hit.map((s) => s.id)}`);
    assert(searchGuide('快照').some((s) => s.id === 'save-safety'), '搜「快照」应命中数据安全节');
    assert(searchGuide('zzzz-not-a-word').length === 0, '乱码查询应返回空');
    // 多词是 AND：命中的节必须两个词都在
    const and = searchGuide('省份 撤销');
    assert(and.every((s) => {
      const hay = (s.title + ' ' + s.keywords.join(' ') + ' ' + JSON.stringify(s.blocks)).toLowerCase();
      return hay.includes('省份') && hay.includes('撤销');
    }), '多词查询必须是 AND 语义');
    return `「铺底」→${hit.length} 节`;
  });

  await check('关键操作在场：批量铺底 / 折线切割 / 顶点压叠 / 清空剧本 / 只读 / 快捷键', () => {
    const ids = GUIDE_SECTIONS.map((s) => s.id);
    for (const want of ['province-batch', 'province-poly', 'ownership', 'vertex', 'scenario-cleanup', 'save-safety', 'size', 'faq', 'keys', 'start-here']) {
      assert(ids.includes(want), `缺少章节 ${want}`);
    }
    const all = JSON.stringify(GUIDE_SECTIONS);
    // 这些是 0.2.4 之后用户最常问的几件事，手册必须正面回答（不靠"看仓库文档"）
    for (const tok of ['一键切分', '折线切割', '压叠', '清空全部剧本', '只读', 'Ctrl+Z', '快照', '描轮廓', '重建省份外环']) {
      assert(all.includes(tok), `手册里没有提到「${tok}」`);
    }
    return `10 个必备章节 + 8 个必备词在场`;
  });

  await check('手册里不许出现真实项目/隔壁项目的专名（示例一律虚构）', () => {
    // 产品是面向公开的（README 也这么写），手册又是**随包发布**的文案 ——
    // 把暮雨自己的项目名、隔壁「绒花墨坊」的名字写进示例，等于把私人素材塞进公开包。
    // 这一条与 test_86（fixture 专名）同一性质：**白名单/黑名单都得有人守**，否则改文案时必然漂回来。
    const all = JSON.stringify(GUIDE_SECTIONS);
    const forbidden = ['绒花计划', '绒花墨坊', '德斯特星', '瓯王朝', '乐园星'];
    const hit = forbidden.filter((w) => all.includes(w));
    assert(hit.length === 0, `手册示例里出现真实专名：${hit.join('、')}（请换成虚构示例，如「示例世界」）`);
    return `${forbidden.length} 个专名一个都没出现`;
  });

  await check('反向探针：骨架校验对坏数据必须变红（否则本文件是空转）', () => {
    const good = [{ id: 'a', title: 'A', keywords: ['k'], cite: 'x', blocks: [{ t: 'p', v: '正文' }, { t: 'list', v: ['一条'] }] }];
    assert(skeletonProblems(good).length === 0, '合法样本不该报问题');
    const cases = [
      [{ ...good[0], id: '' }, '缺 id'],
      [{ ...good[0], keywords: [] }, '缺 keywords'],
      [{ ...good[0], cite: '' }, '缺 cite'],
      [{ ...good[0], blocks: [{ t: 'p', v: '只有段落' }] }, '不可照做'],
      [{ ...good[0], blocks: [{ t: 'nope', v: 'x' }] }, '未知类型'],
      [{ ...good[0], blocks: [{ t: 'steps', v: '不是数组' }] }, '类型不对'],
      [[...good, ...good], 'id 重复'],
    ];
    for (const [data, label] of cases) {
      assert(skeletonProblems(data).length > 0, `反向探针失败：${label} 没被报出`);
    }
    return `${cases.length} 种坏数据都被抓到`;
  });

  report();
}

function report() {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
