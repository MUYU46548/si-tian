#!/usr/bin/env node
// scripts/prune-backups.mjs — 备份目录瘦身（只按"份数"轮转，永远不删内容：超出的**移**进归档目录）
//
// 为什么需要它（2026-10-30 用户拍板「备份目录保留最近 3 份」）：
//   · 应用侧已经把**新**的滚动备份收成 3 份（`src/main/handlers/projectHandler.js#BACKUP_KEEP`），
//     但盘上已有的旧备份不会自己消失：真实项目 `绒花计划.sitian.backups` 实测 75.9MB / 10 份；
//   · 演练残留（`__019_drill_*.sitian.backups`）、迁移留底等目录也在按"每次一份"长大。
//
// 口径（写死，别在这里加启发式）：
//   1. 目标 = `*Documents*/SiTianProjects/*.sitian.backups/` 里的 `*.sitian` 文件
//      + `<库>/.sitian/backups/` 里的 `*.json` 文件；
//   2. **会话基线**（`*.session-baseline.sitian`）不参与轮转——它是"打开时的样子"，固定 1 份；
//   3. 每个目录按 mtime **保留最近 N 份**（默认 3），其余**移**到归档目录（不删）；
//   4. `--apply` 才动盘，默认 dry-run；
//   5. 移动前校验目标路径不在备份目录内（防手滑把归档放进原地）。
//
// 用法：
//   node scripts/prune-backups.mjs                 # dry-run（默认）
//   node scripts/prune-backups.mjs --apply
//   node scripts/prune-backups.mjs --keep 5 --archive E:/归档/司天备份 --apply

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const KEEP = Number(getArg('--keep', '3'));
const HOME = os.homedir();
const PROJECTS_DIR = getArg('--projects', path.join(HOME, 'Documents', 'SiTianProjects'));
const VAULT_CACHE_BACKUPS = getArg('--vault-backups', 'E:/图书馆/ROSA/.sitian/backups');
const ARCHIVE = getArg('--archive', path.join('E:/归档', `司天备份-${new Date().toISOString().slice(0, 10)}`));

const MB = (n) => `${(n / 1048576).toFixed(1)}MB`;

/** 一个备份目录里的"可轮转文件"（排除会话基线与非目标扩展名） */
function listRotatable(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.join(dir, e.name))
    .filter(p => p.toLowerCase().endsWith(ext) && !/\.session-baseline\.sitian$/i.test(p))
    .map(p => {
      const st = fs.statSync(p);
      return { path: p, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // 新 → 旧
}

const plan = [];
function consider(dir, ext, label) {
  if (!fs.existsSync(dir)) return;
  const files = listRotatable(dir, ext);
  const keep = files.slice(0, KEEP);
  const move = files.slice(KEEP);
  plan.push({
    label,
    dir,
    keep,
    move,
    keepBytes: keep.reduce((s, f) => s + f.size, 0),
    moveBytes: move.reduce((s, f) => s + f.size, 0),
  });
}

// ① 项目备份目录（每个项目一个 `<名>.sitian.backups/`）
if (fs.existsSync(PROJECTS_DIR)) {
  for (const e of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith('.sitian.backups')) continue;
    consider(path.join(PROJECTS_DIR, e.name), '.sitian', e.name);
  }
}

// ② 知识库缓存备份（`.sitian/backups/*.json`）
consider(VAULT_CACHE_BACKUPS, '.json', '.sitian/backups（库缓存）');

// 归档目录绝不能落在任何一个备份目录里面
const archiveAbs = path.resolve(ARCHIVE);
for (const p of plan) {
  const dirAbs = path.resolve(p.dir);
  if (archiveAbs === dirAbs || archiveAbs.startsWith(dirAbs + path.sep)) {
    console.error(`🔴 归档目录落在备份目录里：${archiveAbs} ⊂ ${dirAbs} —— 拒绝执行`);
    process.exit(2);
  }
}

let totalMove = 0;
let totalMoveBytes = 0;
console.log(`=== 备份瘦身（保留最近 ${KEEP} 份；${APPLY ? '**真的移**' : 'dry-run：不动盘'}）===`);
for (const p of plan) {
  console.log(`\n· ${p.label}`);
  console.log(`  保留 ${p.keep.length} 份（${MB(p.keepBytes)}）· 移走 ${p.move.length} 份（${MB(p.moveBytes)}）`);
  for (const f of p.move) console.log(`    → ${path.basename(f.path)}  ${MB(f.size)}`);
  totalMove += p.move.length;
  totalMoveBytes += p.moveBytes;
}
console.log(`\n合计：${plan.length} 个目录，移走 ${totalMove} 份 / ${MB(totalMoveBytes)} → ${archiveAbs}`);

if (!APPLY) {
  console.log('\n（dry-run 结束。确认无误加 `--apply`）');
  process.exit(0);
}

if (totalMove === 0) {
  console.log('没有需要移动的文件。');
  process.exit(0);
}

// 移动：保留原来的目录层级（`<备份目录名>/<文件名>`），便于对照找回。
// ⚠️ 归档盘与备份盘常常**不是同一个卷**（本项目：C: 项目目录 → E: 归档盘）——
//    `fs.rename` 跨卷必抛 `EXDEV`，所以这里一律「复制 → 校验大小 → 删源」，
//    不写成"先试 rename 失败再回落"（那会在跨卷时留下一半状态，且 EXDEV 之外还有别的失败形态）。
for (const p of plan) {
  if (!p.move.length) continue;
  const destDir = path.join(ARCHIVE, path.basename(p.dir));
  await fsp.mkdir(destDir, { recursive: true });
  for (const f of p.move) {
    let dest = path.join(destDir, path.basename(f.path));
    if (fs.existsSync(dest)) dest = path.join(destDir, `${path.basename(f.path)}.${Date.now()}`);
    await fsp.copyFile(f.path, dest);
    const copied = (await fsp.stat(dest)).size;
    if (copied !== f.size) {
      throw new Error(`复制校验失败（源 ${f.size}B / 目标 ${copied}B）：${f.path}`);
    }
    await fsp.unlink(f.path);
  }
}

// 复核：每个目录剩下的份数必须 ≤ KEEP
let bad = 0;
for (const p of plan) {
  const ext = path.extname(p.keep[0]?.path || p.move[0]?.path || '.sitian');
  const left = listRotatable(p.dir, ext).length;
  const mark = left <= KEEP ? '✅' : '🔴';
  if (left > KEEP) bad++;
  console.log(`  ${mark} ${p.label}: 剩余 ${left} 份`);
}
console.log(bad ? `\n🔴 ${bad} 个目录仍超限` : `\n✅ 完成：${totalMove} 份 / ${MB(totalMoveBytes)} 已归档到 ${ARCHIVE}`);
process.exit(bad ? 1 : 0);
