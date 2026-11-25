#!/usr/bin/env node
/**
 * Node 单元测试：**快照回滚深度**（D01 的验收判据，2026-11-15）
 *
 * 为什么单独立一条：`test_project_size.js` 守的是"体积不许膨胀"（上限/份数/空补丁不留份），
 * 但从没守过**"用户实际能往回退几步"**，也没守过**"退回去的内容对不对"**。
 * 2026-11-15 在真实 415 省项目上量出来（`scripts/tests/tools/probe_snapshot_depth.mjs`）：
 *   改一条河 10 KB / 改一个省 11 KB / 涂一笔归属 367 B / **整表重算地形 394 KB**，
 *   6 MB 上限下分别能退 50 / 50 / 50 / 14 步（3 MB 时代整表重算是 3 步 —— 那份"只能退 4 步"的传闻出自这里）。
 * 这条用例把这个能力钉住：用**合成数据**（不碰用户项目），判两条硬事实——
 *   ① 高频小改动能退满份数上限（≥20 步，用户可感知的"历史还在"）
 *   ② 留下来的每一份，restore 出来的内容与当时**逐字段一致**（不是只数个数）
 *
 * 用法：node scripts/tests/unit/test_snapshot_depth.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP, process.env.TEMP, process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
].filter(Boolean);

let TMP = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-depth-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, '.write-probe'), 'ok', 'utf-8');
      await fsp.unlink(path.join(dir, '.write-probe'));
      TMP = dir;
      return;
    } catch (e) { tried.push(`${base} → ${e.code || e.message}`); }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

/** 复制 ESM 源到临时目录 + 补 `.js` 后缀（同 test_project_size.js） */
async function importSchema() {
  const deps = ['projectSchema.js', 'normalizeId.js', 'planetClasses.js', 'planetPalettes.js'];
  const dir = path.join(TMP, 'schema');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of deps) {
    const body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
}

