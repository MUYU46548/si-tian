#!/usr/bin/env node
// 账本 v2 迁移（2026-10-21，大修 B 第二块）
//
// 做什么：把每个剧本从「ownership 终态快照 + 少量 changeEvents」迁到
//   initialOwnership（本代开始时的归属）+ changeEvents（显式 + 合成事件，带 synthesized 标记）
// `ownership` **保留**为缓存（双写），旧版本仍能读；v2 的派生值必须与它逐省一致。
//
// 安全：
//   · 默认 dry-run，只出清点表，一个字节都不写；
//   · --apply 前先备份项目文件（backups/ledger-v2-<ts>/）并落 manifest；
//   · 任何一省派生 ≠ 快照 → 拒绝 apply（宁可不迁，也不写一份自相矛盾的数据）。
//
// 用法：
//   node scripts/migrate-ledger-v2.mjs --project <file.sitian>            # dry-run
//   node scripts/migrate-ledger-v2.mjs --project <file.sitian> --apply    # 写盘（先备份）
//   ⚠️ 跑 --apply 前先在司天里关闭该项目（内存态会把改动盖回去）。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

function parseArgs(argv) {
  const out = { project: '', apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') out.project = argv[++i] || '';
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

async function loadModule() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ledger-v2-'));
  const fix = (s) => s.replace(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g, "from './$1.js'");
  const seen = new Set();
  const q = ['scenarioLedgerV2.js', 'scenarioTimeline.js', 'scenarioDates.js'];
  while (q.length) {
    const f = q.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const full = path.join(SRC, f);
    if (!fs.existsSync(full)) continue;
    const code = fs.readFileSync(full, 'utf8');
    fs.writeFileSync(path.join(tmp, f), fix(code));
    for (const m of code.matchAll(/from '\.\/([A-Za-z0-9_-]+)(\.js)?'/g)) q.push(`${m[1]}.js`);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const mod = await import(pathToFileURL(path.join(tmp, 'scenarioLedgerV2.js')).href);
  return { mod, tmp };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log('用法: node scripts/migrate-ledger-v2.mjs --project <file.sitian> [--apply]');
    return args.help ? 0 : 2;
  }
  if (!fs.existsSync(args.project)) {
    console.error('项目文件不存在：' + args.project);
    return 2;
  }
  const raw = fs.readFileSync(args.project, 'utf8');
  const project = JSON.parse(raw);
  const dict = project?.scenarios?.scenarios;
  if (!dict || typeof dict !== 'object') {
    console.error('这个项目里没有 scenarios.scenarios');
    return 2;
  }
  const { mod, tmp } = await loadModule();
  try {
    const plan = mod.planLedgerV2(dict);
    console.log('=== 账本 v2 迁移（' + (args.apply ? 'APPLY' : 'dry-run') + '）===');
    console.log('项目:', args.project, '(' + fmtBytes(raw.length) + ')');
    console.log('剧本:', plan.list.length, '个');
    for (const e of plan.report.eras) {
      console.log(`  era ${plan.report.eras.indexOf(e)} ${e.name || e.id}: initial=${e.initial} / events=${e.events} / 派生冲突=${e.mismatch}`,
        e.samples.length ? JSON.stringify(e.samples) : '');
    }
    console.log('总派生冲突:', plan.report.mismatchTotal);
    if (plan.report.mismatchTotal > 0) {
      console.error('🔴 有省份的派生归属与快照不一致 —— 拒绝写盘（先查数据，不要迁一份自相矛盾的文件）');
      return 1;
    }
    // 体积预估
    const nextProject = { ...project, scenarios: { ...project.scenarios, scenarios: plan.dict } };
    const nextText = JSON.stringify(nextProject);
    console.log('预计体积:', fmtBytes(raw.length), '→', fmtBytes(nextText.length),
      `(${nextText.length >= raw.length ? '+' : ''}${(((nextText.length - raw.length) / raw.length) * 100).toFixed(1)}%)`);

    if (!args.apply) {
      console.log('\n[dry-run] 未写盘。确认无误后加 --apply（会先备份）。');
      return 0;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakDir = path.join(ROOT, 'backups', 'ledger-v2-' + ts);
    fs.mkdirSync(bakDir, { recursive: true });
    const base = path.basename(args.project, '.sitian');
    const before = path.join(bakDir, base + '-before.sitian');
    fs.copyFileSync(args.project, before);
    fs.writeFileSync(path.join(bakDir, 'manifest.json'), JSON.stringify({
      ts, project: args.project, before: path.basename(before),
      scenarios: plan.list.length, mismatch: plan.report.mismatchTotal,
      bytesBefore: raw.length, bytesAfter: nextText.length,
    }, null, 2));
    const tmpPath = args.project + '.tmp-ledger-v2';
    fs.writeFileSync(tmpPath, nextText);
    fs.renameSync(tmpPath, args.project);
    console.log('✅ 已写盘；备份:', before);

    // 读回校验：每个剧本 initial + 事件派生必须等于 ownership
    const back = JSON.parse(fs.readFileSync(args.project, 'utf8')).scenarios.scenarios;
    let bad = 0;
    for (const id of Object.keys(back)) {
      const v = mod.verifyScenarioLedger(back[id]);
      if (!v.ok) { bad++; console.log('  读回冲突:', id, JSON.stringify(v.diffs.slice(0, 3))); }
    }
    console.log('读回校验:', bad === 0 ? '全部一致' : `${bad} 个剧本不一致`);
    return bad === 0 ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
