#!/usr/bin/env node
/**
 * Node 单元测试：**账本引擎**（`src/ledger/`，第 3 件，2026-10-24）
 *
 * 这一层是"某省某天归谁"的唯一判定实现。它静默退化的后果都是数据事故级：
 *   · 基线丢了 → 整代归属全空（`deriveFrom` 一挂，装载/切片全错，且不报错）；
 *   · `null` 不当删键 → 无主的省永远挂在旧主名下；
 *   · 同日事件顺序颠倒 → 同一天两次易主的赢家反了；
 *   · 回放慢到几百毫秒 → 时间切片拖动会卡（判据：400 省 × 2000 事件 < 50ms）。
 *
 * 六段判据（a1–a6）：
 *   a1 日换算 + 事件校验    a2 回放语义（基线/切片/最后赢/null 删键/同日先后）
 *   a3 性能（400×2000）     a4 组撤销（整笔摘下再放回；基线不可撤）
 *   a5 与 v2 `deriveFrom` **逐省对拍**（防"两份回放"）   a6 纯数据层守卫 + 反向探针
 *
 * 用法：node scripts/tests/unit/test_ledger_core.js
 * 退出码：0 = 全通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_ROOT = path.join(ROOT, 'src');

const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
    console.log(`  ❌ ${name} — ${(e && e.message) || e}`);
  }
}

/**
 * 把一组入口模块的 ESM 依赖**按仓库相对结构**复制到临时目录再 import
 * （与 test_scenario_ledger_v2.js 同口径：跨目录的相对 import 必须原样成立）。
 */
function makeLoader() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ledger-core-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  const seen = new Set();
  async function load(entries) {
    const queue = entries.map((e) => path.join(SRC_ROOT, e));
    while (queue.length) {
      const full = queue.shift();
      const key = path.relative(SRC_ROOT, full);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(full)) continue;
      let code = fs.readFileSync(full, 'utf8');
      code = code.replace(/from '(\.\.?\/[^']+?)(\.js)?'/g, "from '$1.js'");
      const outFull = path.join(tmp, key);
      fs.mkdirSync(path.dirname(outFull), { recursive: true });
      fs.writeFileSync(outFull, code);
      for (const m of code.matchAll(/from '(\.\.?\/[^']+?)(\.js)?'/g)) {
        queue.push(path.resolve(path.dirname(full), m[1] + '.js'));
      }
    }
    return tmp;
  }
  return { tmp, load };
}

/** 造一个带 n 个省的 v2 剧本（事件数 = eventsPerProvince × n；事件 owner 与基线**不同**，便于验撤销） */
function makeV2Scenario(n, eventsPerProvince) {
  const initialOwnership = {};
  const ownership = {};
  const changeEvents = {};
  const polities = ['p_a', 'p_b', 'p_c', 'p_d'];
  for (let i = 0; i < n; i += 1) {
    const pid = `prov_${i}`;
    initialOwnership[pid] = polities[i % polities.length];
    ownership[pid] = initialOwnership[pid];
  }
  let day = 0;
  for (let k = 0; k < eventsPerProvince; k += 1) {
    for (let i = 0; i < n; i += 1) {
      const pid = `prov_${i}`;
      if (!changeEvents[pid]) changeEvents[pid] = [];
      day += 1;
      const y = 1000 + Math.floor(day / 360);
      const m = (Math.floor(day / 30) % 12) + 1;
      const d = (day % 30) + 1;
      // +1：保证"摘掉这一条"真的会改变归属（否则撤销断言是空转 —— 第一版就是这样假绿的）
      changeEvents[pid].push({ y, m, d, owner: polities[(i + k + 1) % polities.length] });
    }
  }
  // 终态 = 每省最后一条事件（v2 语义）
  for (const pid of Object.keys(changeEvents)) {
    const list = changeEvents[pid];
    ownership[pid] = list[list.length - 1].owner;
  }
  return { id: 'perf', initialOwnership, changeEvents, ownership };
}

