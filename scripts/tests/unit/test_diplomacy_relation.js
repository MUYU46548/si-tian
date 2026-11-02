#!/usr/bin/env node
/**
 * Node 单测：外交表 UI（N3a-2）所依赖的**关系查询语义**（`utils/scenarioEventLedger.js`）
 *
 * 为什么单独有此文件：`DiplomacyPanel.vue` 只做展示 —— 它把「某年甲与乙什么关系」
 * 整个交给 `relationBetween` / `describeRelation`（store 的 `queryRelationAt` 同源）
 * 与 `relationsAt`（矩阵）。面板本身没有第二套日期窗口比较，因此这里必须把
 * **面板真正依赖的语义**逐条钉住：
 *   ① 两个时间窗重叠时：后开始（更晚）的那条生效（不是先录的、也不是"优先级更高"的）；
 *   ② 先开始的那条到期后自动回落到仍在有效期内的更早关系；全部到期 → 中立且 `known=false`；
 *   ③ 一对**没有任何事件**的势力 → 默认「中立」标签 + `known=false`（面板据此显示
 *      「该年两方无关系」，而不是谎称"确定和平"）；
 *   ④ 关系随时间变化（敌对 → 同盟 → 中立）；和约把中立"写实"（`known=true`、type=peace）；
 *   ⑤ 矩阵 `relationsAt`：双向、只报非中立（和约后该对从矩阵消失 → 面板格子显示中立）；
 *   ⑥ 只读：查询不改入参；`timelineEventsOf` 对空/非法剧本返回 `[]`（面板空状态判据）。
 *
 * 用法：node scripts/tests/unit/test_diplomacy_relation.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const results = [];

function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (e) { results.push({ name, ok: false, detail: (e && e.message) || String(e) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  // 源文件是 bundler 口径（import './scenarioDates' 无扩展名）→ 拷到临时目录补 .js 再用原生 ESM 导入
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-diplomacy-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set();
  const q = ['scenarioEventLedger.js', 'scenarioDates.js'];
  while (q.length) {
    const f = q.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(SRC, f);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) q.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const L = await import(pathToFileURL(path.join(tmp, 'scenarioEventLedger.js')).href);

  const polities = [
    { id: 'pol_jia', name: '甲' },
    { id: 'pol_yi', name: '乙' },
    { id: 'pol_bing', name: '丙' },
  ];
  const nameOf = (id) => (polities.find((p) => p.id === id) || {}).name || id;

  const war = L.makeEvent({
    type: 'war', actors: ['pol_jia', 'pol_yi'],
    from: '1348-06-01', to: '1352-06-01', title: '甲乙战争',
  }, { existing: [], polities, nameOf }).event;
  // 故意把参与方顺序反过来：对称关系必须照样命中（面板的甲/乙顺序不能影响结果）
  const ally = L.makeEvent({
    type: 'alliance', actors: ['pol_yi', 'pol_jia'],
    from: '1350-01-01', to: '1360-01-01', title: '甲乙同盟',
  }, { existing: [war], polities, nameOf }).event;
  const peace = L.makeEvent({
    type: 'peace', actors: ['pol_jia', 'pol_yi'],
    from: '1352-06-01', title: '甲乙和约',
  }, { existing: [war, ally], polities, nameOf }).event;
  const overlap = [war, ally];                 // 1348~1352 与 1350~1360 两个窗口重叠
  const withPeace = [war, ally, peace];

  // ── ① 两窗重叠：后开始者生效；先者到期后回落；全部到期 → 中立且未知 ──
  check('① 两窗重叠：同年两条都生效 → 后开始的那条（同盟）胜；战争到期后回落；全部到期 → 中立未知', () => {
    const at = (d) => L.relationBetween(overlap, 'pol_jia', 'pol_yi', d);
    assert(at('1349-01-01').relation === 'Enemy',
      `1349 只有战争应敌对，实际 ${at('1349-01-01').relation}`);
    assert(at('1350-01-01').relation === 'Ally',
      `1350-01-01 同盟起算日应压过更早的战争，实际 ${at('1350-01-01').relation}`);
    assert(at('1351-06-01').relation === 'Ally',
      `两窗重叠的 1351 应由后开始的同盟生效，实际 ${at('1351-06-01').relation}`);
    assert(at('1351-06-01').eventId === ally.id,
      `生效事件应点名同盟（${ally.id}），实际 ${at('1351-06-01').eventId}`);
    // 1352-06-01 = 战争终止日（[from,to) 终止当日不生效）→ 回落到仍在有效期内的同盟
    assert(at('1352-06-01').relation === 'Ally',
      `战争终止当日应回落到同盟，实际 ${at('1352-06-01').relation}`);
    assert(at('1359-12-31').relation === 'Ally', '同盟有效期内应一直同盟');
    assert(at('1361-01-01').relation === 'Neutral' && at('1361-01-01').known === false,
      `全部到期后应是「中立且无已知事件」，实际 ${JSON.stringify(at('1361-01-01'))}`);
    return '1349 敌对 / 1351 同盟（重叠时后起者胜）/ 1352-06-01 回落同盟 / 1361 中立未知';
  });

  // ── ② 该年生效事件（面板"生效事件"区直接调 activeEventsAt + formatEventSpan）──
  check('② 该年生效事件：activeEventsAt 给两条；formatEventSpan 是面板显示的原文', () => {
    const active = L.activeEventsAt(overlap, '1351-06-01');
    assert(active.length === 2, `1351 应同时有战争与同盟两条生效事件，实际 ${active.length}`);
    assert(L.isActiveAt(war, '1351-06-01') && L.isActiveAt(ally, '1351-06-01'),
      'isActiveAt 与 activeEventsAt 口径不一致');
    assert(!L.isActiveAt(war, '1352-06-01'), '战争终止当日不应再算生效（[from,to) 语义）');
    assert(L.formatEventSpan(war) === '1348-06-01 ~ 1352-06-01',
      `战争时间窗文案不对：${L.formatEventSpan(war)}`);
    assert(L.formatEventSpan({ from: ally.from, to: null }) === '1350-01-01 起',
      `未终止事件的文案应为「… 起」，实际 ${L.formatEventSpan({ from: ally.from, to: null })}`);
    return `${active.length} 条生效；${L.formatEventSpan(war)}`;
  });

  // ── ③ 没有事件的一对 → 默认/未知（面板空状态「该年两方无关系」的判据）──
  check('③ 没有事件的一对 → 中立 + known=false + eventId=null；文案说「没有已记录」，不谎称确定和平', () => {
    const empty = L.relationBetween([], 'pol_jia', 'pol_bing', '1350');
    assert(empty.relation === L.RELATIONS.NEUTRAL, `默认关系应为 Neutral，实际 ${empty.relation}`);
    assert(empty.label === '中立', `默认标签应为「中立」，实际 ${empty.label}`);
    assert(empty.known === false, '没有事件时 known 必须是 false（面板据此显示"无关系"而不是"和平"）');
    assert(empty.eventId === null && empty.since === null, `无事件时不该有来源：${JSON.stringify(empty)}`);

    // 账本非空、但这一对无关 → 同样是"没有事件"
    const unrelated = L.relationBetween(overlap, 'pol_jia', 'pol_bing', '1351');
    assert(unrelated.known === false && unrelated.relation === 'Neutral',
      `无关的一对不应借到别人的关系：${JSON.stringify(unrelated)}`);

    const word = L.describeRelation([], 'pol_jia', 'pol_bing', '1350', { nameOf });
    assert(word.includes('没有已记录') && word.includes('中立'), `空账本文案不对：${word}`);
    return word;
  });

  // ── ④ 关系随时间变化；和约把中立"写实"（known=true, type=peace）──
  check('④ 关系随时间变化：敌对 → 同盟 → 和约中立（known=true）；和约不设终止日 → 之后一直中立', () => {
    const at = (d) => L.relationBetween(withPeace, 'pol_jia', 'pol_yi', d);
    assert(at('1349').relation === 'Enemy', '1349 应敌对');
    assert(at('1351').relation === 'Ally', '1351 应同盟');
    const p = at('1352-06-01');
    assert(p.relation === 'Neutral' && p.known === true,
      `和约当天应是「来自事件的中立」，实际 ${JSON.stringify(p)}`);
    assert(p.type === 'peace' && p.eventId === peace.id,
      `和约中立必须点名 peace 事件，实际 ${p.type}/${p.eventId}`);
    assert(at('1361').relation === 'Neutral' && at('1361').known === true,
      '和约没有终止日 → 之后一直中立（不是回到"没有记录"）');
    const word = L.describeRelation(withPeace, 'pol_jia', 'pol_yi', '1352-06-01', { nameOf });
    assert(word.includes('中立') && word.includes('和约'), `和约文案不对：${word}`);
    return word;
  });

  // ── ⑤ 矩阵语义（面板矩阵读 relationsAt.byPolity；缺格 = 中立）──
  check('⑤ 矩阵：双向都有；只报非中立；polityIds 过滤；和约后该对从矩阵消失（格子显示中立）', () => {
    const m = L.relationsAt(overlap, '1351-06-01', { polityIds: polities.map((x) => x.id) });
    assert(m.pairs.length === 2, `对称关系应给两个方向，实际 ${m.pairs.length}`);
    assert(m.byPolity.pol_jia.pol_yi.relation === 'Ally'
      && m.byPolity.pol_yi.pol_jia.relation === 'Ally',
      `矩阵方向/关系不对：${JSON.stringify(m.byPolity)}`);
    assert(m.byPolity.pol_jia.pol_yi.label === '同盟', '矩阵标签应取 RELATION_LABELS（唯一出处）');

    const filtered = L.relationsAt(overlap, '1351-06-01', { polityIds: ['pol_bing'] });
    assert(filtered.pairs.length === 0, `polityIds 过滤没生效：${filtered.pairs.length}`);

    const after = L.relationsAt(withPeace, '1352-06-01');
    assert(after.pairs.length === 0,
      `和约后该对应从中立矩阵里消失（面板格子显示中立），实际 ${JSON.stringify(after.pairs)}`);

    // 与主查询一致：矩阵里没有的格子 = relationBetween 的中立
    assert(L.relationBetween(withPeace, 'pol_jia', 'pol_yi', '1352-06-01').relation === 'Neutral',
      '矩阵与主查询口径不一致');
    return `1351 双向同盟 / 和约后 0 条`;
  });

  // ── ⑥ 只读：不改入参；timelineEventsOf 空表容错 ──
  check('⑥ 只读：查询不改入参；timelineEventsOf 对空/非法剧本返回 []（面板空状态判据）', () => {
    const snapshot = JSON.stringify(withPeace);
    L.relationBetween(withPeace, 'pol_jia', 'pol_yi', '1351');
    L.relationsAt(withPeace, '1351');
    L.activeEventsAt(withPeace, '1351');
    L.describeRelation(withPeace, 'pol_jia', 'pol_yi', '1351', { nameOf });
    assert(JSON.stringify(withPeace) === snapshot, '查询改动了入参（面板是只读的，纯函数层也不能写）');

    const empty = L.timelineEventsOf(null);
    assert(Array.isArray(empty) && empty.length === 0, '没有剧本时 timelineEventsOf 应给空数组');
    assert(L.timelineEventsOf({ timelineEvents: withPeace }).length === withPeace.length,
      '有事件时应原样返回（不复制、不丢）');
    assert(L.timelineEventsOf({ timelineEvents: 'oops' }).length === 0,
      'timelineEvents 不是数组时应容错为空表（面板不能炸）');
    return '入参未被改；空表 / 非法表 → []';
  });

  const failed = results.filter((r) => !r.ok);
  console.log('=== 外交表关系语义（N3a-2，Node）===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('单元测试运行器异常：', e);
  process.exit(1);
});
