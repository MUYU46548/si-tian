#!/usr/bin/env node
/**
 * 量「快照能退几步」（D01 余②）—— **只读**：源项目文件全程只读，跑前跑后 sha256 比对。
 *
 * 为什么要这个工具：415 省那份真实项目上「改一次河流能退几步」从来没量过。
 * 2026-11-15 之前只有一句"只剩 4 步"的传闻（来自 3 MB 上限时代的一次观察），
 * 而 `SNAPSHOT_MAX_BYTES` 已经抬到 6 MB —— 抬够没抬够，得用真实项目量，不靠推算。
 *
 * 量什么（全部走产品自己的函数，不另写一套语义）：
 *   ① 现场解剖：现有快照里 base 占多少、每份 patch 占多少（体积预算到底被谁吃掉）
 *   ② 每笔改动的补丁有多大：改一条河的走向 / 改一个省的颜色
 *   ③ 在给定上限下连着改 N 笔，缓冲区还能留住几步（= 快照面板能往回退几格）
 *   ④ 留住的每一步**回滚内容对不对**（逐份 restore 后比对指纹，不是只数个数）
 *
 * 用法：
 *   node scripts/tests/tools/probe_snapshot_depth.mjs [--project <file.sitian>]
 *        [--edits 60] [--kinds river,province] [--caps 3,6] [--out build/snapshot-depth]
 *
 * 默认项目 = 用户项目目录（`~/Documents/SiTianProjects`）里体积最大的那个 `.sitian`
 * （= 本机 415 省孤本；只读打开，绝不动它）。
 * 产物：<out>/result.json + <out>/summary.md
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

/**
 * 默认项目：用户项目目录里**体积最大**的那个 `.sitian`。
 * 不写死文件名 —— 项目名是用户自己的事，写进仓库等于把私人专名钉进代码（隐私扫描会红）。
 */
function defaultProject() {
  const dir = path.join(os.homedir(), 'Documents', 'SiTianProjects');
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sitian'))
      .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    return files.length ? files[0].file : '';
  } catch (e) {
    return '';
  }
}

// ── 参数 ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    project: '',
    edits: 60,
    kinds: ['river', 'province', 'regen', 'owner'],
    caps: [3, 6],
    out: path.join(ROOT, 'build', 'snapshot-depth'),
    mapKey: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--project') out.project = next();
    else if (a === '--edits') out.edits = Math.max(1, parseInt(next(), 10) || 60);
    else if (a === '--kinds') out.kinds = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--caps') out.caps = String(next()).split(',').map((s) => parseFloat(s)).filter((n) => n > 0);
    else if (a === '--out') out.out = next();
    else if (a === '--map') out.mapKey = next();
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ── 工具 ────────────────────────────────────────────────────────
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

/** 把 ESM 源码复制到临时目录、补 `.js` 后缀再 import（与 unit/test_project_size.js 同一手法） */
async function importSchema(tmpDir) {
  const deps = ['projectSchema.js', 'normalizeId.js'];
  const dir = path.join(tmpDir, 'schema');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
  for (const f of deps) {
    const body = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')
      .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
    await fsp.writeFile(path.join(dir, f), body, 'utf-8');
  }
  return import(pathToFileURL(path.join(dir, 'projectSchema.js')).href);
}

/** 现场解剖：base 与 patch 各占多少 */
function dissect(S, project) {
  const snaps = project.snapshots || [];
  const parts = snaps.map((s, i) => {
    const baseBytes = s.base !== undefined ? JSON.stringify(s.base).length : 0;
    const patchBytes = s.patch ? JSON.stringify(s.patch).length : 0;
    return { index: i, at: s.at, label: s.label || '', changes: s.changes || 0, baseBytes, patchBytes, total: baseBytes + patchBytes };
  });
  const baseTotal = parts.reduce((a, p) => a + p.baseBytes, 0);
  const patchTotal = parts.reduce((a, p) => a + p.patchBytes, 0);
  return { count: snaps.length, total: S.snapshotBytes(snaps), baseTotal, patchTotal, parts };
}

/** 找"第一个有归属数据的剧本"（编辑与指纹必须用同一个，否则比的是两套对象） */
function ownerScenarioId(projectOrState) {
  const all = ((projectOrState || {}).scenarios || {}).scenarios || {};
  return Object.keys(all).find((x) => all[x] && all[x].ownership && Object.keys(all[x].ownership).length) || '';
}

