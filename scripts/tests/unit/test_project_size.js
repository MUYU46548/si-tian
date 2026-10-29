#!/usr/bin/env node
/**
 * Node 单元测试：项目文件**体积裁剪**与**实体时间戳**
 *   · 主进程侧：紧凑落盘（src/main/handlers/projectHandler.js）
 *   · 渲染侧纯函数：快照字节上限 / 空补丁不留快照 / createdAt+updatedAt 保住
 *     （src/renderer/src/utils/projectSchema.js）
 *
 * 为什么必须有这一层：
 *   2026-10-11 实测暮雨的真实项目 —— 正文 39.85 MB（紧凑只有 10.30 MB，**缩进占 74%**），
 *   其中快照 7.68 MB（77.5%），而快照里 **6.41 MB 是同一份 `baseMaps/desite/terrain`
 *   在 11 份快照里各存一遍**（动一个省 = 整份上万点多边形进 patch，约 700 KB）。
 *   同期 `.backups/` 目录 356.67 MB。这些都不会报错，只会让软件变卡、把盘占满。
 *
 * ⚠️ 被测的 projectSchema 是 ESM 且有相对 import（./normalizeId）—— 与 test_province_shape.js
 *    同一套做法：复制到临时目录 + 写 `{"type":"module"}`，把副本的相对 import 补上 `.js`，
 *    再用 file URL import。不改 package.json、不改源码。
 *
 * 用法：node scripts/tests/unit/test_project_size.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(ROOT, 'src', 'main', 'handlers', 'projectHandler.js'));

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
    const dir = path.join(base, `sitian-size-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      return;
    } catch (e) { tried.push(`${base} → ${e.code || e.message}`); }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

/** 把 ESM 源文件复制到临时目录并按需补 `.js` 后缀，再 import（同 test_polygon_bool.js） */
async function importSchema() {
  const deps = ['projectSchema.js', 'normalizeId.js'];
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

/** 一个大一点的多边形（模拟真实省份：几百到几千点） */
function ring(n, seed) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.round((Math.cos(a) * 1000 + seed) * 1000) / 1000, y: Math.round(Math.sin(a) * 1000 * 1000) / 1000 });
  }
  return pts;
}

function bigProject(S, name, provinceCount = 6, pointsPer = 400) {
  const terrain = [];
  for (let i = 0; i < provinceCount; i++) {
    terrain.push({ id: 'p' + i, name: '省' + i, points: ring(pointsPer, i * 7), color: '#123456' });
  }
  const p = S.createEmptyProject({ name });
  return { ...p, scenarios: { version: 2, baseMaps: { base: { id: 'base', name: '底图', terrain } }, scenarios: {} } };
}

