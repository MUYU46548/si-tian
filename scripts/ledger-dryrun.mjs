#!/usr/bin/env node
// scripts/ledger-dryrun.mjs — 账本 v3（`src/ledger/` 事件流）迁移**试算**（2026-10-24 第 3 件）
//
// 只读：把每个剧本的 `initialOwnership + changeEvents` 迁成事件流，再用引擎回放，
// 与落盘缓存 `ownership` **逐省对拍**。任何一省不一致就非 0 退出（宁可不动，也不写自相矛盾的数据）。
// 本脚本**不写盘**：跑完自动核对文件大小/修改时间未变（证明一个字节都没动）。
//
// 用法：
//   node scripts/ledger-dryrun.mjs --project <file.sitian>
//
// ⚠️ 415 省孤本可以直接跑（只读）；要真写盘等第 4 件的写口落地，别现在手改。
import fs from 'fs';
import path from 'path';
import { loadRendererModule, repoRoot } from './lib/loadRendererUtils.mjs';

const ROOT = repoRoot();

function parseArgs(argv) {
  const out = { project: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') out.project = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const fmt = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log('用法: node scripts/ledger-dryrun.mjs --project <file.sitian>');
    return args.help ? 0 : 2;
  }
  if (!fs.existsSync(args.project)) {
    console.error('项目文件不存在：' + args.project);
    return 2;
  }
  const before = fs.statSync(args.project);
  const raw = fs.readFileSync(args.project, 'utf8');
  let project = null;
  try {
    project = JSON.parse(raw);
  } catch (e) {
    console.error('项目文件不是合法 JSON：' + e.message);
    return 2;
  }
  const dict = project && project.scenarios && project.scenarios.scenarios;
  if (!dict || typeof dict !== 'object') {
    console.error('这个项目里没有 scenarios.scenarios');
    return 2;
  }

  const { mod: L, cleanup } = await loadRendererModule('index.js', { srcDir: path.join(ROOT, 'src', 'ledger') });
  try {
    const t0 = process.hrtime.bigint();
    const plan = L.planMigration(dict, {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    console.log(`项目：${path.basename(args.project)}（${fmt(Buffer.byteLength(raw, 'utf8'))}）`);
    console.log(`剧本 ${plan.report.eras.length} 段 / 迁移耗时 ${ms.toFixed(1)}ms\n`);
    console.log('剧本 | 基线 | 事件 | 组 | 日区间 | 冲突');
    for (const era of plan.report.eras) {
      const range = `${era.dayRange[0]}..${era.dayRange[1]}`;
      console.log(`${era.key} | ${era.baseline} | ${era.events} | ${era.groups} | ${range} | ${era.mismatch}`);
      if (era.mismatch) {
        for (const s of era.samples) console.log(`     ↳ ${s.provinceId}: 账本=${s.from} 缓存=${s.to}`);
      }
    }
    // 只读自证
    const after = fs.statSync(args.project);
    const unchanged = after.size === before.size && after.mtimeMs === before.mtimeMs;
    console.log(`\n冲突总数：${plan.report.mismatchTotal}${unchanged ? '｜文件未被改动（只读自证）' : '｜⚠️ 文件被改动过！'}`);
    if (!unchanged) return 3;
    return plan.report.mismatchTotal === 0 ? 0 : 1;
  } finally {
    cleanup();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('试算失败：', e);
  process.exit(2);
});