/** 两个摘要的差异（只列对不上的条目，最多 10 条）—— 核对失败时看一眼就知道差在哪 */
function summaryDiff(want, got, limit = 10) {
  if (!want || !got || typeof got !== 'object') return { want, got };
  const out = [];
  if (Array.isArray(want.owner) && Array.isArray(got.owner)) {
    const g = new Map(got.owner.map(([k, v]) => [k, v]));
    for (const [k, v] of want.owner) if (g.get(k) !== v) out.push({ at: k, want: v, got: g.has(k) ? g.get(k) : '（缺）' });
  }
  if (Array.isArray(want.events) && Array.isArray(got.events)) {
    const g = new Map(got.events.map(([k, n, last]) => [k, [n, last]]));
    for (const [k, n, last] of want.events) {
      const cur = g.get(k);
      if (!cur || cur[0] !== n || JSON.stringify(cur[1]) !== JSON.stringify(last)) {
        out.push({ at: `${k} (事件)`, want: `${n} 条 / 末条 ${JSON.stringify(last)}`, got: cur ? `${cur[0]} 条 / 末条 ${JSON.stringify(cur[1])}` : '（缺）' });
      }
    }
  }
  for (const key of ['rivers', 'provinces', 'points']) {
    if (want[key] !== got[key]) out.push({ at: key, want: want[key], got: got[key] });
  }
  if (JSON.stringify(want.first) !== JSON.stringify(got.first)) out.push({ at: 'first', want: want.first, got: got.first });
  if (JSON.stringify(want.colors) !== JSON.stringify(got.colors)) out.push({ at: 'colors', want: want.colors, got: got.colors });
  return out.slice(0, limit);
}

/** 一份状态的指纹（只看被改的那部分 —— 回滚对不对，靠它比） */
const KIND_LABEL = { river: '河流', province: '省份', regen: '重算地形', owner: '涂归属' };

