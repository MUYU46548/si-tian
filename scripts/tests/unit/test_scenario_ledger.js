#!/usr/bin/env node
/**
 * Node 单测：统一账本（`buildLedger` / `ledgerOwnerAt`）
 *
 * 判据（B 的第一条硬约束）：账本与现有 `currentOwnerRef` **逐位等价**。
 * 等价性覆盖三态：
 *   ① 本代无该省事件 → 本代快照；
 *   ② 有事件且已落定 → 最后一条已落定事件；
 *   ③ 有事件但都没到 → 上一代终态（era 归 k-1）。
 * 另外：`initial + 事件` 应用到最后必须等于该代 `ownership`（终态快照可被重建）。
 *
 * 用法：node scripts/tests/unit/test_scenario_ledger.js
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ledger-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set(); const q = ['scenarioTimeline.js', 'scenarioDates.js'];
  while (q.length) {
    const f = q.shift(); if (seen.has(f)) continue; seen.add(f);
    const full = path.join(SRC, f); if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) q.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const TL = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);

  // ── 合成三段历史：显式事件 / 合成事件 / 无事件（同谱系换 id）──────────────
  const scenarios = [
    {
      id: 's1', order: 1, era: { startYear: '2000', endYear: '2010' },
      polities: [{ id: 'A1', name: '甲', lineage: 'L1' }, { id: 'A2', name: '乙', lineage: 'L2' }],
      ownership: { p1: 'A1', p2: 'A2', p3: 'A1', p4: 'A2' },
      changeEvents: { p1: [{ y: 2005, m: 6, d: 1, owner: 'A2' }] },
    },
    {
      id: 's2', order: 2, era: { startYear: '2010', endYear: '2020' },
      polities: [{ id: 'B1', name: '甲', lineage: 'L1' }, { id: 'B2', name: '乙', lineage: 'L2' }],
      ownership: { p1: 'B1', p2: 'B1', p3: 'B1', p4: 'B2' },
      // p2 在本代内由「乙(B2)」变「甲(B1)」—— 显式事件与终态一致
      changeEvents: { p2: [{ y: 2015, m: 6, d: 1, owner: 'B1' }] },
    },
    {
      id: 's3', order: 3, era: { startYear: '2020', endYear: '2030' },
      polities: [{ id: 'C1', name: '丙', lineage: 'L1' }, { id: 'C2', name: '丁', lineage: 'L2' }],
      ownership: { p1: 'C1', p2: 'C1', p3: 'C2', p4: 'C2' },
      // 无显式事件：p3/p4 的谱系变化 → computeEraChanges 会合成日期
    },
  ];
  const tl = TL.buildTimeline(scenarios);
  assert(tl.ledger && tl.ledger.eras.length === 3, '账本应有三代');

  check('一：账本与 currentOwnerRef 在整段时间轴上逐位一致', () => {
    const pids = ['p1', 'p2', 'p3', 'p4'];
    let checked = 0;
    for (let y = 1999; y <= 2031; y++) {
      for (const md of [{ m: null, d: null }, { m: 1, d: 1 }, { m: 6, d: 1 }, { m: 12, d: 31 }]) {
        const at = { y, ...md };
        const k = TL.eraIndexOfYear(tl, y);
        for (const pid of pids) {
          const ref = TL.currentOwnerRef(tl, k, pid, at);
          const led = TL.ledgerOwnerAt(tl.ledger, k, pid, at);
          const a = ref.owner === undefined ? null : ref.owner;
          const b = led.owner === undefined ? null : led.owner;
          assert(a === b, `(${y}/${k}/${pid}) ref=${a} ledger=${b}`);
          assert(ref.era === led.era, `(${y}/${k}/${pid}) era ref=${ref.era} ledger=${led.era}`);
          checked++;
        }
      }
    }
    return `${checked} 次查询逐位一致`;
  });

  check('二：initial + 本代事件 = 该代终态快照（账本可重建 ownership）', () => {
    let rebuilt = 0;
    for (const era of tl.ledger.eras) {
      const end = { ...era.initial };
      for (const pid of Object.keys(era.byPid)) {
        const list = era.byPid[pid];
        if (list.length) end[pid] = list[list.length - 1].owner;
      }
      const all = new Set([...Object.keys(end), ...Object.keys(era.ownership)]);
      for (const pid of all) {
        const a = end[pid] === undefined ? null : end[pid];
        const b = era.ownership[pid] === undefined ? null : era.ownership[pid];
        assert(a === b, `era ${era.index} ${pid}: 重建 ${a} != 快照 ${b}`);
        rebuilt++;
      }
    }
    return `${rebuilt} 个省·代一致`;
  });

  check('三：三态语义各自成立（无事件/已落定/未落定）', () => {
    // s1 p3 无事件 → 本代快照 A1 全程
    assert(TL.ledgerOwnerAt(tl.ledger, 0, 'p3', { y: 2001 }).owner === 'A1', '无事件省应是本代快照');
    // ⚠️ 已知缺口（B 的迁移决策，不是账本错）：computeEraChanges 对 era 0 不建 byProvince，
    //    所以 s1 p1 的 2005 事件目前不影响回放 —— 账本忠实复刻现状。
    assert(TL.ledgerOwnerAt(tl.ledger, 0, 'p1', { y: 2006 }).owner === 'A1',
      'era 0 的事件当前被忽略（账本应与现状一致）');
    // s2 p2：2015-06-01 前 = 本代初始（上一代终态 A2），之后 = B1
    const before = TL.ledgerOwnerAt(tl.ledger, 1, 'p2', { y: 2015, m: 5, d: 31 });
    assert(before.owner === 'A2', `未落定应上一代终态，实际 ${before.owner}`);
    assert(before.era === 0, `未落定 era 应归 0，实际 ${before.era}`);
    const on = TL.ledgerOwnerAt(tl.ledger, 1, 'p2', { y: 2015, m: 6, d: 1 });
    assert(on.owner === 'B1', `落定当天应新主，实际 ${on.owner}`);
    assert(on.era === 1, `落定当天 era 应归 1，实际 ${on.era}`);
    return '无事件 / 未落定 / 落定 三态都对（era 0 事件缺口已标注）';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('用例自身崩溃：', e); process.exit(1); });
