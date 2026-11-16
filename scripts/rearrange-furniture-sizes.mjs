#!/usr/bin/env node
/**
 * 家具真实尺寸重排命令（台账 A18，2026-11-16）
 *
 * ## 它解决什么
 *
 * 2026-11-13 之前，室内家具的平面尺寸是"整数凑的方块"（一张床 100×80，比单人床还小）。
 * 之后 UI 放新家具已经用真实尺寸（`interior/furnitureSizes.js`），**但旧项目里的数据没人改** ——
 * 用户说旧数据无所谓，可总得有个命令能把它们一次性掰回来，而不是让人一件件拖。
 *
 * ## 用法
 *
 *   node scripts/rearrange-furniture-sizes.mjs --project <文件.sitian>          # 默认 dry-run，只出清单
 *   node scripts/rearrange-furniture-sizes.mjs --project <文件.sitian> --apply  # 真写盘（先备份 + 写后回读校验）
 *   node scripts/rearrange-furniture-sizes.mjs --project <文件.sitian> --json   # 清单打成 JSON（给脚本用）
 *
 * 口径（与 UI 完全一致，见 `interior/furnitureSizes.js`）：
 *   · 只动家具；门/窗（洞口）与院落/园林/走廊/水池/围墙（地面区域）一律不动；
 *   · 尺寸已在容差内（默认 max(2cm, 3%)）→ 不动，所以命令可以反复跑，第二遍 0 改动；
 *   · 改尺寸**保持中心点**（x/y 是左上角，宽高变了要把左上角挪回去）；
 *   · 缺 width/height 的记进"坏尺寸"，**不猜**。
 *
 * ⚠️ 跑 `--apply` 之前先**在司天里关掉这个项目**：内存态会把改动盖回去。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  planFurnitureResize, applyFurnitureResize, FURNITURE_SIZES,
} from '../src/renderer/src/interior/furnitureSizes.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const projectPath = arg('project');
const apply = arg('apply') === 'true';
const asJson = arg('json') === 'true';
const toleranceCm = Number(arg('tolerance', '2')) || 2;

if (!projectPath) {
  console.error('用法：node scripts/rearrange-furniture-sizes.mjs --project <文件.sitian> [--apply] [--json] [--tolerance 2]');
  process.exit(2);
}
if (!fs.existsSync(projectPath)) {
  console.error(`找不到项目文件：${projectPath}`);
  process.exit(2);
}

const raw = fs.readFileSync(projectPath, 'utf8');
let project;
try {
  project = JSON.parse(raw);
} catch (e) {
  console.error(`项目文件不是合法 JSON：${e.message}`);
  process.exit(2);
}

const plan = planFurnitureResize(project, { toleranceCm });
const { stats, changes, skipped } = plan;

if (asJson) {
  console.log(JSON.stringify({ project: projectPath, stats, changes, skipped }, null, 2));
} else {
  console.log('=== 家具真实尺寸重排（A18）===');
  console.log(`项目：${projectPath}（${(raw.length / 1024).toFixed(0)} KB）`);
  console.log(`内部图：${stats.buildings} 栋 / ${stats.floors} 层 / 家具 ${stats.furniture} 件`);
  console.log(`已是真实尺寸：${stats.alreadyOk} 件 · 需要重排：${stats.changed} 件 · 跳过：${stats.skipped} 件`);

  if (stats.changed) {
    const byType = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
    console.log('\n按类型：');
    for (const [type, n] of byType) {
      const t = FURNITURE_SIZES[type] || { w: 80, h: 60 };
      console.log(`  · ${type.padEnd(10)} ${String(n).padStart(4)} 件 → 目标 ${t.w}×${t.h}`);
    }
    console.log('\n前 12 条明细（改前 → 改后，保持中心不动）：');
    for (const c of changes.slice(0, 12)) {
      console.log(`  · ${c.type}/${c.name || '(未命名)'}  ${c.from.w}×${c.from.h} → ${c.to.w}×${c.to.h}`
        + `  @(${c.from.x},${c.from.y}) → (${c.to.x},${c.to.y})`);
    }
    if (changes.length > 12) console.log(`  … 另有 ${changes.length - 12} 条`);
  }

  if (stats.skipped) {
    const reasons = {};
    for (const s of skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    console.log('\n跳过：' + Object.entries(reasons).map(([r, n]) => `${r} ${n} 件`).join(' · '));
    console.log('  （opening = 门窗洞口、area = 院落/园林/走廊/水池/围墙、bad-size = 缺尺寸；都不猜）');
  }
}

if (!stats.changed) {
  console.log('\n✅ 没有需要改的（已经是真实尺寸）');
  process.exit(0);
}
if (!apply) {
  console.log('\n（dry-run：一个字节都没写。要真写盘加 -- --apply，写前会自动备份）');
  process.exit(0);
}

// ── 写盘：先备份、再写、再回读校验 ──────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = `${projectPath}.backups`;
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `${path.basename(projectPath, '.sitian')}.rearrange-${stamp}.sitian`);
fs.copyFileSync(projectPath, backupPath);
// 比的是**字节数**，不是字符串长度：中文一个字符 3 个字节，拿 raw.length 比会把每份备份都判成"不完整"
const sourceBytes = Buffer.byteLength(raw, 'utf8');
const backupSize = fs.statSync(backupPath).size;
if (backupSize !== sourceBytes) {
  console.error(`❌ 备份不完整（${backupSize} / ${sourceBytes} 字节），已中止，原文件未动`);
  process.exit(1);
}

const next = applyFurnitureResize(project, changes);
fs.writeFileSync(projectPath, JSON.stringify(next), 'utf8');

// 回读校验：重新读盘 → 再跑一遍 plan，应当 0 改动（证明"改到位了且没有改坏别处"）
const after = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
const recheck = planFurnitureResize(after, { toleranceCm });
const furnitureBefore = stats.furniture;
const furnitureAfter = recheck.stats.furniture;

console.log(`\n已写盘：${projectPath}`);
console.log(`备份：${backupPath}`);
console.log(`回读校验：重排后仍有 ${recheck.stats.changed} 件未到位（应为 0）· 家具总数 ${furnitureBefore} → ${furnitureAfter}`);

if (recheck.stats.changed !== 0) {
  console.error('❌ 回读校验失败：还有家具没到位。备份在 ' + backupPath);
  process.exit(1);
}
if (furnitureAfter !== furnitureBefore) {
  console.error(`❌ 回读校验失败：家具总数变了（${furnitureBefore} → ${furnitureAfter}）—— 有东西被删了，备份在 ${backupPath}`);
  process.exit(1);
}
console.log('✅ 完成：家具尺寸已按真实尺寸重排，中心点未动，件数未变');
