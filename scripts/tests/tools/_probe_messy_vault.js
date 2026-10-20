#!/usr/bin/env node
// S0 资料线探针（不是回归用例）：把「不听话的库」喂给现有提取器，记录它到底看到几篇、会不会崩。
//
// 用法：
//   node scripts/tests/tools/_probe_messy_vault.js
//   node scripts/tests/tools/_probe_messy_vault.js <fixtureDir>
//
// 为什么在**临时副本**上跑：extractGeodata 会写 `.sitian/extract-cache.json`，
// 不能让探针污染入库夹具。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { extractGeodata, listScannedNotes, SCAN_SCOPE } = require(path.join(ROOT, 'scripts', 'extract-data.js'));

const src = process.argv[2] || path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture-messy');
const dst = path.join(os.tmpdir(), `sitian-messy-${Date.now()}`);

function walkMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.obsidian' || e.name === '.sitian' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.toLowerCase().endsWith('.md')) out.push(path.relative(src, p).replace(/\\/g, '/'));
  }
  return out;
}

async function main() {
  const result = { fixture: src, scanScope: SCAN_SCOPE };
  try {
    fs.cpSync(src, dst, { recursive: true });
    result.totalMd = walkMd(dst).length;
    const scanned = listScannedNotes(dst);
    result.scanned = scanned.map((n) => n.sourcePath);
    result.scannedCount = scanned.length;
    try {
      // 🔴 extractGeodata 是 async：不 await 会把「拒绝」当成「返回了一个没有 nodes 的对象」，
      //    看起来像“提取成功但 0 节点”——这正是本项目最怕的假绿。
      const g = await extractGeodata(dst);
      result.extract = { ok: true, nodeCount: g.nodeCount, nodes: (g.nodes || []).map((n) => ({ name: n.name, layer: n.layer, sourcePath: n.sourcePath })) };
    } catch (e) {
      result.extract = { ok: false, error: e && e.message, code: e && e.code };
    }
  } finally {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.extract && result.extract.ok ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
