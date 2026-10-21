#!/usr/bin/env node
/**
 * Node 单测：账本 v2 迁移（`planLedgerV2` / `deriveScenarioOwnership` / `verifyScenarioLedger`）
 *
 * 判据：
 *   ① 迁移计划里 `initial + 事件` 派生出的 ownership 必须等于落盘快照（0 mismatch）；
 *   ② era 0 的事件省 initial = null（定案 A）；era k>0 的事件省 initial = 上一代终态；
 *   ③ 迁移是幂等的（对已迁移数据再跑一次，initial 逐字节一致、0 mismatch）；
 *   ④ 被篡改的快照必须被 `verifyScenarioLedger` 报出来（判据不是恒真）。
 *
 * 用法：node scripts/tests/unit/test_scenario_ledger_v2.js
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ledger-v2-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set(); const q = ['scenarioLedgerV2.js', 'scenarioTimeline.js', 'scenarioDates.js'];
  while (q.length) {
    const f = q.shift(); if (seen.has(f)) continue; seen.add(f);
    const full = path.join(SRC, f); if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) q.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const V2 = await import(pathToFileURL(path.join(tmp, 'scenarioLedgerV2.js')).href);

  const scenarios = [
    {
      id: 's1', order: 1, era: { startYear: '2000', endYear: '2010' },
      polities: [{ id: 'A1', name: '甲', lineage: 'L1' }, { id: 'A2', name: '乙', lineage: 'L2' }],
      ownership: { p1: 'A2', p2: 'A2', p3: 'A1', p4: 'A2' },
      changeEvents: { p1: [{ y: 2005, m: 6, d: 1, owner: 'A2' }] },
    },
    {
      id: 's2', order: 2, era: { startYear: '2010', endYear: '2020' },
      polities: [{ id: 'B1', name: '甲', lineage: 'L1' }, { id: 'B2', name: '乙', lineage: 'L2' }],
      ownership: { p1: 'B1', p2: 'B1', p3: 'B1', p4: 'B2' },
      changeEvents: { p2: [{ y: 2015, m: 6, d: 1, owner: 'B1' }] },
    },
    {
      id: 's3', order: 3, era: { startYear: '2020', endYear: '2030' },
      polities: [{ id: 'C1', name: '丙', lineage: 'L1' }, { id: 'C2', name: '丁', lineage: 'L2' }],
      ownership: { p1: 'C1', p2: 'C1', p3: 'C2', p4: 'C2' },
    },
  ];
  const plan = V2.planLedgerV2(scenarios);
  assert(plan.report.mismatchTotal === 0,
    `迁移计划不应有冲突，实际 ${plan.report.mismatchTotal}：${JSON.stringify(plan.report.eras)}`);
  assert(plan.list.length === 3 && plan.list.every((s) => s.ledgerVersion === 2), '三个剧本都应标 v2');
  const byId = Object.fromEntries(plan.list.map((s) => [s.id, s]));

  check('一：initial + 事件派生 = 落盘快照（0 mismatch）', () => {
    let n = 0;
    for (const s of plan.list) {
      const derived = V2.deriveScenarioOwnership(s);
      const stored = s.ownership;
      const pids = new Set([...Object.keys(derived), ...Object.keys(stored)]);
      for (const pid of pids) {
        const a = derived[pid] === undefined ? null : derived[pid];
        const b = stored[pid] === undefined ? null : stored[pid];
        assert(a === b, `${s.id}/${pid}: ${a} != ${b}`);
        n++;
      }
      assert(V2.verifyScenarioLedger(s).ok, `${s.id} verify 失败`);
    }
    return `${n} 个省·代一致`;
  });

  check('二：initial 的基线语义（era 0 = 无主 / era k = 上一代终态 / 无事件省 = 快照）', () => {
    assert(byId.s1.initialOwnership.p1 === null, `era 0 事件省 initial 应为 null，实际 ${byId.s1.initialOwnership.p1}`);
    assert(byId.s1.initialOwnership.p3 === 'A1', '无事件省 initial 应为快照');
    assert(byId.s2.initialOwnership.p2 === 'A2', `era 1 事件省 initial 应为上一代终态，实际 ${byId.s2.initialOwnership.p2}`);
    assert(byId.s3.initialOwnership.p3 === 'B1', 'era 2 无事件省 initial 应为上一代终态');
    return 's1.p1=null / s1.p3=A1 / s2.p2=A2 / s3.p3=B1';
  });

  check('三：幂等（对已迁移数据再跑一次，initial 逐字节一致）', () => {
    const again = V2.planLedgerV2(plan.list);
    assert(again.report.mismatchTotal === 0, '二次迁移不应有冲突');
    for (let i = 0; i < plan.list.length; i++) {
      assert(JSON.stringify(again.list[i].initialOwnership) === JSON.stringify(plan.list[i].initialOwnership),
        `${plan.list[i].id} 的 initial 变了`);
    }
    return '二次迁移 initial 完全一致';
  });

  check('四：快照被篡改必须报冲突（判据有判别力）', () => {
    const bad = { ...byId.s2, ownership: { ...byId.s2.ownership, p2: 'B2' } };
    const v = V2.verifyScenarioLedger(bad);
    assert(!v.ok && v.reason === 'mismatch', '篡改的快照没有被报出来');
    assert(v.diffs.some((d) => d.pid === 'p2'), `冲突清单应点名 p2：${JSON.stringify(v.diffs)}`);
    return `抓到 ${v.diffs.length} 条冲突（p2）`;
  });

  check('五：装载口归一 —— 缓存被篡改时按账本覆盖；v1 剧本保持原引用', () => {
    const dict = Object.fromEntries(plan.list.map((s) => [s.id, s]));
    const bad = { ...dict, s2: { ...dict.s2, ownership: { ...dict.s2.ownership, p2: 'B2' } } };
    const v1 = { id: 'old', ownership: { q: 'X' } };
    bad.old = v1;
    const r = V2.normalizeLedgerDict(bad);
    assert(r.derived === 3, `应派生 3 个 v2 剧本，实际 ${r.derived}`);
    assert(r.mismatched === 1 && r.mismatchIds[0] === 's2', `应点名 s2：${JSON.stringify(r.mismatchIds)}`);
    assert(r.dict.s2.ownership.p2 === 'B1', '被篡改的缓存必须按账本覆盖回 B1');
    assert(r.dict.old === v1, 'v1 剧本（无 initialOwnership）必须保持原引用');
    return '派生 3 / 覆盖 1（s2）/ v1 原引用';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
