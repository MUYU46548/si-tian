#!/usr/bin/env node
/**
 * 项目体积审计（**只读**，不碰任何文件）
 *
 * 用法：
 *   npm run audit-project-size                         # 自动找默认目录里最大的 .sitian
 *   npm run audit-project-size -- --project "C:\...\绒花计划.sitian"
 *   npm run audit-project-size -- --all                # 列出默认目录下所有项目
 *
 * 为什么需要它：项目文件"变大"是没有报错的 —— 用户只会觉得"软件变卡、盘被占满"。
 * 2026-10-11 用它量出的真实现状（暮雨的项目）：
 *   · 正文 39.85 MB，紧凑 JSON 只有 10.30 MB → **缩进独占 74%**
 *   · 其中快照 7.68 MB（75%），而快照里最大的一笔是 `scenarios/baseMaps/desite/terrain`
 *     （一个省的编辑 = 整份上万点多边形进 patch，约 700 KB）
 *   · 同目录 `.backups/` 共 356.7 MB（11 份 × 每份 30+ MB）
 * 这三条分别对应 0.2.4 的三处改动：紧凑落盘 / 快照字节上限 / （备份份数未改，见下）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;

function parseArgs(argv) {
  const out = { project: '', all: false, backups: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') out.project = argv[++i] || '';
    else if (a === '--all') out.all = true;
    else if (a === '--no-backups') out.backups = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function defaultDir() {
  return path.join(os.homedir(), 'Documents', 'SiTianProjects');
}

function listProjects(dir) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of items) {
    if (!e.isFile() || !e.name.endsWith('.sitian')) continue;
    const full = path.join(dir, e.name);
    try { out.push({ file: full, bytes: fs.statSync(full).size }); } catch (_) { /* 跳过 */ }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

const mb = (n) => (n / MB).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

/** 快照审计：份数 / 字节 / 每份 patch 大小 / 最大的几条 patch 路径 */
function auditSnapshots(project) {
  const snaps = Array.isArray(project.snapshots) ? project.snapshots : [];
  const lines = [];
  let total = 0;
  let baseBytes = 0;
  const rows = [];
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i] || {};
    const bytes = JSON.stringify({ base: s.base, patch: s.patch }).length;
    total += bytes;
    if (s.base) baseBytes += JSON.stringify(s.base).length;
    let biggest = { bytes: 0, path: '' };
    for (const it of ((s.patch && s.patch.set) || [])) {
      const b = JSON.stringify(it.value === undefined ? null : it.value).length;
      if (b > biggest.bytes) biggest = { bytes: b, path: (it.path || []).join('/') };
    }
    rows.push({ i, at: s.at, label: s.label || '', bytes, changes: s.changes || 0, biggest });
  }
  lines.push(`  份数 ${snaps.length}（上限 50 份 / 3 MB 由 SNAPSHOT_MAX_BYTES 控制）· 合计 ${mb(total)}`);
  if (baseBytes) lines.push(`  第 0 份 base ${kb(baseBytes)}（其余为逐份 diff）`);
  const top = [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  for (const r of top) {
    lines.push(`  · #${r.i} ${r.at || '?'} ${r.label || ''} ${kb(r.bytes)} 改动${r.changes}处`
      + (r.biggest.bytes ? ` · 最大一笔 ${kb(r.biggest.bytes)} ← ${r.biggest.path}` : ''));
  }
  // 同一个路径在所有快照里重复出现的次数（"每份都带一整份"的指纹）
  const byPath = new Map();
  for (const s of snaps) {
    for (const it of ((s.patch && s.patch.set) || [])) {
      const p = (it.path || []).join('/');
      const b = JSON.stringify(it.value === undefined ? null : it.value).length;
      const cur = byPath.get(p) || { n: 0, bytes: 0 };
      byPath.set(p, { n: cur.n + 1, bytes: cur.bytes + b });
    }
  }
  const repeats = [...byPath.entries()].filter(([, v]) => v.n > 1).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5);
  if (repeats.length) {
    lines.push('  重复进 patch 的路径（"整体替换数组"的代价）：');
    for (const [p, v] of repeats) lines.push(`  · ${p} × ${v.n} 份 = ${mb(v.bytes)}`);
  }
  return { lines, total, count: snaps.length };
}