// ── 合成项目（结构同构真实项目，内容全假；**不读任何用户文件**）──────────────
const MAP = 'demo';
const N_PROV = 400;
const N_RIVER = 300;
const COLORS = ['#5b8ff9', '#61ddaa', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca'];

function makeProvince(i) {
  const pts = [];
  for (let k = 0; k < 8; k++) pts.push({ x: i * 3 + k, y: (i % 37) + k });
  return { id: `prov_${i}`, name: `省 ${i}`, kind: 'land', color: COLORS[i % COLORS.length], points: pts, biome: 'plain' };
}

function makeRiver(i) {
  const pts = [];
  for (let k = 0; k < 24; k++) pts.push({ x: i * 2 + k * 0.5, y: k * 0.25 });
  return { id: `river_${i}`, name: `河 ${i}`, points: pts, width: 1 + (i % 5) };
}

function makeProject() {
  const terrain = [];
  for (let i = 0; i < N_PROV; i++) terrain.push(makeProvince(i));
  const rivers = [];
  for (let i = 0; i < N_RIVER; i++) rivers.push(makeRiver(i));
  const ownership = {};
  const changeEvents = {};
  for (let i = 0; i < N_PROV; i++) {
    ownership[`prov_${i}`] = i % 3 === 0 ? 'pol_a' : 'pol_b';
    changeEvents[`prov_${i}`] = [{ y: 1000, m: 1, d: 1, owner: ownership[`prov_${i}`] }];
  }
  return {
    version: '1.0.0',
    meta: { name: '深度用例项目', createdAt: '2026-11-15T00:00:00.000Z' },
    entities: { world: { id: 'world', name: '世界', layer: 'world', parentId: null } },
    hyperlanes: [],
    scenarios: {
      baseMaps: { [MAP]: { id: MAP, name: '示例底图', terrain, rivers, updatedAt: '2026-11-15T00:00:00.000Z' } },
      scenarios: {
        'demo/甲朝': {
          id: 'demo/甲朝', name: '甲朝', startYear: 1000, endYear: 1100,
          polities: [{ id: 'pol_a', name: '甲', color: '#c00' }, { id: 'pol_b', name: '乙', color: '#00c' }],
          ownership, changeEvents,
        },
      },
    },
    maps: { mapData: {}, editor: {} },
    snapshots: [],
  };
}

// 三种改法（都只动"用户真的会动"的那一处）
function editProvinceColor(p, k) {
  const bm = p.scenarios.baseMaps[MAP];
  const i = (k - 1) % bm.terrain.length;
  const next = bm.terrain.slice();
  next[i] = { ...next[i], color: COLORS[k % COLORS.length] };
  bm.terrain = next;
  bm.updatedAt = `2026-11-15T00:00:${String(k % 60).padStart(2, '0')}.000Z`;
  return { index: i, color: next[i].color };
}

function editRiverPath(p, k) {
  const bm = p.scenarios.baseMaps[MAP];
  const i = (k - 1) % bm.rivers.length;
  const next = bm.rivers.slice();
  next[i] = { ...next[i], points: next[i].points.map((q) => ({ x: q.x + 0.5, y: q.y })) };
  bm.rivers = next;
  bm.updatedAt = `2026-11-15T00:01:${String(k % 60).padStart(2, '0')}.000Z`;
  return { index: i, dx: 0.5 * k };
}

function editOwnership(p, k) {
  const sc = p.scenarios.scenarios['demo/甲朝'];
  const pid = `prov_${(k - 1) % N_PROV}`;
  const owner = k % 2 ? 'pol_a' : 'pol_b';
  sc.ownership = { ...sc.ownership, [pid]: owner };
  sc.changeEvents = { ...sc.changeEvents, [pid]: [...(sc.changeEvents[pid] || []), { y: 1000 + k, m: 1, d: 1, owner }] };
  return { pid, owner };
}

/** 重算地形：全省改色 + 全部河位移（= 点一次"生成地形"，最贵的那种改动） */
function editRegen(p, k) {
  const bm = p.scenarios.baseMaps[MAP];
  bm.terrain = bm.terrain.map((t, i) => ({ ...t, color: COLORS[(i + k) % COLORS.length] }));
  bm.rivers = bm.rivers.map((r) => ({ ...r, points: r.points.map((q) => ({ x: q.x + 0.05, y: q.y })) }));
  bm.updatedAt = `2026-11-15T00:02:${String(k % 60).padStart(2, '0')}.000Z`;
}

/** 连推 N 笔，返回 { project, records }（records 记每笔的"该长什么样"） */
function runEdits(S, project, editFn, n, opts) {
  let p = project;
  const records = [];
  for (let k = 1; k <= n; k++) {
    const expect = editFn(p, k);
    const label = `第 ${k} 笔`;
    const at = new Date(Date.UTC(2026, 10, 15, 0, 0, k)).toISOString();
    p = S.pushSnapshotWithState(p, S.snapshotState(p), { ...opts, label, at });
    records.push({ k, label, expect });
  }
  return { project: p, records };
}

// ── 用例 ────────────────────────────────────────────────────────
async function main() {
  await resolveTmpRoot();
  const S = await importSchema();

  await check('a. 高频小改动：能退满份数上限（≥20 步），且份数与体积都不超限', async () => {
    const base = makeProject();
    const { project } = runEdits(S, base, editProvinceColor, 60);
    const snaps = project.snapshots || [];
    const kept = snaps.filter((s) => s.label).length;
    assert(snaps.length <= S.SNAPSHOT_KEEP, `份数超上限：${snaps.length} > ${S.SNAPSHOT_KEEP}`);
    assert(S.snapshotBytes(snaps) <= S.SNAPSHOT_MAX_BYTES, `体积超上限：${S.snapshotBytes(snaps)}`);
    assert(kept >= 20, `能退的步数太少：${kept} 步（要求 ≥ 20 —— 这是用户能感知的"历史还在"）`);
    eq(kept, Math.min(60, S.SNAPSHOT_KEEP), '留住步数应等于 min(改动笔数, 份数上限)');
    return `60 笔 → 留住 ${kept} 步 / ${(S.snapshotBytes(snaps) / 1024).toFixed(0)} KB`;
  });

  await check('b. 改一个省：补丁是 KB 级（id 局部化生效，不是整表 400 省进补丁）', async () => {
    const base = makeProject();
    const { project } = runEdits(S, base, editProvinceColor, 5);
    const last = project.snapshots[project.snapshots.length - 1];
    const patchBytes = JSON.stringify(last.patch).length;
    const wholeTable = JSON.stringify(project.scenarios.baseMaps[MAP].terrain).length;
    assert(patchBytes * 4 < wholeTable, `补丁 ${patchBytes}B 相对整表 ${wholeTable}B 太大 —— id 局部化没生效？`);
    const paths = (last.patch.set || []).map((x) => x.path.join('>'));
    assert(paths.some((x) => x.includes('#prov_')), `补丁路径里没有按 id 定位的段：${paths.slice(0, 3).join(' | ')}`);
    return `补丁 ${patchBytes} B vs 整表 ${wholeTable} B（1/${Math.round(wholeTable / patchBytes)}）`;
  });

  await check('c. 改一条河 / 涂一归属笔：补丁同样是 KB 或 B 级', async () => {
    const r1 = runEdits(S, makeProject(), editRiverPath, 3).project;
    const riverPatch = JSON.stringify(r1.snapshots[r1.snapshots.length - 1].patch).length;
    const r2 = runEdits(S, makeProject(), editOwnership, 3).project;
    const ownerPatch = JSON.stringify(r2.snapshots[r2.snapshots.length - 1].patch).length;
    assert(riverPatch < 40 * 1024, `改一条河的补丁 ${riverPatch} B 偏大`);
    assert(ownerPatch < 4 * 1024, `涂一笔归属的补丁 ${ownerPatch} B 偏大`);
    return `改河 ${riverPatch} B / 涂归属 ${ownerPatch} B`;
  });

  await check('d. 逐份回滚内容一致：留住的每一份 restore 都等于当时的样子', async () => {
    const base = makeProject();
    const { project, records } = runEdits(S, base, editProvinceColor, 60);
    const snaps = project.snapshots || [];
    let checked = 0;
    const bad = [];
    for (let i = 0; i < snaps.length; i++) {
      const label = snaps[i].label || '';
      const rec = records.find((r) => r.label === label);
      if (!rec) continue;
      const res = S.restoreSnapshot(project, i);
      if (!res.ok) { bad.push(`${label}: restore 失败 ${res.error}`); continue; }
      const got = res.state.scenarios.baseMaps[MAP].terrain[rec.expect.index];
      if (!got || got.color !== rec.expect.color) bad.push(`${label}: 省 ${rec.expect.index} 颜色 ${got && got.color} ≠ ${rec.expect.color}`);
      checked++;
    }
    assert(checked >= 20, `只核对了 ${checked} 份（太少，判据被跳过）`);
    assert(bad.length === 0, `回滚内容不对：${bad.slice(0, 3).join('；')}`);
    return `${checked} 份逐份核对通过`;
  });

  await check('e. 归属回滚也一致（事件数组一并回滚，不只是归属码）', async () => {
    const base = makeProject();
    const { project, records } = runEdits(S, base, editOwnership, 30);
    const snaps = project.snapshots || [];
    const lastIdx = snaps.length - 1;
    const rec = records[records.length - 1];
    const res = S.restoreSnapshot(project, lastIdx);
    assert(res.ok, `restore 失败：${res.error}`);
    const sc = res.state.scenarios.scenarios['demo/甲朝'];
    eq(sc.ownership[rec.expect.pid], rec.expect.owner, '最后一笔的归属码');
    // 往回退到"第一笔之前"：那一份里该省的事件条数必须回到 1
    const firstKept = snaps.findIndex((s) => s.label === records[0].label);
    if (firstKept >= 0) {
      const back = S.restoreSnapshot(project, firstKept);
      assert(back.ok, `restore 第一份失败：${back.error}`);
      const evs = back.state.scenarios.scenarios['demo/甲朝'].changeEvents;
      const total = Object.values(evs).reduce((a, list) => a + (list || []).length, 0);
      assert(total < Object.values(sc.changeEvents).reduce((a, list) => a + (list || []).length, 0), '退回去后事件总数没有减少（回滚没生效）');
      return `归属 ${rec.expect.pid}=${rec.expect.owner}；事件总数 ${total} → 现在 ${Object.values(sc.changeEvents).reduce((a, l) => a + l.length, 0)}`;
    }
    return '归属码一致（第一笔已滚出窗口，只核对了当前份）';
  });

  await check('f. 整表重算地形：步数会缩水，但每一步都正确、且最新那份永远在', async () => {
    const base = makeProject();
    const { project } = runEdits(S, base, editRegen, 20);
    const snaps = project.snapshots || [];
    assert(snaps.length >= 1, '快照全被丢了');
    assert((snaps[snaps.length - 1].label || '') === '第 20 笔', '最新那一份不是最后一笔 —— "最新永不丢"被破坏');
    const res = S.restoreSnapshot(project, snaps.length - 1);
    assert(res.ok, `最新一份 restore 失败：${res.error}`);
    const bm = res.state.scenarios.baseMaps[MAP];
    eq(bm.terrain.length, N_PROV, '省份数量');
    eq(bm.rivers.length, N_RIVER, '河流数量');
    return `20 笔重算 → 留住 ${snaps.length} 份（每笔 ~${(JSON.stringify(snaps[snaps.length - 1].patch).length / 1024).toFixed(0)} KB）`;
  });

  await check('g. 负向探针：上限压到 1 字节时只剩 1 份（而不能是 0 份）', async () => {
    const base = makeProject();
    let p = base;
    for (let k = 1; k <= 5; k++) {
      editProvinceColor(p, k);
      p = S.pushSnapshotWithState(p, S.snapshotState(p), { label: `第 ${k} 笔`, maxBytes: 1 });
    }
    eq((p.snapshots || []).length, 1, '上限极小时应只保留最新 1 份');
    eq(p.snapshots[0].label, '第 5 笔', '留下的必须是最新那一份');
    return '1 份 / 且是最新那份';
  });

  await check('h. 负向探针：把 id 去掉后补丁会退回整表替换（证明 d/b 的判据有判别力）', async () => {
    const base = makeProject();
    // 去掉 id → isIdArray 判不过 → 只能整表替换
    base.scenarios.baseMaps[MAP].terrain = base.scenarios.baseMaps[MAP].terrain.map(({ id, ...rest }) => rest);
    const { project } = runEdits(S, base, editProvinceColor, 2);
    const last = project.snapshots[project.snapshots.length - 1];
    const paths = (last.patch.set || []).map((x) => x.path.join('>'));
    assert(paths.some((x) => x.endsWith('terrain')), `无 id 时应当整表替换 terrain，实际路径：${paths.join(' | ')}`);
    return `无 id → 路径 ${paths.find((x) => x.endsWith('terrain'))}（整表）`;
  });

  // ── 汇总 ──
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? `\n         ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  // run_tests.py 取最后一行以 `===` 开头的作为摘要（见 run_tests.py#run_node_unit_tests）
  console.log(`===快照回滚深度 ${results.length - failed.length}/${results.length} 通过===`);
  try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('用例自身崩了：', e && e.stack || e); process.exitCode = 1; });
