#!/usr/bin/env node
/**
 * Node 单元测试：实体叙事状态（src/renderer/src/utils/entityStatus.js）
 *
 * 为什么要有这一层：用户决策（2026-09-24）—— **毁灭只是叙事状态，不是数据删除**。
 * 状态判错的后果是**叙事事故**而不是报错：把"已毁灭"当成"不存在"就会让历史地图/剧本失去挂靠，
 * 把脏值当成"已毁灭"会让一颗正常星球在画布上莫名其妙变灰。
 * 该模块无 DOM / 无 store 依赖，正好放 Node 层跑真实断言。
 *
 * 用法：node scripts/tests/unit/test_entity_status.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'entityStatus.js');

const results = [];
// 支持 async 用例（提取端到端需要真跑一遍 extractGeodata）→ 调用处必须 await
async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: (await fn()) || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function count(hay, needle) { return hay.split(needle).length - 1; }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { DEFAULT_STATUS, ENTITY_STATUSES, isKnownStatus, resolveStatus, statusMeta, isFaded, statusBadge, statusOptions, FADED_ALPHA, fadedAlpha } = mod;

  // ── 1. 注册表自洽 ────────────────────────────────────────────────────────
  await check('注册表自洽：id 唯一、字段齐备、默认值在表内', () => {
    const ids = ENTITY_STATUSES.map(s => s.id);
    eq(new Set(ids).size, ids.length, 'id 有重复');
    for (const s of ENTITY_STATUSES) {
      assert(s.id && s.label && s.hint, `状态 ${s.id} 缺字段`);
      eq(typeof s.faded, 'boolean', `${s.id}.faded 应是布尔`);
    }
    assert(ids.includes(DEFAULT_STATUS), `默认状态 ${DEFAULT_STATUS} 不在注册表里`);
    return `${ids.length} 个状态`;
  });

  // ── 2. resolveStatus：脏数据一律回落 active（★ 安全默认） ────────────────
  await check('resolveStatus：合法值原样；空 / 未知 / 非字符串一律回落 active', () => {
    eq(resolveStatus('destroyed'), 'destroyed', '合法值');
    eq(resolveStatus('active'), 'active', 'active');
    eq(resolveStatus(''), DEFAULT_STATUS, '空串');
    eq(resolveStatus(null), DEFAULT_STATUS, 'null');
    eq(resolveStatus(undefined), DEFAULT_STATUS, 'undefined');
    eq(resolveStatus('已毁灭'), DEFAULT_STATUS, '中文标签不是 id');
    eq(resolveStatus(123), DEFAULT_STATUS, '数字');
    eq(resolveStatus({}), DEFAULT_STATUS, '对象');
    eq(resolveStatus('nonsense'), DEFAULT_STATUS, '未知 id');
  });

  // ── 3. 「已毁灭」类状态必须淡化；但**只是淡化**（数据仍完整） ─────────────
  await check('isFaded：destroyed / ruined / sealed / lost 淡化；active / unknown 不淡化', () => {
    eq(isFaded('active'), false, 'active');
    eq(isFaded('unknown'), false, 'unknown（尚未确定 ≠ 已消失）');
    eq(isFaded('destroyed'), true, 'destroyed');
    eq(isFaded('ruined'), true, 'ruined');
    eq(isFaded('sealed'), true, 'sealed');
    eq(isFaded('lost'), true, 'lost');
    eq(isFaded(''), false, '空值 → active → 不淡化');
  });

  // ── 4. 徽标：正常状态不该有徽标（否则满屏噪音） ──────────────────────────
  await check('statusBadge：active 返回空串（满屏"存在"是噪音）；其余有短标签', () => {
    eq(statusBadge('active'), '', 'active 无徽标');
    eq(statusBadge(''), '', '空值无徽标');
    assert(statusBadge('destroyed').length > 0, 'destroyed 应有徽标');
    assert(statusBadge('destroyed').length <= 4, '徽标应短（≤4 字）');
  });

  // ── 5. statusMeta 永远返回对象（调用方不必写空值分支） ───────────────────
  await check('statusMeta：任何输入都返回一个带 label 的对象', () => {
    for (const v of ['destroyed', '', null, undefined, 'nonsense']) {
      const m = statusMeta(v);
      assert(m && typeof m.label === 'string' && m.label.length > 0, `statusMeta(${JSON.stringify(v)}) 未返回有效对象`);
    }
    eq(statusMeta('destroyed').label, '已毁灭', 'destroyed 的标签');
    eq(statusMeta('nonsense').id, DEFAULT_STATUS, '未知值回落默认');
  });

  // ── 6. isKnownStatus ─────────────────────────────────────────────────────
  await check('isKnownStatus：区分合法与脏值', () => {
    eq(isKnownStatus('destroyed'), true, '合法');
    eq(isKnownStatus('active'), true, 'active');
    eq(isKnownStatus('nope'), false, '未知');
    eq(isKnownStatus(''), false, '空');
  });

  // ── 7. statusOptions 供 UI 下拉用 ────────────────────────────────────────
  await check('statusOptions：与注册表等长、每项含 id/label/hint', () => {
    const opts = statusOptions();
    eq(opts.length, ENTITY_STATUSES.length, '数量与注册表一致');
    for (const o of opts) assert(o.id && o.label, `选项缺字段：${JSON.stringify(o)}`);
  });

  // ── 8. fadedAlpha：画布上到底该用多少不透明度 ────────────────────────────
  await check('fadedAlpha：淡化状态返回 FADED_ALPHA；focused 优先；其余返回 1', () => {
    eq(fadedAlpha('active'), 1, 'active 不淡化');
    eq(fadedAlpha('unknown'), 1, 'unknown（尚未确定 ≠ 已消失）不淡化');
    eq(fadedAlpha('destroyed'), FADED_ALPHA, 'destroyed 淡化');
    eq(fadedAlpha('ruined'), FADED_ALPHA, 'ruined 淡化');
    eq(fadedAlpha('destroyed', { focused: true }), 1, 'focused 优先于淡化（你正在看它 → 编辑优先于装饰）');
    eq(fadedAlpha('nonsense'), 1, '脏值回落 active → 不淡化（绝不能误伤正常实体）');
    eq(fadedAlpha(null), 1, 'null 不淡化');
    assert(FADED_ALPHA > 0.25 && FADED_ALPHA < 0.7,
      `FADED_ALPHA=${FADED_ALPHA} 应在"看得出退后、但仍读得清"的区间（过低会被当成数据丢失）`);
  });

  // ── 9. ★ 画布接线守卫：绘制入口必须真的调用 fadedAlpha，且 save/restore 成对 ──
  // 这一条是防"功能做了但没接上"：淡化只在画布上生效，任何一处漏掉，
  // 那个视图就会静默地永远不淡化（用户以为功能没做，或被标了"已毁灭"的实体看起来还活着）。
  await check('★ 画布淡化接线：各绘制入口调用 fadedAlpha，save/restore 成对', () => {
    const SITES = [
      { file: 'src/renderer/src/composables/planetDrawing.js', fns: ['drawPlaces'], save: 1, restore: 1 },
      // GalaxyMap 多一个 restore：lod 分支有一个**中途 return**，save 后必须先收尾
      { file: 'src/renderer/src/components/GalaxyMap.vue', fns: ['drawGalaxyNodes'], save: 1, restore: 2 },
      { file: 'src/renderer/src/components/SystemView.vue', fns: ['drawSystemStar', 'drawSystemPlanets'], save: 2, restore: 2 },
      { file: 'src/renderer/src/components/SystemDetailView.vue', fns: ['drawStar', 'drawPlanets'], save: 2, restore: 2 },
      { file: 'src/renderer/src/components/AreaMap.vue', fns: ['drawNodes'], save: 1, restore: 1 },
    ];
    const SAVE = 'if (fade < 1) { ctx.save(); ctx.globalAlpha = fade; }';
    const RESTORE = 'if (fade < 1) ctx.restore();';
    for (const site of SITES) {
      const src = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
      assert(src.includes('fadedAlpha'), `${site.file} 未引入 fadedAlpha`);
      for (const fn of site.fns) {
        assert(new RegExp('function\\s+' + fn + '\\s*\\(').test(src), `${site.file} 找不到绘制函数 ${fn}()`);
      }
      eq(count(src, SAVE), site.save, `${site.file} 的淡化 save 数`);
      eq(count(src, RESTORE), site.restore, `${site.file} 的淡化 restore 数（必须与 save 配对，否则 alpha 会泄漏）`);
    }
    return `${SITES.length} 个视图 / ${SITES.reduce((a, s) => a + s.fns.length, 0)} 个绘制入口`;
  });

  // ── 10. ★ 重绘信号接线：状态改了必须能触发画布重绘 ────────────────────────
  // 根因：`store.updateNode` 是 `Object.assign(node, …)` **就地改字段** —— 不换数组引用、
  // 不换节点对象，所有基于引用的浅 watch 全都捕捉不到 → 状态改了画布不刷新（= 功能等于没做）。
  // 解法：store 提供单调递增的 `statusRevision`，各画布 watch 它。这里守住这条接线。
  await check('★ 重绘信号接线：store 递增 ++ 各画布 watch', () => {
    const geo = fs.readFileSync(path.join(ROOT, 'src/renderer/src/store/geodata.js'), 'utf8');
    assert(geo.includes('const statusRevision = ref(0)'), 'geodata.js 缺少 statusRevision');
    assert(geo.includes('statusRevision,'), 'statusRevision 未导出（画布拿不到）');
    // undo / redo 都必须递增 —— 否则"撤销后淡化不还原"
    eq(count(geo, 'bumpStatus();'), 2, 'updateNode 的 undo/redo 应各递增一次');
    const CANVASES = [
      'src/renderer/src/components/GalaxyMap.vue',
      'src/renderer/src/components/SystemView.vue',
      'src/renderer/src/components/SystemDetailView.vue',
      'src/renderer/src/components/AreaMap.vue',
      'src/renderer/src/components/PlanetMap.vue',
    ];
    for (const f of CANVASES) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert(src.includes('statusRevision'), `${f} 未接线 statusRevision —— 状态改了画布不会重绘`);
    }
    return `${CANVASES.length} 个画布已接线`;
  });

  // ── 11. ★ 提取侧一致性：两处 CJS 副本必须与前端注册表同步 ────────────────
  // 为什么守：`status` 是**笔记侧字段**，用户写在 frontmatter 里、由提取脚本读进节点。
  // 别名表一旦漂移，用户在 Obsidian 里写「已毁灭」就会静默失效（节点仍是 active）——
  // 不报错、只是不生效，是最难发现的一类坏。
  await check('★ 提取侧一致性：extract-data / vault-watcher 的别名表与 entityStatus 对齐', () => {
    const extract = require(path.join(ROOT, 'scripts', 'extract-data.js'));
    const watcher = require(path.join(ROOT, 'src', 'main', 'vault-watcher.js'));
    assert(extract.STATUS_ALIASES && watcher.STATUS_ALIASES, 'CJS 侧未导出 STATUS_ALIASES（无法守卫）');
    const ids = new Set(ENTITY_STATUSES.map(s => s.id));
    // 正向：每个状态的 id / label / short 都必须映射到它自己
    for (const st of ENTITY_STATUSES) {
      for (const key of [st.id, st.label, st.short].filter(Boolean)) {
        eq(extract.STATUS_ALIASES[key], st.id, `extract-data 的别名「${key}」`);
        eq(watcher.STATUS_ALIASES[key], st.id, `vault-watcher 的别名「${key}」`);
      }
    }
    // 反向：别名表不许指向未知 id
    for (const [k, v] of Object.entries(extract.STATUS_ALIASES)) {
      assert(ids.has(v), `extract-data 别名「${k}」指向未知状态 ${v}`);
    }
    // 两处副本逐项相同（照 normalizeId 的既有做法：复制 + 测试守卫，不强行共享模块）
    eq(Object.keys(extract.STATUS_ALIASES).sort().join(','),
      Object.keys(watcher.STATUS_ALIASES).sort().join(','),
      '两处 CJS 别名表的键不一致');
    return `${Object.keys(extract.STATUS_ALIASES).length} 个别名 × 2 处副本`;
  });

  // ── 12. readFrontmatterStatus 行为 ──────────────────────────────────────
  await check('readFrontmatterStatus：id / 中文 label / 短标签都认；认不出则不写字段', () => {
    const { readFrontmatterStatus } = require(path.join(ROOT, 'scripts', 'extract-data.js'));
    eq(readFrontmatterStatus({ status: 'destroyed' }), 'destroyed', '机器 id');
    eq(readFrontmatterStatus({ status: '已毁灭' }), 'destroyed', '中文 label');
    eq(readFrontmatterStatus({ status: '毁灭' }), 'destroyed', '短标签');
    eq(readFrontmatterStatus({ 状态: '已荒废' }), 'ruined', '中文键 状态');
    eq(readFrontmatterStatus({ status: '  lost  ' }), 'lost', '两侧空白要 trim');
    eq(readFrontmatterStatus({ status: 'active' }), null, 'active → 不写字段（与没写等价）');
    eq(readFrontmatterStatus({ status: '存在' }), null, '存在 → 不写字段');
    eq(readFrontmatterStatus({ status: 'nonsense' }), null, '脏值 → 不写字段（不许把脏值长期留在项目文件里）');
    eq(readFrontmatterStatus({ status: '' }), null, '空串');
    eq(readFrontmatterStatus({ status: 0 }), null, '数字 0');
    eq(readFrontmatterStatus({}), null, '没有该字段');
    eq(readFrontmatterStatus(null), null, 'fm 为 null');
    eq(readFrontmatterStatus(undefined), null, 'fm 为 undefined');
  });

  // ── 13. ★ 真实提取端到端：笔记 frontmatter → 节点.status ─────────────────
  await check('★ 真实提取端到端：frontmatter 的 status 落到节点上（临时 vault 真跑一次）', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-status-'));
    const origLog = console.log;
    try {
      await fsp.mkdir(path.join(tmp, '01 索引'), { recursive: true });
      await fsp.writeFile(path.join(tmp, '01 索引', '地理系统索引.md'), '# 世界索引\n\n', 'utf-8');
      const geoDir = path.join(tmp, '03 设定', '11 地理系统');
      await fsp.mkdir(geoDir, { recursive: true });
      await fsp.writeFile(path.join(geoDir, '测试星域.md'),
        '---\n层级: 星域\nstatus: destroyed\n---\n\n正文\n', 'utf-8');
      const locDir = path.join(tmp, '03 设定', '02 场景地点');
      await fsp.mkdir(locDir, { recursive: true });
      await fsp.writeFile(path.join(locDir, '测试城.md'),
        '---\n层级: 城市\n状态: 已荒废\n---\n\n正文\n', 'utf-8');
      await fsp.writeFile(path.join(locDir, '普通城.md'),
        '---\n层级: 城市\n---\n\n正文\n', 'utf-8');

      const { extractGeodata } = require(path.join(ROOT, 'scripts', 'extract-data.js'));
      console.log = () => {};   // 提取过程会打印进度，测试输出里不需要
      const data = await extractGeodata(tmp, { forceFull: true });
      console.log = origLog;

      const byName = new Map(data.nodes.map(n => [n.name, n]));
      assert(byName.has('测试星域'), '未提取到 测试星域（fixture 结构不对？）');
      assert(byName.has('测试城'), '未提取到 测试城');
      eq(byName.get('测试星域').status, 'destroyed', 'status: destroyed');
      eq(byName.get('测试城').status, 'ruined', '中文键 状态: 已荒废');
      eq(byName.get('普通城').status, null, '没写 status → null（视作未设置，与 placeType 同一风格）');
      // 顺带确认没把既有字段挤掉（本文件的另一次事故：字段构造写漏）
      assert(byName.get('测试星域').coordinate, '节点仍应带 coordinate');
      return `${data.nodes.length} 个节点，status 正确落盘`;
    } finally {
      console.log = origLog;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  const failed = results.filter(r => !r.ok);
  console.log('=== 实体叙事状态（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