function auditBackups(file) {
  const dir = file.replace(/\.sitian$/, '.sitian.backups');
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  let total = 0, count = 0;
  const biggest = [];
  for (const e of items) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    total += st.size; count++;
    biggest.push({ name: e.name, bytes: st.size });
  }
  biggest.sort((a, b) => b.bytes - a.bytes);
  return { dir, count, total, biggest: biggest.slice(0, 3) };
}

function auditOne(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let project;
  try { project = JSON.parse(raw); } catch (err) {
    console.log(`\n=== ${path.basename(file)}`);
    console.log(`  ❌ 解析失败：${err.message}`);
    return;
  }
  const pretty = raw.length;                     // 磁盘上的真实字节（按 utf8 字符数近似）
  const compact = Buffer.byteLength(JSON.stringify(project), 'utf8');
  const onDisk = fs.statSync(file).size;

  console.log(`\n=== ${path.basename(file)}`);
  console.log(`  文件 ${mb(onDisk)} · 紧凑化后 ${mb(compact)}`
    + (onDisk > compact ? ` · **缩进占 ${(((onDisk - compact) / onDisk) * 100).toFixed(0)}%**` : ' · 已是紧凑 JSON ✅'));

  console.log('  顶层键（紧凑字节）：');
  const keys = Object.keys(project).map(k => ({ k, bytes: JSON.stringify(project[k] === undefined ? null : project[k]).length }));
  keys.sort((a, b) => b.bytes - a.bytes);
  for (const it of keys) {
    const pct = compact ? ((it.bytes / compact) * 100).toFixed(1) : '0';
    console.log(`  · ${it.k.padEnd(12)} ${mb(it.bytes).padStart(10)}  ${pct}%`);
  }

  console.log('  快照：');
  const snap = auditSnapshots(project);
  for (const l of snap.lines) console.log(l);
  if (snap.total > 3 * MB) {
    console.log(`  ⚠️ 快照 ${mb(snap.total)} 超过 3 MB 上限 —— 0.2.4 起 pushSnapshot 会自动丢最旧的`
      + '（折进 base），再存一次盘即可回落。');
  }

  // 省份多边形规模（用户真正关心的量级）
  // ⚠️ 2026-10-29 修：`extraRings` 里既有**裸点数组**，也有 `{points, kind}` 环描述对象
  //    （多环省/带洞省），旧实现直接 `.length` → 那些省算出 undefined，整行变成 "NaN 个顶点"。
  //    这里两种形态都认：环描述取 `.points`，裸数组取自身。
  const ringPoints = (ring) => {
    if (Array.isArray(ring)) return ring.length;
    if (ring && Array.isArray(ring.points)) return ring.points.length;
    return 0;
  };
  const baseMaps = (project.scenarios && project.scenarios.baseMaps) || {};
  for (const [k, bm] of Object.entries(baseMaps)) {
    const terrain = (bm && bm.terrain) || [];
    let points = 0;
    for (const p of terrain) {
      for (const ring of [p.points, ...((p.extraRings) || [])]) points += ringPoints(ring);
      if (Array.isArray(p.holes)) for (const h of p.holes) points += ringPoints(h);
    }
    console.log(`  底图「${k}」：${terrain.length} 块省份 / ${points} 个顶点`);
  }

  if (true) {
    const b = auditBackups(file);
    console.log('  整文件备份：');
    if (!b) console.log('  · （没有 .backups 目录）');
    else {
      console.log(`  · ${b.count} 份 / ${mb(b.total)} ← ${b.dir}`);
      for (const x of b.biggest) console.log(`  · 最大：${x.name} ${mb(x.bytes)}`);
      console.log(`  · 提示：备份是"旧文件的整份拷贝"（用于关闭司天后覆盖回项目），`);
      console.log(`    份数固定 10 份 + 1 份会话基线；正文变小后它会等比例变小。`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法：node scripts/audit-project-size.js [--project <file.sitian>] [--all] [--no-backups]');
    return;
  }
  const dir = defaultDir();
  if (args.project) {
    auditOne(path.resolve(args.project));
    return;
  }
  const list = listProjects(dir);
  if (!list.length) {
    console.log(`默认目录里没找到 .sitian：${dir}`);
    console.log('用 --project <路径> 指定项目文件。');
    return;
  }
  if (args.all) {
    console.log(`默认目录：${dir}`);
    for (const it of list) console.log(`  ${mb(it.bytes).padStart(10)}  ${it.file}`);
    return;
  }
  console.log(`默认目录：${dir}（共 ${list.length} 个项目，审计最大的那个；--all 看全部）`);
  auditOne(list[0].file);
}

main();