async function main() {
  const { tmp, load } = makeLoader();
  await load([
    'ledger/index.js',
    'renderer/src/utils/scenarioLedgerV2.js',
  ]);
  const L = await import(pathToFileURL(path.join(tmp, 'ledger', 'index.js')).href);
  const V2 = await import(pathToFileURL(path.join(tmp, 'renderer', 'src', 'utils', 'scenarioLedgerV2.js')).href);

  console.log('=== 账本引擎（src/ledger）单元测试 ===');

  // ── a1 日换算 + 校验 ──────────────────────────────────────────────────
  await check('a1 日换算（可负年份 / 缺省月日 / 越界夹紧）与事件校验', () => {
    const cal = { yearLength: 360, monthLength: 30 };
    eq(L.dayOfDate({ y: 0, m: 1, d: 1 }, cal), 0, 'y=0,m=1,d=1');
    eq(L.dayOfDate({ y: 1 }, cal), 360, '只到年（按 1 月 1 日）');
    eq(L.dayOfDate({ y: 1, m: 2, d: 3 }, cal), 360 + 30 + 2, 'y=1,m=2,d=3');
    eq(L.dayOfDate({ y: -1 }, cal), -360, '负年份');
    eq(L.dayOfDate({ y: 5, m: null, d: 9 }, cal), 5 * 360, 'm 为 null 时 d 归 null（与 normalizeDate 同口径）');
    eq(L.dayOfDate({ y: 2, m: 13, d: 99 }, cal), 2 * 360 + 11 * 30 + 29, '越界夹进当年内（不抛错）');
    eq(L.dateOfDay(721950, cal), { y: 2005, m: 6, d: 1 }, '反向换算');
    eq(L.dateOfDay(-1, cal), { y: -1, m: 12, d: 30 }, '负日反向换算');

    const ok = L.validateEvent(L.makeEvent({
      worldId: 'w', epochId: 'e', day: 10, type: L.EVENT_OWNER_CHANGED, groupId: 'g1',
      provenance: 'brush', payload: { provinceId: 'p1', fromPolityId: null, toPolityId: 'A' },
    }));
    assert(ok.ok, '合法事件被误拒：' + ok.errors.join('；'));

    const bads = [
      L.makeEvent({ epochId: '', type: L.EVENT_OWNER_CHANGED, provenance: 'brush', payload: { provinceId: 'p', fromPolityId: null, toPolityId: 'A' } }),
      L.makeEvent({ epochId: 'e', type: 'nope.type', provenance: 'brush' }),
      L.makeEvent({ epochId: 'e', type: L.EVENT_OWNER_CHANGED, provenance: 'teleport', payload: { provinceId: 'p', fromPolityId: null, toPolityId: 'A' } }),
      L.makeEvent({ epochId: 'e', day: 3, type: L.EVENT_BASELINE, provenance: 'migrate', payload: { ownership: {} } }),
    ];
    for (const [i, ev] of bads.entries()) {
      assert(!L.validateEvent(ev).ok, `第 ${i + 1} 条坏事件居然通过了校验：${JSON.stringify(ev)}`);
    }
    return '8 条换算 + 1 合法 + 4 坏事件全部符合预期';
  });

  // ── a2 回放语义 ───────────────────────────────────────────────────────
  await check('a2 回放：基线 / 切片 / 最后赢 / null 删键 / 同日按流内先后', () => {
    const ledger = L.createLedger({ epochId: 'e', calendar: { yearLength: 360, monthLength: 30 } });
    ledger.events = [
      L.makeEvent({ epochId: 'e', day: 0, type: L.EVENT_BASELINE, provenance: 'migrate', payload: { ownership: { p1: 'A', p2: 'B', p3: 'C' } } }),
      L.makeEvent({ epochId: 'e', day: 10, type: L.EVENT_OWNER_CHANGED, groupId: 'g1', provenance: 'brush', payload: { provinceId: 'p1', fromPolityId: 'A', toPolityId: 'D' } }),
      L.makeEvent({ epochId: 'e', day: 20, type: L.EVENT_OWNER_CHANGED, groupId: 'g1', provenance: 'brush', payload: { provinceId: 'p2', fromPolityId: 'B', toPolityId: null } }),
      // 同一天两条：后写的赢（流内先后）
      L.makeEvent({ epochId: 'e', day: 30, type: L.EVENT_OWNER_CHANGED, groupId: 'g2', provenance: 'ui', payload: { provinceId: 'p3', fromPolityId: 'C', toPolityId: 'E' } }),
      L.makeEvent({ epochId: 'e', day: 30, type: L.EVENT_OWNER_CHANGED, groupId: 'g2', provenance: 'ui', payload: { provinceId: 'p3', fromPolityId: 'E', toPolityId: 'F' } }),
    ];
    eq(L.projectOwnership(ledger), { p1: 'D', p3: 'F' }, '终态（p2 已被 null 删键）');
    eq(L.projectOwnership(ledger, { atDay: 0 }), { p1: 'A', p2: 'B', p3: 'C' }, '只到 day 0 = 基线');
    eq(L.projectOwnership(ledger, { atDay: 10 }), { p1: 'D', p2: 'B', p3: 'C' }, 'day 10 含当天');
    eq(L.projectOwnership(ledger, { atDay: 29 }), { p1: 'D', p3: 'C' }, 'day 29（p2 已无主）');
    eq(L.ownerAt(ledger, 'p2', 100), null, 'ownerAt 无主 = null');
    return '基线/切片/最后赢/null 删键/同日先后 5 条口径全对';
  });

  // ── a3 性能 ──────────────────────────────────────────────────────────
  await check('a3 性能：400 省 × 2000 事件回放 < 50ms', () => {
    const sc = makeV2Scenario(400, 5);     // 400 省 × 5 事件 = 2000 条
    const { ledger } = L.fromV2Scenario(sc, { epochId: 'perf' });
    eq(ledger.events.length - 1, 2000, '事件条数');
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = process.hrtime.bigint();
      L.projectOwnership(ledger);
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const best = Math.min(...runs);
    assert(best < 50, `回放 ${best.toFixed(1)}ms ≥ 50ms（判据）`);
    return `2000 事件回放 ${best.toFixed(1)}ms（3 次取最好）`;
  });

  // ── a4 组撤销 ────────────────────────────────────────────────────────
  await check('a4 组撤销：整笔摘下再放回逐省还原；基线永远摘不掉', () => {
    const { ledger } = L.fromV2Scenario(makeV2Scenario(6, 1), { epochId: 'g' });
    const groups = L.groupIds(ledger);
    assert(groups.length === 6, `应有 6 组（每省一组），实际 ${groups.length}`);
    const gid = groups[2];
    const before = L.projectOwnership(ledger);
    const { ledger: after, removed } = L.removeGroup(ledger, gid);
    assert(removed && removed.events.length === 1, `摘下的事件数不对：${removed && removed.events.length}`);
    const mid = L.projectOwnership(after);
    assert(JSON.stringify(mid) !== JSON.stringify(before), '摘下之后归属居然没变（组撤销没生效）');
    const back = L.insertGroup(after, removed);
    eq(L.projectOwnership(back), before, '放回后逐省还原');
    eq(back.events.map((e) => e.id), ledger.events.map((e) => e.id), '放回后事件顺序也一致');

    // 基线不可撤：没有 groupId，removeGroup 摘不到
    const baselineGroup = ledger.events.find((e) => e.type === L.EVENT_BASELINE).groupId;
    const tryRemove = L.removeGroup(ledger, baselineGroup || '__none__');
    assert(tryRemove.removed === null, '基线居然能被当组撤掉');
    return `6 组；摘下/放回逐省一致；基线 groupId 为空且摘不掉`;
  });

  // ── a5 与 v2 deriveFrom 逐省对拍 ─────────────────────────────────────
  await check('a5 与 v2 deriveFrom **逐省对拍**（同一份数据、同一个结论）', () => {
    const cases = [
      makeV2Scenario(30, 3),
      { id: 'neg', initialOwnership: { p1: 'A' }, changeEvents: { p1: [{ y: -1350, owner: 'B' }] }, ownership: { p1: 'B' } },
      { id: 'noday', initialOwnership: { p1: 'A', p2: 'B' }, changeEvents: { p2: [{ y: 2000, owner: null }] }, ownership: { p1: 'A' } },
      // 同日两条：v2 靠稳定排序取"最后插入"，账本靠 day 相同比流内下标
      { id: 'same', initialOwnership: { p1: 'A' }, changeEvents: { p1: [{ y: 2000, owner: 'B' }, { y: 2000, owner: 'C' }] }, ownership: { p1: 'C' } },
    ];
    let checked = 0;
    for (const sc of cases) {
      const v2 = V2.deriveFrom(sc.initialOwnership, sc.changeEvents);
      const { ledger } = L.fromV2Scenario(sc, { epochId: sc.id });
      const engine = L.projectOwnership(ledger);
      const d = L.diffOwnership(engine, v2);
      assert(d.same, `[${sc.id}] 账本与 v2 结论不一致：${JSON.stringify(d.changed.slice(0, 3))}`);
      checked += 1;
    }
    return `${checked} 份样本（含负年份 / 无月日 / null 无主 / 同日两条）逐省一致`;
  });

  // ── a6 纯数据层守卫 + 反向探针 ───────────────────────────────────────
  await check('a6 纯数据层守卫（不 import vue/store/组件）+ 反向探针', async () => {
    const dir = path.join(ROOT, 'src', 'ledger');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    assert(files.length >= 5, `src/ledger 文件数不对：${files.length}`);
    const bad = [];
    for (const f of files) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const needle of ["from 'vue'", 'from "vue"', '/store/', '/components/', 'document.', 'window.']) {
        if (code.includes(needle)) bad.push(`${f} 含 ${needle}`);
      }
    }
    assert(!bad.length, '账本层不纯：' + bad.join('；'));

    // 反向探针：把回放里的"null 删键"改掉，a2 的结论必须跟着变（证明 a2 有牙齿）
    const broken = path.join(tmp, 'ledger-broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
    for (const f of ['schema.js', 'replay.js']) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8')
        .replace(/from '(\.\.?\/[^']+?)(\.js)?'/g, "from '$1.js'");
      fs.writeFileSync(path.join(broken, f), f === 'replay.js'
        ? code.replace('delete out[p.provinceId];', 'out[p.provinceId] = null;')
        : code);
    }
    const B = await import(pathToFileURL(path.join(broken, 'replay.js')).href);
    const ledger = {
      events: [
        { id: 'b', epochId: 'e', day: 0, type: 'epoch.baseline', groupId: '', provenance: 'migrate', payload: { ownership: { p1: 'A' } } },
        { id: 'c', epochId: 'e', day: 5, type: 'province.owner.changed', groupId: 'g', provenance: 'ui', payload: { provinceId: 'p1', fromPolityId: 'A', toPolityId: null } },
      ],
    };
    const brokenOut = B.projectOwnership(ledger);
    assert(brokenOut.p1 === null, '反向探针失效：改成 null 赋值后 p1 仍不是 null');
    assert(L.projectOwnership(ledger).p1 === undefined, '正确实现应当是"删键"（p1 不存在）');
    return `${files.length} 个文件零外部依赖；反向探针把 null 改赋值 → 结论立刻不同（删键 vs 挂 null）`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed.length) {
    for (const f of failed) console.log(`  ❌ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
