#!/usr/bin/env node
/**
 * Node 单元测试：剧本侧「城镇名/河流名」分级与取数（src/renderer/src/utils/scenarioTextPlacement.js）
 *
 * 为什么值得测：617 个城镇、160 条河，全标名字就是糊图。分级规则必须**画布与导出共用**，
 * 否则「画布只标首都、导出标 617 个」不会报错，只会让成品图没法用。
 *
 * 用法：node scripts/tests/unit/test_scenario_text_placement.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'scenarioTextPlacement.js');

const results = [];
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e && e.message) || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function deepEq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${label}: 期望 ${y}，实际 ${x}`);
}

async function main() {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(SRC, 'utf8')).toString('base64'));
  const {
    BURG_TIERS, burgLabelTier, riverLabelTier,
    collectBurgLabels, collectRiverLabels, polylineMidpoint,
    EXPORT_BURG_TIER, EXPORT_RIVER_TIER,
  } = mod;

  const burgs = [
    { id: 'c1', name: '首都甲', x: 10, y: 10, capital: 1, population: 5 },
    { id: 'c2', name: '首都乙', x: 20, y: 20, group: 'capital', population: 4 },
    { id: 'b1', name: '大城', x: 30, y: 30, population: 90 },
    { id: 'b2', name: '中城', x: 40, y: 40, population: 50 },
    { id: 'b3', name: '小城', x: 50, y: 50, population: 10 },
    { id: 'no-name', x: 60, y: 60, population: 100 },
  ];

  check('t1 分级阈值：城镇 <1 首都 / 1~2 主要 / ≥2 全部；河流 <1.2 不标', () => {
    eq(burgLabelTier(0.5), BURG_TIERS.capitalOnly, '0.5');
    eq(burgLabelTier(1), BURG_TIERS.major, '1');
    eq(burgLabelTier(1.9), BURG_TIERS.major, '1.9');
    eq(burgLabelTier(2), BURG_TIERS.all, '2');
    eq(riverLabelTier(0.5), -1, '河 0.5 不标');
    eq(riverLabelTier(1.2), 1, '河 1.2');
    eq(riverLabelTier(2), 2, '河 2');
    return '城 0/1/2，河 -1/1/2';
  });

  check('t2 首都档：只回首都（capital 与 group=capital 都认），忽略无名', () => {
    const out = collectBurgLabels(burgs, { tier: BURG_TIERS.capitalOnly });
    deepEq(out.map(x => x.name), ['首都甲', '首都乙'], '首都名');
    assert(out.every(x => x.capital), '都应标记为首都');
    assert(!out.some(x => x.name === '小城'), '非首都不得混入');
    return out.map(x => x.name).join('、');
  });

  check('t3 主要档：首都优先 + 其余按人口降序（前 40）', () => {
    const out = collectBurgLabels(burgs, { tier: BURG_TIERS.major });
    deepEq(out.map(x => x.name), ['首都甲', '首都乙', '大城', '中城', '小城'], '顺序');
    eq(out[0].capital, true, '首都排最前');
    return out.map(x => x.name).join('、');
  });

  check('t4 视口过滤 + 数量上限', () => {
    const rect = { minX: 0, maxX: 35, minY: 0, maxY: 35 };
    const out = collectBurgLabels(burgs, { tier: BURG_TIERS.major, rect });
    deepEq(out.map(x => x.name), ['首都甲', '首都乙', '大城'], '矩形内');
    const capped = collectBurgLabels(burgs, { tier: BURG_TIERS.all, max: 2 });
    eq(capped.length, 2, '上限 2');
    return '3 条 + 上限 2';
  });

  check('t5 河流中点：按长度取一半（不是顶点数组的中点）', () => {
    const mid = polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 30, y: 0 }]);
    eq(Math.round(mid.x), 15, 'x');
    eq(mid.y, 0, 'y');
    const empty = polylineMidpoint([]);
    eq(empty, null, '空 → null');
    const one = polylineMidpoint([{ x: 7, y: 8 }]);
    deepEq(one, { x: 7, y: 8 }, '单点');
    return `mid=${mid.x},${mid.y}`;
  });

  check('t6 河流档：画布低缩放不标；导出档只取流量前 12 且有名字的', () => {
    const rivers = Array.from({ length: 20 }, (_, i) => ({
      id: 'r' + i, name: '河' + i, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      discharge: i, width: i / 10,
    })).concat([{ id: 'anon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], discharge: 999 }]);
    deepEq(collectRiverLabels(rivers, { tier: -1 }), [], '低缩放不标');
    const out = collectRiverLabels(rivers, { tier: EXPORT_RIVER_TIER });
    eq(out.length, 12, '导出档 12 条');
    eq(out[0].name, '河19', '按流量降序');
    assert(!out.some(x => x.name === undefined), '无名不出现');
    return `top=${out[0].name} / 12`;
  });

  check('t7 导出档常量：城镇只标首都、河只取前 12', () => {
    eq(EXPORT_BURG_TIER, BURG_TIERS.capitalOnly, 'burg tier');
    eq(EXPORT_RIVER_TIER, 0, 'river tier');
    return 'capitalOnly + 0';
  });

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
