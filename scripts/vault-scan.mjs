#!/usr/bin/env node
// scripts/vault-scan.mjs — 读料桥：把任意知识库**只读**扫成「地图实体 + 资料条目 + 待人工」
//
// 三刀序列·第二刀的验收入口（`02-司天-三刀序列.md` 任务二）：
//   · 不挑目录结构：任意路径/文件名都扫（标准目录存在时行为与提取器一致，缺失时自动全库归类）；
//   · 字段识别不再白名单：整份 frontmatter 参与归类（`scripts/lib/vaultClassify.js`）；
//   · 识别不了的**每条都有报告**（路径 + 为什么 + 凭据），零静默丢失；
//   · 空间关系：显式字段 → 正文双链 → 正文句式，逐级尝试；推断的标 `inferred`，找不到的进待人工；
//   · **绝不往库里写任何东西**：`buildIndex({write:false})`、`extractGeodata({writeCache:false})`，
//     输出目录在库内会直接拒绝；跑完再对库做一次指纹对比（文件数 + mtime + .sitian 有无）。
//
// 用法：
//   node scripts/vault-scan.mjs --vault "E:\图书馆\ROSA" --out "$env:TEMP\rosetta-scan"
//   node scripts/vault-scan.mjs --vault <库> --out <目录> --geodata     # 另存 geodata.json（试导）
//   node scripts/vault-scan.mjs --vault <库> --list-missing            # 只打印待人工
//
// 产物（全在 --out 下）：
//   scan-report.json   全量报告（分布 / 待人工 / 推断清单 / 提取报告）
//   待人工.md          给人看的清单（每条都写了为什么）
//   geodata.json       （可选）可被司天当作提取结果加载的节点表
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const vaultIndex = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));
const { extractGeodata } = require(path.join(ROOT, 'scripts', 'extract-data.js'));
const classify = require(path.join(ROOT, 'scripts', 'lib', 'vaultClassify.js'));

function parseArgs(argv) {
  const out = { vault: '', out: '', geodata: false, listMissing: false, json: false, sample: 30 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--vault') out.vault = argv[++i] || '';
    else if (k === '--out') out.out = argv[++i] || '';
    else if (k === '--geodata') out.geodata = true;
    else if (k === '--list-missing') out.listMissing = true;
    else if (k === '--json') out.json = true;
    else if (k === '--sample') out.sample = Number(argv[++i]) || 30;
    else if (k === '--help' || k === '-h') out.help = true;
  }
  return out;
}

/** 库指纹：只读（文件相对路径 + 大小 + mtime + `.sitian` 内文件清单） */
function snapshotVault(vault) {
  const rows = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '.obsidian') continue;
        walk(path.join(dir, e.name));
        continue;
      }
      if (!/\.md$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch (err) { continue; }
      rows.push([path.relative(vault, full).replace(/\\/g, '/'), st.size, Math.round(st.mtimeMs)]);
    }
  }
  walk(vault);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  // `.sitian` 里的缓存也是「库内文件」：只读取料一个字节都不该动它（实测证据靠这行）
  const sitianDir = path.join(vault, '.sitian');
  const sitian = [];
  if (fs.existsSync(sitianDir)) {
    for (const name of fs.readdirSync(sitianDir)) {
      const full = path.join(sitianDir, name);
      try {
        const st = fs.statSync(full);
        sitian.push([name, st.size, Math.round(st.mtimeMs)]);
      } catch (e) { /* 读不到就跳过 */ }
    }
    sitian.sort((a, b) => a[0].localeCompare(b[0]));
  }
  return { rows, hasSitian: fs.existsSync(sitianDir), sitian };
}