async function main() {
  await resolveTmpRoot();
  const S = await importSchema();

  // ══════════════════════════════════════════════════════════════
  // A. 紧凑落盘（主进程真实写盘）
  // ══════════════════════════════════════════════════════════════
  await check('A1 落盘是紧凑 JSON（没有缩进换行）', async () => {
    const file = path.join(TMP, 'compact.sitian');
    const project = { version: '1.0.0', meta: { id: 'x', name: '紧凑' }, entities: {}, hyperlanes: [], scenarios: { version: 2, baseMaps: {}, scenarios: {} }, maps: {}, snapshots: [] };
    const res = await H.writeProjectFile(file, project, { backup: false });
    assert(res && res.success, '写入失败：' + JSON.stringify(res));
    const raw = await fsp.readFile(file, 'utf-8');
    // 判据：除字符串内部的换行外不该有换行 —— 这里数据里没有中文换行，直接数
    eq(raw.split('\n').length, 1, '紧凑 JSON 应只有一行');
    assert(JSON.parse(raw).meta.name === '紧凑', '紧凑 JSON 必须仍可解析且内容一致');
    const pretty = Buffer.byteLength(JSON.stringify(project, null, 2), 'utf8');
    const compact = Buffer.byteLength(raw, 'utf8');
    // 这份样例没有点数组，缩进收益很小（2 倍级的判据放在 A2 的"真实量级"里）。
    // 这里只要**严格更小**即可 —— 但必须非零差异，否则「落盘紧凑」这条是空转。
    assert(pretty > compact, `反向判据：缩进版必须确实更大（pretty=${pretty} compact=${compact}）`);
    return `紧凑 ${compact} B vs 缩进 ${pretty} B`;
  });

  await check('A2 真实量级：多点多边形下缩进占比 > 50%', async () => {
    const file = path.join(TMP, 'compact-big.sitian');
    const project = bigProject(S, 'big', 8, 500);
    await H.writeProjectFile(file, project, { backup: false });
    const raw = await fsp.readFile(file, 'utf-8');
    const compact = Buffer.byteLength(raw, 'utf8');
    const pretty = Buffer.byteLength(JSON.stringify(project, null, 2), 'utf8');
    assert(JSON.parse(raw).scenarios.baseMaps.base.terrain.length === 8, '往返后省份数不一致');
    assert(compact < pretty * 0.6, `缩进应当占大头（compact=${compact} pretty=${pretty}）`);
    return `${(compact / 1024).toFixed(0)} KB ← ${(pretty / 1024).toFixed(0)} KB`;
  });

  // ══════════════════════════════════════════════════════════════
  // B. 快照：字节上限（份数上限之外的第二道闸）
  // ══════════════════════════════════════════════════════════════
  await check('B1 超上限时从最旧的丢，且**永不丢最新那一份**', () => {
    const maxBytes = 120 * 1024;
    let p = bigProject(S, 'budget');
    const states = [];
    let pushes = 0;
    for (let i = 0; i < 12; i++) {
      // 每次改一个省的点（真实场景：涂抹/切分后整份 terrain 进 patch）
      const terrain = p.scenarios.baseMaps.base.terrain.map((t, k) =>
        (k === 0 ? { ...t, points: ring(400, i + 100) } : t));
      p = { ...p, scenarios: { ...p.scenarios, baseMaps: { base: { ...p.scenarios.baseMaps.base, terrain } } } };
      p = S.pushSnapshot(p, { label: 'p' + i, maxBytes });
      pushes++;
      states.push(p.scenarios.baseMaps.base.terrain);
    }
    const bytes = S.snapshotBytes(p.snapshots);
    assert(bytes <= maxBytes, `超上限没被裁：${bytes} > ${maxBytes}`);
    assert(p.snapshots.length < pushes, `必须发生过裁剪（份数 ${p.snapshots.length} / 推入 ${pushes}）`);
    // 最新那一份必须精确等于当前状态
    const last = S.restoreSnapshot(p, p.snapshots.length - 1);
    assert(last.ok, '恢复最新一份失败：' + last.error);
    eq(JSON.stringify(last.state.scenarios.baseMaps.base.terrain), JSON.stringify(states[pushes - 1]), '最新一份必须精确等于当前状态');
    // 反向判据：同一串推入，若把上限关掉就必须**确实超限**（否则本用例是空转）
    let q = bigProject(S, 'budget-nolimit');
    for (let i = 0; i < 12; i++) {
      const terrain = q.scenarios.baseMaps.base.terrain.map((t, k) => (k === 0 ? { ...t, points: ring(400, i + 100) } : t));
      q = { ...q, scenarios: { ...q.scenarios, baseMaps: { base: { ...q.scenarios.baseMaps.base, terrain } } } };
      q = S.pushSnapshot(q, { label: 'q' + i, maxBytes: 0 });
    }
    const noLimit = S.snapshotBytes(q.snapshots);
    assert(noLimit > maxBytes, `反向判据：不设上限时必须超限（实际 ${noLimit}）`);
    return `裁剪后 ${(bytes / 1024).toFixed(0)} KB / 无上限 ${(noLimit / 1024).toFixed(0)} KB，份数 ${p.snapshots.length}/${pushes}`;
  });

  await check('B2 裁剪后**旧快照仍能精确恢复**（丢最旧 = 折进 base，不能丢内容）', () => {
    // 2026-10-29（数组级 diff 之后）：补丁不再含整张省表 → 靠"字节上限"很难触发裁剪。
    // 这里改成用**份数上限**触发（同样走 `dropOldestSnapshot` 的折叠路径），判据不变：
    // 裁剪之后，留下的每一份仍要能逐字节恢复到当时的 terrain。
    const keep = 4;
    let p = bigProject(S, 'ring-exact');
    const states = [];
    for (let i = 0; i < 10; i++) {
      const terrain = p.scenarios.baseMaps.base.terrain.map((t, k) => (k === i % 6 ? { ...t, points: ring(300, i + 1) } : t));
      p = { ...p, scenarios: { ...p.scenarios, baseMaps: { base: { ...p.scenarios.baseMaps.base, terrain } } } };
      p = S.pushSnapshot(p, { label: 'r' + i, keep });
      states.push(p.scenarios.baseMaps.base.terrain);
    }
    const dropped = states.length - p.snapshots.length;
    assert(dropped > 0, '本用例需要发生裁剪（否则判据没意义）');
    const bad = [];
    for (const idx of [0, 1, Math.floor(p.snapshots.length / 2), p.snapshots.length - 1]) {
      const r = S.restoreSnapshot(p, idx);
      if (!r.ok) { bad.push(`restore ${idx} 失败`); continue; }
      const want = states[dropped + idx];
      if (JSON.stringify(r.state.scenarios.baseMaps.base.terrain) !== JSON.stringify(want)) bad.push(`restore ${idx} 不一致`);
    }
    assert(bad.length === 0, bad.join('；'));
    return `丢了 ${dropped} 份（keep=${keep}），抽查 4 个下标全部逐字节一致`;
  });

  // ══════════════════════════════════════════════════════════════
  // C. 空补丁不留快照
  // ══════════════════════════════════════════════════════════════
  await check('C1 状态没变 → 不留空快照（返回原对象，引用相等）', () => {
    let p = bigProject(S, 'noop');
    p = S.pushSnapshot(p, { label: 'first' });
    const n1 = p.snapshots.length;
    const again = S.pushSnapshot(p, { label: 'second' });
    assert(again === p, '没有任何改动时必须返回**原对象**（调用方可据此判断"没动"）');
    eq(again.snapshots.length, n1, '空补丁不该新增快照');
    // 真的改了就必须新增（反向判据，防止"永远不新增"这种假绿）
    const terrain = p.scenarios.baseMaps.base.terrain.map((t, k) => (k === 0 ? { ...t, name: '改名' } : t));
    const p2 = { ...p, scenarios: { ...p.scenarios, baseMaps: { base: { ...p.scenarios.baseMaps.base, terrain } } } };
    const p3 = S.pushSnapshot(p2, { label: 'third' });
    eq(p3.snapshots.length, n1 + 1, '真的改了就必须新增一份');
    return '空补丁 0 新增 / 真改动 +1';
  });

  // ══════════════════════════════════════════════════════════════
  // D. 实体时间戳（createdAt 是事实、updatedAt 是推断）
  // ══════════════════════════════════════════════════════════════
  await check('D1 createEntity 接受显式时间戳（缺省才用 now）', () => {
    const e = S.createEntity({ name: '甲', layer: 'city', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2021-01-01T00:00:00.000Z' });
    eq(e.createdAt, '2020-01-01T00:00:00.000Z', 'createdAt 必须用传入值');
    eq(e.updatedAt, '2021-01-01T00:00:00.000Z', 'updatedAt 必须用传入值');
    const f = S.createEntity({ name: '乙', layer: 'city', now: '2019-05-05T00:00:00.000Z' });
    eq(f.createdAt, '2019-05-05T00:00:00.000Z', '未传 createdAt 时回落到 now');
    return 'ok';
  });

  await check('D2 内容没变 → createdAt/updatedAt 都沿用旧值（这就是那 240 条噪音 diff 的根）', () => {
    const prev = { a: { id: 'a', name: '世界', layer: 'world', parentId: null, tags: ['x'], coordinate: { x: 1, y: 2 }, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' } };
    // 画布导出：内容一模一样，只有时间戳变成"现在"
    const next = { a: { ...prev.a, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' } };
    const merged = S.preserveEntityTimestamps(prev, next);
    eq(merged.a.createdAt, '2020-01-01T00:00:00.000Z', 'createdAt 不许被改写');
    eq(merged.a.updatedAt, '2020-01-01T00:00:00.000Z', '内容没变时 updatedAt 必须沿用旧值');
    // 内容真变了：createdAt 仍保住，updatedAt 接受新值
    const changed = { a: { ...next.a, name: '改名后' } };
    const m2 = S.preserveEntityTimestamps(prev, changed);
    eq(m2.a.createdAt, '2020-01-01T00:00:00.000Z', '改了名也不许动 createdAt');
    eq(m2.a.updatedAt, '2026-10-11T00:00:00.000Z', '内容变了 → updatedAt 用新值');
    // 新实体：原样带过
    const m3 = S.preserveEntityTimestamps(prev, { b: { id: 'b', name: '新', createdAt: 'T', updatedAt: 'T' } });
    eq(m3.b.createdAt, 'T', '新实体原样带过');
    eq(Object.keys(m3).length, 1, '不许把旧实体"带回来"（合并只认新表）');
    return 'createdAt 保住 / updatedAt 按内容判定';
  });

  await check('D3 一次"无改动保存"不再产出时间戳 diff（端到端：pushSnapshot 空补丁）', () => {
    let p = bigProject(S, 'stamp');
    p = { ...p, entities: { a: { id: 'a', name: '世界', layer: 'world', parentId: null, tags: [], coordinate: { x: 0, y: 0 }, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' } } };
    p = S.pushSnapshot(p, { label: 'first' });
    // 模拟"画布导出 → 合并"：时间戳全变、内容不变
    const exported = { a: { ...p.entities.a, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' } };
    const merged = { ...p, entities: S.preserveEntityTimestamps(p.entities, exported) };
    const after = S.pushSnapshot(merged, { label: 'second' });
    assert(after === merged, '修好之后，这种"只改时间戳"的保存必须是空补丁（不新增快照）');
    // 反向判据：不做时间戳保护（直接替换）→ 必然新增一份、且 patch 里有 2 条时间戳
    const naive = { ...p, entities: exported };
    const naiveAfter = S.pushSnapshot(naive, { label: 'naive' });
    assert(naiveAfter !== naive, `反向判据：不做保护时必须新增快照（说明本用例非空转）`);
    const paths = (naiveAfter.snapshots[naiveAfter.snapshots.length - 1].patch.set || []).map(x => x.path.join('/'));
    assert(paths.length >= 2 && paths.some(x => /createdAt$/.test(x)), `反向判据：naive 路径应含 createdAt，实际 ${JSON.stringify(paths)}`);
    return `保护后 0 新增；不保护则 ${paths.length} 条 diff`;
  });

  // ══════════════════════════════════════════════════════════════
  // E. 常量与口径
  // ══════════════════════════════════════════════════════════════
  await check('E1 上限常量在场且量级合理；snapshotBytes 与落盘同口径', () => {
    assert(typeof S.SNAPSHOT_MAX_BYTES === 'number' && S.SNAPSHOT_MAX_BYTES > 0, 'SNAPSHOT_MAX_BYTES 必须是正数');
    assert(S.SNAPSHOT_MAX_BYTES <= 8 * 1024 * 1024, `上限不该大到形同虚设：${S.SNAPSHOT_MAX_BYTES}`);
    eq(S.SNAPSHOT_KEEP, 50, '份数上限保持 50（UI 文案与用例都依赖它）');
    const arr = [{ at: 'x', patch: { set: [], del: [] } }];
    eq(S.snapshotBytes(arr), JSON.stringify(arr).length, 'snapshotBytes 必须与紧凑 JSON 同口径');
    return `maxBytes=${(S.SNAPSHOT_MAX_BYTES / 1024 / 1024).toFixed(1)} MB / keep=${S.SNAPSHOT_KEEP}`;
  });

  // ══════════════════════════════════════════════════════════════
  // F. 快照重放的引用纪律（2026-10-29：`applyPatchInPlace` 之后必须守）
  // ══════════════════════════════════════════════════════════════
  await check('F1 就地重放不共享引用：改恢复出来的状态，不许污染快照缓冲', () => {
    let p = bigProject(S, 'replay', 4, 120);
    p = S.pushSnapshot(p, { at: '2026-01-01T00:00:00.000Z', label: 'a' });
    // 第二份：改一个省的 color（数组整体替换 → 补丁里带整张省表）
    const mutated = { ...p, scenarios: { ...p.scenarios, baseMaps: { ...p.scenarios.baseMaps } } };
    const bm = { ...mutated.scenarios.baseMaps.base };
    bm.terrain = bm.terrain.map((t, i) => (i === 0 ? { ...t, color: '#ffffff' } : t));
    mutated.scenarios.baseMaps.base = bm;
    p = S.pushSnapshot(mutated, { at: '2026-01-02T00:00:00.000Z', label: 'b' });
    eq(p.snapshots.length, 2, '应当有两份快照');

    const before = JSON.stringify(p.snapshots);
    const restored = S.restoreSnapshot(p, 1);
    assert(restored.ok, `恢复失败：${restored.error}`);
    // 深度改写恢复结果：省表、省名、颜色全改一遍
    restored.state.scenarios.baseMaps.base.terrain[0].color = '#000000';
    restored.state.scenarios.baseMaps.base.terrain.push({ id: 'injected', name: '脏数据', points: [] });
    eq(JSON.stringify(p.snapshots), before, '改恢复结果污染了快照缓冲（applyPatchInPlace 的深拷漏了）');

    // 再看"应用补丁"这条公开路径：同样不许共享引用
    const patch = p.snapshots[1].patch;
    const applied = S.applyPatch(S.snapshotState(p), patch);
    const appliedBefore = JSON.stringify(applied);
    applied.scenarios.baseMaps.base.terrain[0].color = '#111111';
    eq(JSON.stringify(S.applyPatch(S.snapshotState(p), patch)), appliedBefore, 'applyPatch 的结果与源数据共享了引用');
    return `快照 ${p.snapshots.length} 份 / 深改恢复结果后缓冲逐字节不变`;
  });

  // ══════════════════════════════════════════════════════════════
  // G. 数组级 diff（2026-10-29：id 数组按 id 局部化）
  // ══════════════════════════════════════════════════════════════
  await check('G1 改一个省的颜色：补丁不含整张省表，且应用后与目标逐字节一致', () => {
    const prev = { scenarios: { baseMaps: { base: { terrain: [
      { id: 'p1', name: '甲', color: '#111111', points: ring(200, 1) },
      { id: 'p2', name: '乙', color: '#222222', points: ring(200, 2) },
      { id: 'p3', name: '丙', color: '#333333', points: ring(200, 3) },
    ] } } } };
    const next = S.deepClone(prev);
    next.scenarios.baseMaps.base.terrain[1].color = '#abcdef';
    const patch = S.diffStates(prev, next);
    const bytes = JSON.stringify(patch).length;
    const whole = JSON.stringify(prev.scenarios.baseMaps.base.terrain).length;
    assert(bytes < whole / 10, `补丁应远小于整表（补丁 ${bytes}B / 整表 ${whole}B）`);
    const paths = patch.set.map((x) => x.path.join('/'));
    assert(paths.some((p) => p.endsWith('#p2/color')), `补丁路径应按 id 定位：${paths.join(' , ')}`);
    assert(!patch.set.some((x) => x.path[x.path.length - 1] === 'terrain'), '不该出现"整表替换"的路径');
    const applied = S.applyPatch(prev, patch);
    assert(S.deepEqual(applied, next), '应用补丁后应与目标逐字节一致');
    eq(applied.scenarios.baseMaps.base.terrain.length, 3, '省数应不变');
    // 引用纪律：应用结果不与补丁共享引用
    applied.scenarios.baseMaps.base.terrain[1].color = '#000000';
    eq(S.applyPatch(prev, patch).scenarios.baseMaps.base.terrain[1].color, '#abcdef', 'applyPatch 与补丁共享了引用');
    return `补丁 ${bytes}B vs 整表 ${whole}B（省表 ${prev.scenarios.baseMaps.base.terrain.length} 个省）`;
  });

  await check('G2 增 / 删 / 重排：按 id 局部化后 roundtrip 仍精确（含顺序）', () => {
    const prev = { terrain: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }] };
    // 删 b、给 a 改值、在中间插入 d、并把 c 挪到最前
    const next = { terrain: [{ id: 'c', v: 3 }, { id: 'd', v: 4 }, { id: 'a', v: 9 }] };
    const patch = S.diffStates(prev, next, ['terrain']);
    const applied = S.applyPatch(prev, patch);
    assert(S.deepEqual(applied, next), `roundtrip 不等于目标：${JSON.stringify(applied)}`);
    eq(applied.terrain.map((x) => x.id).join(','), 'c,d,a', '顺序也必须精确');
    return `set ${patch.set.length} / del ${patch.del.length} / 顺序 ${applied.terrain.map((x) => x.id).join(',')}`;
  });

  await check('G3 兼容老格式：数字下标 / 整表替换的补丁照旧能应用', () => {
    const base = { terrain: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] };
    const legacyIndex = { set: [{ path: ['terrain', '1', 'v'], value: 20 }], del: [] };
    const r1 = S.applyPatch(base, legacyIndex);
    eq(r1.terrain[1].v, 20, '老格式数字下标应仍然生效');
    const legacyWhole = { set: [{ path: ['terrain'], value: [{ id: 'z', v: 9 }] }], del: [] };
    const r2 = S.applyPatch(base, legacyWhole);
    eq(r2.terrain.length, 1, '老格式整表替换应仍然生效');
    eq(r2.terrain[0].id, 'z', '老格式整表替换内容');
    // 反向：普通数组（无 id）仍整体替换，不引入索引级 diff
    const prevPts = { points: [[0, 0], [1, 1], [2, 2]] };
    const nextPts = { points: [[0, 0], [9, 9], [2, 2]] };
    const patchPts = S.diffStates(prevPts, nextPts, ['points']);
    assert(patchPts.set.length === 1 && patchPts.set[0].path.join('/') === 'points',
      `无 id 数组应整体替换，实际 ${JSON.stringify(patchPts.set.map((x) => x.path))}`);
    return '数字下标 / 整表替换都兼容；无 id 数组仍整体替换';
  });

  // 输出
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
