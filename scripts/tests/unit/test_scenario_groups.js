#!/usr/bin/env node
/**
 * Node 单元测试：历史剧本「剧本集」纯函数（src/renderer/src/utils/scenarioGroups.js）
 *
 * 为什么值得单独测：
 *   · 「哪条剧本属于哪一组」是**五处共用的语义**（左栏 / 时间轴 / 播放 / 切片 / 管理对话框）。
 *     缺省规则（空 group = 默认组）只要有一处写成 `s.group || ''`，就会出现
 *     「左栏按组过滤了、时间轴没有」—— 同屏两个世界，且不报错。
 *   · 组表是**用户数据**：去重 / 空 id / 乱序必须在入口就规整，否则保存一次就写回脏数据。
 *   · 组 id 是确定性生成的（`grp_N`）—— 同一批夹具两次跑必须同名，用例才能断言。
 *
 * 用法：node scripts/tests/unit/test_scenario_groups.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioGroups.js');

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
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

async function main() {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(SRC, 'utf8')).toString('base64'));
  const {
    DEFAULT_SCENARIO_GROUP, scenarioGroupIdOf, sanitizeScenarioGroups,
    scenarioGroupOptions, scenarioGroupNameOf, filterScenariosByGroup,
    scenarioGroupCounts, firstNonEmptyGroupId, nextScenarioGroupId,
    collectUsedGroupIds, adoptOrphanGroups,
  } = mod;

  check('g1 缺省规则：空 / 缺字段 / 空白 / null 一律落默认组', () => {
    eq(DEFAULT_SCENARIO_GROUP, 'default', '默认组 id');
    for (const s of [{}, null, undefined, { group: '' }, { group: '   ' }, { group: null }]) {
      eq(scenarioGroupIdOf(s), DEFAULT_SCENARIO_GROUP, `应判默认：${JSON.stringify(s)}`);
    }
    eq(scenarioGroupIdOf({ group: 'grp_2' }), 'grp_2', '显式组原样返回');
    eq(scenarioGroupIdOf({ group: '  grp_2  ' }), 'grp_2', '组 id 去空白');
    return '空/缺省/null/显式 7 例';
  });

  check('g2 组表规整：丢空 id、去重、补 name/order、按 order 稳定排序', () => {
    const out = sanitizeScenarioGroups([
      { id: 'b', name: '第二', order: 2 },
      { id: '', name: '空 id' },
      null,
      { id: 'a', name: '第一', order: 1 },
      { id: 'b', name: '重复', order: 9 },
      { id: 'c', order: 1.5 },
      { id: 'default', name: '不能占用默认 id' },
      'nope',
    ]);
    deepEq(out.map((g) => g.id), ['a', 'c', 'b'], 'id 顺序（order 升序、重复只留首条）');
    eq(out[1].name, 'c', '缺 name → 回落 id');
    eq(out[2].name, '第二', '重复 id 不覆盖首条');
    eq(out[2].order, 2, 'order 保留');
    assert(!out.some((g) => g.id === 'default'), '组表里不许出现 default（它是虚拟组）');
    return out.map((g) => `${g.id}:${g.order}:${g.name}`).join(' | ');
  });

  check('g3 选项：默认组永远第一，且不重复', () => {
    const opts = scenarioGroupOptions([{ id: 'grp_1', name: '甲线', order: 1 }]);
    deepEq(opts.map((g) => g.id), ['default', 'grp_1'], '选项顺序');
    eq(opts[0].name, '默认', '默认组名');
    eq(scenarioGroupNameOf([{ id: 'grp_1', name: '甲线' }], 'grp_1'), '甲线', '按 id 查名字');
    eq(scenarioGroupNameOf([], 'grp_x'), 'grp_x', '查不到 → 回 id（绝不空串）');
    eq(scenarioGroupNameOf([], ''), '默认', '空 id → 默认组名');
    return '默认 + 1 自定义';
  });

  check('g4 过滤/计数：缺省组也参与，不丢任何一条剧本', () => {
    const list = [
      { id: 's1', group: 'grp_1' },
      { id: 's2' },
      { id: 's3', group: 'grp_1' },
      { id: 's4', group: 'grp_2' },
    ];
    deepEq(filterScenariosByGroup(list, 'grp_1').map((s) => s.id), ['s1', 's3'], 'grp_1');
    deepEq(filterScenariosByGroup(list, 'default').map((s) => s.id), ['s2'], '默认组');
    deepEq(filterScenariosByGroup(list, 'grp_missing'), [], '不存在的组 → 空');
    const counts = scenarioGroupCounts(list);
    eq(counts.get('grp_1'), 2, 'grp_1 计数');
    eq(counts.get('grp_2'), 1, 'grp_2 计数');
    eq(counts.get('default'), 1, '默认组计数');
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    eq(total, list.length, '各组合计 = 剧本总数（不许丢）');
    return `grp_1=2 / grp_2=1 / default=1`;
  });

  check('g5 首个非空组：按传入顺序取第一条所在组；全空 → 默认', () => {
    eq(firstNonEmptyGroupId([]), 'default', '空列表');
    eq(firstNonEmptyGroupId([{ id: 'a' }, { id: 'b', group: 'grp_9' }]), 'default', '第一条默认');
    eq(firstNonEmptyGroupId([{ id: 'a', group: 'grp_9' }, { id: 'b' }]), 'grp_9', '第一条在 grp_9');
    return '3 例';
  });

  check('g6 新组 id：确定、跳过已用、不撞默认', () => {
    eq(nextScenarioGroupId([]), 'grp_1', '空表 → grp_1');
    eq(nextScenarioGroupId([{ id: 'grp_1' }]), 'grp_2', '跳过 grp_1');
    eq(nextScenarioGroupId([{ id: 'grp_2' }, { id: 'grp_1' }]), 'grp_3', '乱序也稳定');
    const a = nextScenarioGroupId([{ id: 'grp_1' }]);
    const b = nextScenarioGroupId([{ id: 'grp_1' }]);
    eq(a, b, '同一输入两次调用同名（可复现）');
    return `next=grp_1/grp_2/grp_3`;
  });

  check('g7 孤儿组收编：剧本引用了组表里没有的 id → 补同名组（否则剧本在所有组里都不可见）', () => {
    const list = [{ id: 's1', group: 'grp_9' }, { id: 's2' }, { id: 's3', group: 'grp_1' }];
    const groups = [{ id: 'grp_1', name: '甲线', order: 1 }];
    deepEq(collectUsedGroupIds(list), ['grp_9', 'grp_1'], '用到的组（不含默认）');
    const adopted = adoptOrphanGroups(groups, list);
    deepEq(adopted.map((g) => g.id), ['grp_1', 'grp_9'], '孤儿被追加在已有组之后');
    eq(adopted[1].name, 'grp_9', '孤儿组名 = id（不臆造名字）');
    // 不收编默认组（它是虚拟的）
    const onlyDefault = adoptOrphanGroups([], [{ id: 'x' }, { id: 'y', group: 'default' }]);
    deepEq(onlyDefault, [], '只有默认组 → 组表仍为空');
    // 无孤儿时不换引用语义（值相同即可）
    deepEq(adoptOrphanGroups(groups, [{ id: 's3', group: 'grp_1' }]), groups, '无孤儿 → 原样');
    return `grp_1 + grp_9`;
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('\n失败：');
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
