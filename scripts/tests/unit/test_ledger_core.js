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
    // 笔画对象模型的回放要**用渲染层那几份真实生成器**（不在这里另写 RDP/散布）
    'renderer/src/utils/geometry.js',
    'renderer/src/utils/reliefIcons.js',
  ]);
  const L = await import(pathToFileURL(path.join(tmp, 'ledger', 'index.js')).href);
  const V2 = await import(pathToFileURL(path.join(tmp, 'renderer', 'src', 'utils', 'scenarioLedgerV2.js')).href);
  const GEO = await import(pathToFileURL(path.join(tmp, 'renderer', 'src', 'utils', 'geometry.js')).href);
  const RELIEF = await import(pathToFileURL(path.join(tmp, 'renderer', 'src', 'utils', 'reliefIcons.js')).href);

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

  // ── a7 笔画对象模型：三种 kind 的"原始点 → 生成 → 回放"逐点一致 ──────────
  await check('a7 笔画模型：三种 kind 用**真实生成器**回放逐点一致，且 rawPoints 原样保留', () => {
    // ① 轮廓勾画：RDP 简化（渲染层 geometry.simplifyPath）
    const raw = [];
    for (let i = 0; i < 400; i += 1) {
      const a = (i / 400) * Math.PI * 2;
      raw.push({ x: 1000 + Math.cos(a) * 300 + (i % 3) * 0.7, y: 500 + Math.sin(a) * 200 });
    }
    const outlineGen = (pts, params) => GEO.simplifyPath(pts, params.tolerance);
    const outline = L.makeStroke({
      strokeId: 'st-outline', kind: 'outline', generator: 'rdp', params: { tolerance: 4 },
      rawPoints: raw, geometry: outlineGen(raw, { tolerance: 4 }), epochId: 'e', day: 12,
    });
    const oReplay = L.replayStroke(outline, outlineGen);
    assert(oReplay.ok && oReplay.matches, `轮廓回放不一致（${oReplay.error || '指纹不同'}）`);
    assert(outline.rawPoints.length === raw.length, `rawPoints 被生成物覆盖了（${outline.rawPoints.length} ≠ ${raw.length}）`);
    assert(JSON.stringify(outline.geometry).length < JSON.stringify(raw).length, '简化结果居然不比原始点短（读数无效）');

    // ② 散布笔刷：沿路径按 seed 散布（渲染层 reliefIcons.scatterAlongPath）
    const path = [{ x: 0, y: 0 }, { x: 300, y: 60 }, { x: 600, y: -40 }];
    const scatterGen = (pts, params, st) => RELIEF.scatterAlongPath(pts, { ...params }, st.existing || []);
    const scatter = L.makeStroke({
      strokeId: 'st-scatter', kind: 'scatter', generator: 'scatter-along-path',
      params: { spacing: 40, size: 26, density: 'medium', seed: 7 }, rawPoints: path,
      geometry: scatterGen(path, { spacing: 40, size: 26, density: 'medium', seed: 7 }, { existing: [] }),
      epochId: 'e', day: 13,
    });
    const sReplay = L.replayStroke(scatter, scatterGen);
    assert(sReplay.ok && sReplay.matches, `散布回放不一致（${sReplay.error || '指纹不同'}）`);
    assert(Array.isArray(scatter.geometry) && scatter.geometry.length > 2, `散布结果太少（${scatter.geometry.length}）`);

    // ③ 地形笔刷：**填充**型生成器（这里用"沿路径落格"的确定性版本代表；本层不关心生成器内部）
    const fillGen = (pts, params) => {
      const cells = new Map();
      for (const p of pts) {
        const cx = Math.floor(p.x / params.cell);
        const cy = Math.floor(p.y / params.cell);
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) cells.set(`${cx + dx},${cy + dy}`, params.type);
      }
      return [...cells.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    };
    const terrainParams = { cell: 14.4, type: 2 };
    const terrain = L.makeStroke({
      strokeId: 'st-terrain', kind: 'terrain', generator: 'grid-fill', params: terrainParams,
      rawPoints: path, geometry: fillGen(path, terrainParams), epochId: 'e', day: 14,
    });
    const tReplay = L.replayStroke(terrain, fillGen);
    assert(tReplay.ok && tReplay.matches, `地形回放不一致（${tReplay.error || '指纹不同'}）`);

    // ④ 落事件：payload 只带这笔本身，且能 JSON 往返（不带运行时对象）
    const ev = L.strokeEvent(scatter, { epochId: 'e', day: 13, worldId: 'default' });
    const back = JSON.parse(JSON.stringify(ev));
    assert(back.type === 'stroke.committed', `事件类型不对：${back.type}`);
    assert(back.groupId === 'st-scatter', `groupId 应等于 strokeId（一笔一组），实际 ${back.groupId}`);
    assert(L.validateEvent(back).ok, '笔画事件未通过校验：' + L.validateEvent(back).errors.join('；'));
    assert(L.digestStroke(back.payload.stroke) === scatter.geometryDigest, 'JSON 往返后指纹变了（不可复现）');
    return `轮廓 ${raw.length}→${outline.geometry.length} 点 / 散布 ${scatter.geometry.length} 个 / 地形 ${terrain.geometry.length} 格；三份回放指纹全一致`;
  });

  // ── a8 笔画模型的反向探针：改参数/改原始点/换 seed 必须让指纹变 ────────────
  await check('a8 笔画模型反向探针：改 params / rawPoints / seed 指纹必变；缺 seed 的散布被拒', () => {
    const raw = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 200, y: 0 }, { x: 300, y: 20 }];
    const gen = (pts, params) => GEO.simplifyPath(pts, params.tolerance);
    const base = L.makeStroke({
      strokeId: 'st-a', kind: 'outline', generator: 'rdp', params: { tolerance: 2 },
      rawPoints: raw, geometry: gen(raw, { tolerance: 2 }), epochId: 'e',
    });
    const baseDigest = base.geometryDigest;

    const looseTol = JSON.parse(JSON.stringify(base));
    looseTol.params.tolerance = 50;
    const r1 = L.replayStroke(looseTol, gen);
    assert(r1.digest !== baseDigest, '改了 tolerance 指纹却没变（说明 geometry 不是生成物）');

    const moved = JSON.parse(JSON.stringify(base));
    moved.rawPoints[1] = { x: 100, y: 90 };
    const r2 = L.replayStroke(moved, gen);
    assert(r2.digest !== baseDigest, '改了一个原始点指纹却没变');

    // 散布：换 seed 必变；缺 seed 必须被拒（不可复现是静默故障）
    const spath = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
    const sgen = (pts, params, st) => RELIEF.scatterAlongPath(pts, { ...params }, (st && st.existing) || []);
    const s1 = L.makeStroke({ strokeId: 's1', kind: 'scatter', generator: 'g', params: { spacing: 30, seed: 1 }, rawPoints: spath, geometry: sgen(spath, { spacing: 30, seed: 1 }) });
    const s2 = JSON.parse(JSON.stringify(s1));
    s2.params.seed = 2;
    assert(L.replayStroke(s2, sgen).digest !== s1.geometryDigest, '换了 seed 散布结果却没变（seed 没真用上）');
    const noSeed = JSON.parse(JSON.stringify(s1));
    delete noSeed.params.seed;
    const v = L.validateStroke(noSeed);
    assert(!v.ok && v.errors.some((e) => e.includes('seed')), '缺 seed 的散布居然通过校验');
    return 'tolerance / 原始点 / seed 三项反向探针全命中；缺 seed 被拒';
  });

  // ── a9 归属键迁移：改省 id / 删省 / 一省拆多省 / 整列表替换 ─────────────────
  // 为什么这条必须在纯函数层钉住：改省界 / 合并 / 铺底 / 删省 / 删势力都会动归属的**键**，
  // 只改 v2 缓存不改账本 → "账本投影 == 缓存"断掉 → 之后归属编辑永远掉进降级分支。
  await check('a9 归属键迁移：改名/删省/拆省/替换事件后"投影 == 缓存"，且不动入参', () => {
    const sc = {
      id: 'e9',
      initialOwnership: { prov_0: 'p_a', prov_1: 'p_b' },
      changeEvents: { prov_0: [{ y: 1000, m: 6, d: 1, owner: 'p_b' }] },
      ownership: { prov_0: 'p_b', prov_1: 'p_b' },
    };
    const { ledger } = L.fromV2Scenario(sc, { epochId: 'e9' });
    const S = { ...sc, ledger };   // 账本挂在剧本上才是真形状（remapScenarioOwnership 一次改四件事）
    const baselineOf = (Lg) => (Lg.events.find((e) => e.type === L.EVENT_BASELINE).payload.ownership || {});

    // ① 改名 prov_0 → n0：四处都要跟着改
    const renamed = L.remapScenarioOwnership(S, { provinceRename: { prov_0: 'n0' } });
    assert(renamed !== S, '改名后应返回新剧本对象');
    assert(renamed.ownership.n0 === 'p_b' && !('prov_0' in renamed.ownership), 'ownership 键没改名');
    assert(renamed.initialOwnership.n0 === 'p_a' && !('prov_0' in renamed.initialOwnership), 'initialOwnership 键没改名');
    assert(renamed.changeEvents.n0 && renamed.changeEvents.n0[0].m === 6, 'changeEvents 键没改名 / 月日丢了');
    assert(renamed.ledger.events.some((e) => e.type === L.EVENT_OWNER_CHANGED && e.payload.provinceId === 'n0')
      && !renamed.ledger.events.some((e) => e.payload && e.payload.provinceId === 'prov_0'),
      '账本事件 payload 没跟着改名');
    assert(renamed.ledger.events.find((e) => e.type === L.EVENT_BASELINE).payload.ownership.n0 === 'p_a',
      '账本基线没跟着改名');
    // 入参一份都没动（反向探针：原剧本/原账本仍是旧 id）
    assert(S.ownership.prov_0 === 'p_b' && baselineOf(ledger).prov_0 === 'p_a', '迁移居然原地改了入参');
    // 投影 == 缓存（迁移的唯一判据）
    const d1 = L.diffOwnership(L.projectOwnership(renamed.ledger), renamed.ownership);
    assert(d1.same, `改名后投影与缓存不一致（${d1.changed.length} 处）`);

    // ② 删省 prov_1：缓存、基线、事件三处都不该再出现它
    const dropped = L.remapScenarioOwnership(renamed, { provinceRemove: ['prov_1'] });
    const d2 = L.diffOwnership(L.projectOwnership(dropped.ledger), dropped.ownership);
    assert(d2.same, `删省后投影与缓存不一致（${d2.changed.length} 处）`);
    assert(!('prov_1' in dropped.initialOwnership) && !('prov_1' in baselineOf(dropped.ledger)),
      '删省后基线里还留着它（重开就会"复活"）');

    // ③ 无参数 = 原引用（调用方据此跳过写盘）
    assert(L.remapScenarioOwnership(S, {}) === S, '没有迁移参数却换了对象（会白排一次写盘）');

    // ④ 一省拆多省：新省继承源省的归属 + 历史，源省随后摘掉
    const forked = L.forkScenarioProvince(S, 'n0', 'prov_0');
    assert(forked.ownership.n0 === 'p_b' && forked.initialOwnership.n0 === 'p_a', '拆省没复制归属/初始归属');
    assert(forked.changeEvents.n0 && forked.changeEvents.n0.length === 1, '拆省没复制 v2 事件');
    assert(forked.ledger.events.filter((e) => e.payload && e.payload.provinceId === 'n0').length === 1,
      '拆省没复制账本历史');
    const split = L.remapScenarioOwnership(forked, { provinceRemove: ['prov_0'] });
    const d3 = L.diffOwnership(L.projectOwnership(split.ledger), split.ownership);
    assert(d3.same, `拆省后投影与缓存不一致（${d3.changed.length} 处）`);
    assert(split.ownership.n0 === 'p_b' && !('prov_0' in split.ownership), '拆省后归属不对');

    // ④-b 一省拆**多**省（1:N）：每个新省都要拿到历史；事件 id 必须唯一
    //     （踩过：第一版 fork 是把源事件**改名**，第一次 fork 就把它吃掉了，
    //      后几个新省于是"没有历史"——投影里少一条，缓存里却有一份拷贝）
    let multi = L.forkScenarioProvince(S, 'n1', 'prov_0');
    multi = L.forkScenarioProvince(multi, 'n2', 'prov_0');
    const multiSplit = L.remapScenarioOwnership(multi, { provinceRemove: ['prov_0'] });
    const pids = multiSplit.ledger.events
      .filter((e) => e.type === L.EVENT_OWNER_CHANGED).map((e) => e.payload.provinceId);
    assert(pids.includes('n1') && pids.includes('n2'), `1:N 拆省时后一个新省没拿到账本历史：${pids}`);
    const evIds = multiSplit.ledger.events.map((e) => e.id);
    assert(new Set(evIds).size === evIds.length, `fork 出来的事件 id 重复：${evIds}`);
    const dMulti = L.diffOwnership(L.projectOwnership(multiSplit.ledger), multiSplit.ownership);
    assert(dMulti.same, `1:N 拆省后投影与缓存不一致（${dMulti.changed.length} 处）`);

    // ⑤ 整列表替换（易主日期面板）：替换后投影跟着新事件走；空表 = 回到基线
    const r1 = L.replaceProvinceEvents(ledger, 'prov_0', [{ y: 1020, m: 3, d: 4, owner: 'p_c' }], { groupId: 'g9' });
    assert(r1.added === 1, `追加条数不对（${r1.added}）`);
    assert(L.projectOwnership(r1.ledger).prov_0 === 'p_c', '替换事件后投影没跟着走');
    assert(L.toV2Projection(r1.ledger).changeEvents.prov_0.length === 1, '替换后 v2 事件表不是一条');
    const r2 = L.replaceProvinceEvents(r1.ledger, 'prov_0', [], {});
    assert(L.projectOwnership(r2.ledger).prov_0 === 'p_a', '清空事件后没回到基线的归属');
    assert(!L.toV2Projection(r2.ledger).changeEvents.prov_0, '清空事件后 v2 事件表还留着键');

    // ⑥ 反向探针：只改缓存不改账本 → 投影 ≠ 缓存（这正是本函数要防的那种断链）
    const half = { ...S, ownership: { n0: 'p_b', prov_1: 'p_b' }, initialOwnership: { n0: 'p_a', prov_1: 'p_b' } };
    const dHalf = L.diffOwnership(L.projectOwnership(half.ledger), half.ownership);
    assert(!dHalf.same, '反向探针失效：只改缓存时投影居然仍等于缓存');
    return '改名/删省/拆省/替换事件四态投影均与缓存一致；入参零改动；只改缓存的断链被反向探针抓到';
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