function sameSnapshot(a, b) {
  if (!a || !b || a.hasSitian !== b.hasSitian) return { ok: false, why: '.sitian 目录出现/消失' };
  if (a.rows.length !== b.rows.length) return { ok: false, why: `笔记数 ${a.rows.length} → ${b.rows.length}` };
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i];
    const y = b.rows[i];
    if (x[0] !== y[0] || x[1] !== y[1] || x[2] !== y[2]) return { ok: false, why: `变化：${x[0]}` };
  }
  const sa = JSON.stringify(a.sitian || []);
  const sb = JSON.stringify(b.sitian || []);
  if (sa !== sb) return { ok: false, why: '.sitian 内缓存文件被改动' };
  return { ok: true, why: '' };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.vault) {
    console.log('用法: node scripts/vault-scan.mjs --vault <库根> [--out <输出目录>] [--geodata] [--list-missing]');
    return args.help ? 0 : 2;
  }
  const vault = path.resolve(args.vault);
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    console.error('知识库不存在或不是目录：' + vault);
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out || path.join(os.tmpdir(), `sitian-vault-scan-${stamp}`));
  // 只读红线：输出目录不许在库内（哪怕只是 .sitian 以外的目录）
  try {
    classify.assertOutOutsideVault(outDir, vault);
  } catch (e) {
    console.error('🔴 ' + e.message);
    return 2;
  }

  const before = snapshotVault(vault);
  const t0 = Date.now();
  const { index, summary } = vaultIndex.buildIndex(vault, { forceFull: true, write: false });
  const report = vaultIndex.classifyReport(index);
  const elapsedMs = Date.now() - t0;

  // 提取（可选）：试导节点表；同样只读（不写库内缓存）
  let extraction = null;
  if (args.geodata) {
    extraction = await extractGeodata(vault, {
      generic: true, writeCache: false, forceFull: true, collectReport: true,
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    vault,
    readOnly: true,
    elapsedMs,
    summary,
    report,
    extraction: extraction
      ? { nodeCount: extraction.nodeCount, report: extraction.report }
      : null,
  };
  fs.writeFileSync(path.join(outDir, 'scan-report.json'), JSON.stringify(payload, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, '待人工.md'), classify.reportToMarkdown(report), 'utf-8');
  if (extraction) {
    fs.writeFileSync(path.join(outDir, 'geodata.json'), JSON.stringify(extraction), 'utf-8');
  }

  const after = snapshotVault(vault);
  const unchanged = sameSnapshot(before, after);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('=== 读料扫描（只读）===');
    console.log(`库：${vault}`);
    console.log(`扫描：${summary.total} 篇 / ${elapsedMs} ms（解析错误 ${summary.parseErrors}）`);
    const cats = report.byCategory || {};
    const parts = Object.keys(cats).sort((a, b) => cats[b] - cats[a])
      .map((k) => `${classify.CATEGORY_LABELS[k] || k} ${cats[k]}`);
    console.log('归类：' + parts.join(' / '));
    console.log(`地图实体：${report.geo.length}（上层为推断 ${report.inferred.length}）`
      + ` / 待人工：${report.needsHuman.length}`);
    if (extraction) {
      console.log(`试导节点：${extraction.nodeCount} 个（报告见 scan-report.json）`);
    }
    if (report.needsHuman.length) {
      console.log('\n待人工（前 ' + Math.min(args.sample, report.needsHuman.length) + ' 条）：');
      for (const n of report.needsHuman.slice(0, args.sample)) {
        console.log(`  · ${n.path}（${n.title || ''}）— ${(n.reasons || []).join('；')}`);
      }
      if (report.needsHuman.length > args.sample) {
        console.log(`  … 其余 ${report.needsHuman.length - args.sample} 条见 待人工.md`);
      }
    }
    console.log(`\n报告：${path.join(outDir, 'scan-report.json')}`);
    console.log(`清单：${path.join(outDir, '待人工.md')}`);
    if (extraction) console.log(`节点：${path.join(outDir, 'geodata.json')}`);
    console.log(`只读校验：${unchanged.ok ? '✅ 库内文件与 .sitian 均未改动' : '🔴 ' + unchanged.why}`);
    if (!unchanged.ok) return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