/** 被改那部分的**可读摘要**（指纹由它算；不一致时把两份摘要并排打出来） */
function summaryOf(state, kind, mapKey, sid = '') {
  const scn = (state || {}).scenarios || {};
  const bm = ((scn.baseMaps || {})[mapKey]) || {};
  if (kind === 'river') {
    const rs = bm.rivers || [];
    return { rivers: rs.length, points: rs.reduce((a, r) => a + ((r && r.points) || []).length, 0), first: rs[0] ? (rs[0].points || [])[0] : null };
  }
  if (kind === 'province') {
    const ts = bm.terrain || [];
    return { provinces: ts.length, first: ts[0] ? ts[0].color : null, colors: ts.slice(0, 8).map((t) => t && t.color) };
  }
  if (kind === 'regen') {
    const ts = bm.terrain || [];
    const rs = bm.rivers || [];
    return { provinces: ts.length, colors: ts.slice(0, 8).map((t) => t && t.color), rivers: rs.length, first: rs[0] ? (rs[0].points || [])[0] : null };
  }
  const s = (scn.scenarios || {})[sid] || {};
  const own = s.ownership || {};
  const evs = s.changeEvents || {};
  return {
    owner: Object.keys(own).sort().map((k) => [k, own[k]]),
    events: Object.keys(evs).sort().map((k) => [k, (evs[k] || []).length, (evs[k] || []).slice(-1)[0] || null]),
  };
}
function targetOf(state, kind, mapKey, sid = '') {
  const scn = (state || {}).scenarios || {};
  const bm = ((scn.baseMaps || {})[mapKey]) || {};
  if (kind === 'river') return bm.rivers || [];
  if (kind === 'province') return bm.terrain || [];
  if (kind === 'regen') return { t: bm.terrain || [], r: bm.rivers || [] };
  const s = (scn.scenarios || {})[sid] || {};
  return { o: s.ownership || {}, e: s.changeEvents || {} };
}
/** 键序无关的规范化（对象按 key 排序；数组保持顺序）—— 只比内容，不比插入顺序 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
function fingerprint(state, kind, mapKey, sid = '') {
  return sha1(JSON.stringify(canonical(targetOf(state, kind, mapKey, sid))));
}

/** 造一笔「改河流」：把第 k 条河的走向整体挪一点（= 用户拖河身，只动这一条） */
function editRiver(project, mapKey, k) {
  const bm = project.scenarios.baseMaps[mapKey];
  const rivers = bm.rivers;
  const i = (k - 1) % rivers.length;
  const r = rivers[i];
  const dx = (k % 7) * 0.35;
  const dy = (k % 5) * 0.2;
  const moved = { ...r, points: (r.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  const next = rivers.slice();
  next[i] = moved;
  project.scenarios = {
    ...project.scenarios,
    baseMaps: { ...project.scenarios.baseMaps, [mapKey]: { ...bm, rivers: next, updatedAt: new Date().toISOString() } },
  };
}

/** 造一笔「改省份」：改一个省的颜色（= 用户涂归属色，只动这一条） */
function editProvince(project, mapKey, k) {
  const bm = project.scenarios.baseMaps[mapKey];
  const terrain = bm.terrain;
  const i = (k - 1) % terrain.length;
  const p = terrain[i];
  const colors = ['#5b8ff9', '#61ddaa', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca'];
  const next = terrain.slice();
  next[i] = { ...p, color: colors[k % colors.length] };
  project.scenarios = {
    ...project.scenarios,
    baseMaps: { ...project.scenarios.baseMaps, [mapKey]: { ...bm, terrain: next, updatedAt: new Date().toISOString() } },
  };
}

/** 造一笔「整表重算地形」：全省改色 + 全部河位移（= 点一次"生成地形"，最贵的那种改动） */
function editRegen(project, mapKey, k) {
  const bm = project.scenarios.baseMaps[mapKey];
  const colors = ['#5b8ff9', '#61ddaa', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca'];
  const terrain = bm.terrain.map((p, i) => ({ ...p, color: colors[(i + k) % colors.length] }));
  const rivers = (bm.rivers || []).map((r) => ({
    ...r, points: (r.points || []).map((p) => ({ x: p.x + (k % 3) * 0.05, y: p.y })),
  }));
  project.scenarios = {
    ...project.scenarios,
    baseMaps: {
      ...project.scenarios.baseMaps,
      [mapKey]: { ...bm, terrain, rivers, updatedAt: new Date().toISOString() },
    },
  };
}

/** 造一笔「涂归属」：一个省易主 + 追加一条事件（= 剧本里最常做的那件事） */
function editOwner(project, sid, k) {
  const all = project.scenarios.scenarios || {};
  const sc = all[sid];
  if (!sc) return;
  const pids = Object.keys(sc.ownership);
  const pid = pids[(k - 1) % pids.length];
  const polityIds = (sc.polities || []).map((p) => p.id);
  const owner = polityIds.length ? polityIds[k % polityIds.length] : sc.ownership[pid];
  const evs = { ...(sc.changeEvents || {}) };
  const list = Array.isArray(evs[pid]) ? evs[pid].slice() : [];
  list.push({ y: 1000 + k, m: 1, d: 1, owner });
  evs[pid] = list;
  project.scenarios = {
    ...project.scenarios,
    scenarios: {
      ...all,
      [sid]: { ...sc, ownership: { ...sc.ownership, [pid]: owner }, changeEvents: evs, updatedAt: new Date().toISOString() },
    },
  };
}

/**
 * 跑一个场景：给定上限，连改 edits 笔，量「还能留住几步」并逐份验回滚内容。
 * 每一笔都走 `snapshotState` + `pushSnapshotWithState`（与保存链同一对函数）。
 */
function runCase(S, raw, { kind, capMB, edits, mapKey }) {
  let project = JSON.parse(raw);   // 每跑一个场景用一份全新副本
  const cap = capMB * 1024 * 1024;
  const perEdit = [];
  const pushedFingerprints = new Map();   // label → 该笔改动之后的指纹
  const pushedSummaries = new Map();      // label → 可读摘要（核对失败时并排看）
  const sid = ownerScenarioId(project);   // 涂归属固定打同一个剧本（编辑与核对必须同源）

  for (let k = 1; k <= edits; k++) {
    if (kind === 'river') editRiver(project, mapKey, k);
    else if (kind === 'province') editProvince(project, mapKey, k);
    else if (kind === 'regen') editRegen(project, mapKey, k);
    else editOwner(project, sid, k);

    const label = `改${KIND_LABEL[kind] || kind} #${k}`;
    const at = new Date(Date.UTC(2026, 10, 15, 0, 0, k)).toISOString();
    const before = (project.snapshots || []).length;
    const state = S.snapshotState(project);
    const withSnap = S.pushSnapshotWithState(project, state, { label, at, maxBytes: cap });

    const snaps = withSnap.snapshots || [];
    const last = snaps[snaps.length - 1];
    const added = snaps.length > before || (last && last.label === label);
    const patchBytes = added && last && last.label === label ? (last.patch ? JSON.stringify(last.patch).length : 0) : 0;
    if (added && last && last.label === label) {
      pushedFingerprints.set(label, fingerprint(project, kind, mapKey, sid));
      pushedSummaries.set(label, summaryOf(project, kind, mapKey, sid));
    }

    project = withSnap;
    perEdit.push({
      k, label, patchBytes,
      kept: snaps.length,
      bytes: S.snapshotBytes(snaps),
      droppedOldest: before > 0 && snaps.length <= before && !(last && last.label === label) ? 0 : 0,
    });
  }

  const snaps = project.snapshots || [];
  const labels = snaps.map((s) => s.label || '');
  const keptEdits = perEdit.filter((e) => labels.includes(e.label));

  // 逐份回滚核对：留住的每一笔，restore 之后内容必须与当时一模一样
  const restoreChecks = [];
  for (let i = 0; i < snaps.length; i++) {
    const lb = snaps[i].label || '';
    if (!pushedFingerprints.has(lb)) continue;
    const res = S.restoreSnapshot(project, i);
    const got = res.ok ? fingerprint(res.state, kind, mapKey, sid) : `err:${res.error}`;
    const ok = res.ok && got === pushedFingerprints.get(lb);
    restoreChecks.push({
      index: i, label: lb, ok, at: res.at || '',
      ...(ok ? {} : { diff: res.ok ? summaryDiff(pushedSummaries.get(lb), summaryOf(res.state, kind, mapKey, sid)) : `restore 报错：${res.error}` }),
    });
  }
  const bad = restoreChecks.filter((c) => !c.ok);
  const patchSizes = perEdit.map((e) => e.patchBytes).filter((n) => n > 0).sort((a, b) => a - b);
  const median = patchSizes.length ? patchSizes[Math.floor(patchSizes.length / 2)] : 0;

  return {
    kind, capMB, edits,
    finalSnapshots: snaps.length,
    finalBytes: S.snapshotBytes(snaps),
    keptEdits: keptEdits.length,
    reachableSteps: keptEdits.length,       // 能往回退几格
    perEditPatchBytes: {
      min: patchSizes[0] || 0,
      median,
      max: patchSizes[patchSizes.length - 1] || 0,
    },
    restoreChecks: { total: restoreChecks.length, failed: bad.length, failures: bad.slice(0, 5) },
    timeline: perEdit.filter((e, i) => i < 5 || i >= perEdit.length - 3).map((e) => ({ k: e.k, patchBytes: e.patchBytes, kept: e.kept, bytes: e.bytes })),
    kept: keptEdits.length,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.project) opts.project = defaultProject();
  if (!opts.project) throw new Error('没找到项目文件：用 --project <file.sitian> 指定一个（脚本只读它）');
  if (!fs.existsSync(opts.project)) throw new Error(`项目文件不存在：${opts.project}`);

  const shaBefore = sha256File(opts.project);
  const sizeBefore = fs.statSync(opts.project).size;
  const raw = fs.readFileSync(opts.project, 'utf8');
  const probe = JSON.parse(raw);

  const mapKey = opts.mapKey || Object.keys((probe.scenarios || {}).baseMaps || {})[0];
  const bm = probe.scenarios.baseMaps[mapKey];
  const shape = {
    file: opts.project,
    bytes: sizeBefore,
    entities: Object.keys(probe.entities || {}).length,
    scenarios: Object.keys((probe.scenarios || {}).scenarios || {}).length,
    mapKey,
    provinces: (bm.terrain || []).length,
    rivers: (bm.rivers || []).length,
  };
  if (!bm.terrain || !bm.terrain.length) throw new Error(`底图 ${mapKey} 没有省份数组，换 --map 指定`);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-snapdepth-'));
  const S = await importSchema(tmpDir);

  const baseline = dissect(S, probe);
  const cases = [];
  for (const kind of opts.kinds) {
    for (const capMB of opts.caps) {
      cases.push(runCase(S, raw, { kind, capMB, edits: opts.edits, mapKey }));
    }
  }

  const shaAfter = sha256File(opts.project);
  const result = {
    at: new Date().toISOString(),
    shape,
    untouched: shaBefore === shaAfter,
    sha256: shaBefore,
    limits: { maxBytes: S.SNAPSHOT_MAX_BYTES, keep: S.SNAPSHOT_KEEP },
    baseline,
    cases,
  };

  await fsp.mkdir(opts.out, { recursive: true });
  await fsp.writeFile(path.join(opts.out, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');
  await fsp.writeFile(path.join(opts.out, 'summary.md'), renderSummary(result), 'utf-8');

  // ── 屏幕读数 ──
  console.log(`项目 ${path.basename(shape.file)}  ${mb(shape.bytes)} · ${shape.provinces} 省 · ${shape.rivers} 河 · ${shape.scenarios} 剧本`);
  console.log(`源文件只读校验：${result.untouched ? 'OK（sha256 未变）' : '🔴 变了！'}`);
  console.log(`现有快照 ${baseline.count} 份 / ${mb(baseline.total)}：base ${mb(baseline.baseTotal)} + patch ${mb(baseline.patchTotal)}`);
  console.log(`上限 ${mb(S.SNAPSHOT_MAX_BYTES)} / 份数 ${S.SNAPSHOT_KEEP}\n`);
  console.log('场景            上限   连改  留住  能退   补丁 中位/最大     回滚核对');
  for (const c of cases) {
    console.log(
      `${('改' + (KIND_LABEL[c.kind] || c.kind)).padEnd(10)}${String(c.capMB + 'MB').padStart(6)}`
      + `${String(c.edits).padStart(6)}${String(c.finalSnapshots).padStart(6)}${String(c.reachableSteps).padStart(6)}`
      + `${String(bytes(c.perEditPatchBytes.median)).padStart(9)}/${bytes(c.perEditPatchBytes.max).padEnd(9)}`
      + `${c.restoreChecks.failed === 0 ? `${c.restoreChecks.total}/${c.restoreChecks.total} 对` : `🔴 ${c.restoreChecks.failed} 份错`}`,
    );
  }
  console.log(`\n产物：${path.relative(ROOT, opts.out)}/result.json · summary.md`);

  if (!result.untouched) { console.error('🔴 源文件被改了 —— 立即检查！'); process.exitCode = 2; }
  if (cases.some((c) => c.restoreChecks.failed)) process.exitCode = 1;
}

function renderSummary(r) {
  const L = [];
  L.push('# 快照回滚深度实测（D01 余②）', '');
  L.push(`- 时间：${r.at}`);
  L.push(`- 项目：\`${path.basename(r.shape.file)}\` ${mb(r.shape.bytes)} · ${r.shape.provinces} 省 · ${r.shape.rivers} 河 · ${r.shape.scenarios} 剧本 · ${r.shape.entities} 实体`);
  L.push(`- 源文件只读：**${r.untouched ? 'sha256 未变' : '🔴 变了'}**（\`${r.sha256.slice(0, 12)}…\`）`);
  L.push(`- 现行上限：${mb(r.limits.maxBytes)} / ${r.limits.keep} 份`, '');
  L.push('## 现场解剖：体积被谁吃掉', '');
  L.push(`现有 **${r.baseline.count} 份 / ${mb(r.baseline.total)}** = base ${mb(r.baseline.baseTotal)} + patch ${mb(r.baseline.patchTotal)}`);
  L.push('');
  L.push('| # | 时间 | 改动条数 | base | patch | 标签 |');
  L.push('|---|---|---|---|---|---|');
  for (const p of r.baseline.parts) {
    L.push(`| ${p.index} | ${p.at} | ${p.changes} | ${p.baseBytes ? bytes(p.baseBytes) : '—'} | ${p.patchBytes ? bytes(p.patchBytes) : '—'} | ${p.label} |`);
  }
  L.push('', '## 能退几步', '');
  L.push('| 改动 | 上限 | 连改 | 最终留存 | **能退** | 补丁中位 / 最大 | 回滚内容核对 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    L.push(`| 改${KIND_LABEL[c.kind] || c.kind} | ${c.capMB} MB | ${c.edits} | ${c.finalSnapshots} 份 | **${c.reachableSteps} 步** | ${bytes(c.perEditPatchBytes.median)} / ${bytes(c.perEditPatchBytes.max)} | ${c.restoreChecks.failed === 0 ? `${c.restoreChecks.total}/${c.restoreChecks.total} 对` : `🔴 ${c.restoreChecks.failed} 份错`} |`);
  }
  L.push('', '## 逐笔（前 5 / 后 3）', '');
  for (const c of r.cases) {
    L.push(`**改${KIND_LABEL[c.kind] || c.kind} · ${c.capMB} MB**`, '');
    L.push('| 第几笔 | 补丁 | 留存份数 | 合计 |');
    L.push('|---|---|---|---|');
    for (const t of c.timeline) L.push(`| #${t.k} | ${bytes(t.patchBytes)} | ${t.kept} | ${mb(t.bytes)} |`);
    L.push('');
  }
  return L.join('\n');
}

main().catch((e) => { console.error('执行失败：', e && e.message); process.exitCode = 1; });
