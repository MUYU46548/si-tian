#!/usr/bin/env node
/**
 * Node 单元测试：跨剧本集“只读总览”（A3，2026-11-05）
 *
 * 为什么要守：总览的价值全在**边界**上 —— 一旦别组剧本被当成"可以点的"，用户就会在
 * 不知情的时候把当前编辑目标换掉（改了 A 时间线的剧本，以为还在 B）。这种错不会报错，
 * 只会"数据变了但没人知道是哪次点的"。
 *
 * 用法：node scripts/tests/unit/test_scenario_group_overview.js
 * 退出码：0 = 全通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

async function loadUtil() {
  const src = read('src/renderer/src/utils/scenarioGroups.js');
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
  return import(url);
}

function scen(id, group, extra) {
  return { id, name: id, group, era: { roman: '', startYear: '100', endYear: '200' }, polities: [], ownership: {}, ...(extra || {}) };
}

async function main() {
  const U = await loadUtil();
  const { scenarioOverviewRows, scenarioMetaText } = U;

  check('a1 摘要文案：势力数 + **真有归属**的省数（空值/无主不算）', () => {
    const s = scen('s1', 'g1', {
      polities: [{ id: 'A' }, { id: 'B' }],
      ownership: { p1: 'A', p2: 'A', p3: '' },
    });
    eq(scenarioMetaText(s), '2 势力 · 2 省', '两势力、两省真有主');
    eq(scenarioMetaText({}), '0 势力 · 0 省', '空剧本不炸');
    return '空值不计入';
  });

  check('a2 分组：每组一行，**当前组排第一**', () => {
    const list = [scen('a', 'g1'), scen('b', 'g2'), scen('c', 'g1')];
    const rows = scenarioOverviewRows(list, [{ id: 'g1', name: '第一集', order: 1 }, { id: 'g2', name: '第二集', order: 2 }], 'g2');
    eq(rows.length, 2, '两组');
    eq(rows[0].id, 'g2', '当前组排第一');
    eq(rows[0].isActive, true, '当前组标记');
    eq(rows[1].id, 'g1', '别的组在后');
    return '2 组 / 当前组在前';
  });

  check('a3 🔴 别组的剧本是只读的（当前组不是）', () => {
    const list = [scen('a', 'g1'), scen('b', 'g2')];
    const rows = scenarioOverviewRows(list, [], 'g1');
    const cur = rows.find((r) => r.id === 'g1');
    const oth = rows.find((r) => r.id === 'g2');
    eq(cur.scenarios[0].readonly, false, '当前组可点');
    eq(oth.scenarios[0].readonly, true, '别组只读');
    return 'readonly 标记';
  });

  check('a4 空组不出现（总览不是组管理表）', () => {
    const list = [scen('a', 'g1')];
    const rows = scenarioOverviewRows(list, [{ id: 'g1', name: '一', order: 1 }, { id: 'g2', name: '空组', order: 2 }], 'g1');
    eq(rows.length, 1, '空组不该占一行');
    eq(rows[0].id, 'g1', '只剩有剧本的组');
    return '1 行';
  });

  check('a5 组内顺序保持入参顺序（调用方已按 order 排好）', () => {
    const list = [scen('z', 'g1'), scen('a', 'g1'), scen('m', 'g1')];
    const rows = scenarioOverviewRows(list, [], 'g1');
    eq(rows[0].scenarios.map((s) => s.id).join(','), 'z,a,m', '不容许在这里重排');
    return 'z,a,m';
  });

  check('a6 组名：默认组叫“默认”，有名字用名字，缺 id 回 id', () => {
    const list = [scen('a', undefined), scen('b', 'ghost')];
    const rows = scenarioOverviewRows(list, [{ id: 'g1', name: '有名', order: 1 }], 'default');
    const def = rows.find((r) => r.id === 'default');
    const ghost = rows.find((r) => r.id === 'ghost');
    eq(def.name, '默认', '默认组');
    eq(ghost.name, 'ghost', '组表里没有 → 回 id（绝不空串）');
    return '默认 / 回 id';
  });

  check('a7 activeGroupId 指向组表里没有的组（孤儿）→ 照样排第一且 isActive', () => {
    const list = [scen('a', 'g1'), scen('b', 'orphan')];
    const rows = scenarioOverviewRows(list, [{ id: 'g1', name: '一', order: 1 }], 'orphan');
    eq(rows[0].id, 'orphan', '孤儿组排第一');
    eq(rows[0].isActive, true, '标成当前');
    eq(rows[0].scenarios[0].readonly, false, '它自己的剧本不是只读');
    return '孤儿组不消失';
  });

  // ── 源码契约（组件/接线）────────────────────────────────────────────────
  const vue = read('src/renderer/src/components/ScenarioGroupOverview.vue');
  const map = read('src/renderer/src/components/ScenarioMap.vue');
  // 2026-11-06：左侧剧本列表（含“看全部”总览）拆成 ScenarioListPanel.vue —— 显示契约在这里，
  // 接线契约仍在 ScenarioMap（开关 ref / 切组 / 传全部剧本）。
  const panel = read('src/renderer/src/scenario/panels/ScenarioListPanel.vue');

  check('b1 🔴 点别组剧本：只给回执，**绝不 emit select**（不然会悄悄换掉编辑目标）', () => {
    const at = vue.indexOf('function onClick(row, s) {');
    assert(at >= 0, '找不到 onClick');
    const body = vue.slice(at, at + 700);
    assert(body.includes('if (!s.readonly)'), '没按 readonly 分流');
    assert(/emit\('select', s\)/.test(body), '当前组应当能真的切过去');
    // 别组分支里只能有 msg，不能有 select
    const roAt = body.indexOf('emit(\'msg\'');
    assert(roAt > 0, '别组没有可读回执');
    const tail = body.slice(roAt);
    assert(!tail.includes("emit('select'"), '只读分支里还在 emit select（会切走）');
    return 'readonly → 只回执';
  });

  check('b2 组件不碰 store / 不改数据（只 emit 三个事件）', () => {
    assert(!/useGeodataStore|store\./.test(vue), '总览组件里直接用了 store（应只 emit 给父级）');
    for (const ev of ['select', 'switch-group', 'msg']) {
      assert(vue.includes(`'${ev}'`), `defineEmits 缺 ${ev}`);
    }
    return '3 个 emit / 零 store';
  });

  check('b3 总览与当前组列表**二选一**（不许两个世界同时显示；显示归面板，接线归 ScenarioMap）', () => {
    assert(map.includes('const showGroupOverview = ref(false)'), '没有总览开关');
    assert(panel.includes('<ScenarioGroupOverview v-if="overview"'), '没挂总览组件');
    assert(/<template v-else>\s*\n\s*<div v-if="!shown\.length"/.test(panel),
      '总览打开时当前组列表没有让位（v-else 包裹缺失）');
    assert(panel.includes(':scenarios="scenarios"'), '总览吃的是当前组（应吃全部剧本）');
    assert(map.includes(':scenarios="allSortedScenarios"'), '没把全部剧本传给面板（总览会只看到当前组）');
    assert(map.includes('@switch-group="switchGroup"'), '切组没有接上 switchGroup（切过去才能编辑）');
    return '二选一 + 全部剧本 + 切组';
  });

  check('b4 群系色单源（顺手收口的那条）：两份定义不许再出现', () => {
    const sm = read('src/renderer/src/components/ScenarioMap.vue');
    const pm = read('src/renderer/src/components/PlanetMap.vue');
    assert(sm.includes("from '../utils/biomeColors'"), 'ScenarioMap 没引用单源');
    assert(pm.includes("from '../utils/biomeColors'"), 'PlanetMap 没引用单源');
    assert(!/const BIOME_COLORS = \{/.test(sm), 'ScenarioMap 里还留着本地群系色表');
    assert(!/const BIOME_COLORS = \{/.test(pm), 'PlanetMap 里还留着本地群系色表');
    return '两处都引用 utils/biomeColors.js';
  });

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('=== 跨剧本集只读总览（A3）Node 单元测试 ===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
