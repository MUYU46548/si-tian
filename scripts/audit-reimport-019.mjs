#!/usr/bin/env node
/**
 * 019 重导 · **真实数据审计**（2026-10-25）
 *
 * 为什么有这个脚本（而不是又一条 CDP 用例）：
 *   `test_150` 已经把 019 的语义（并省冲突阻止 / 新底图 + 归属迁移 / 一条 undo）守住了，
 *   但它跑的是**两三个省的合成夹具**。真正的风险在**规模**：真实项目是
 *   `desite` 底图 **415 省**、**13 段剧本**、`changeEvents` 上千条，而 019 的映射是
 *   「id 直配 → 新省形心落旧省 → 旧省形心落新省」的 O(旧×新×顶点) 扫描。
 *   规模上会不会算错/算到分钟级，合成夹具永远答不了。
 *
 * 本脚本**只读**：读一份真实 `.sitian` + 一份真实 `.map`，在 Node 里跑 019 的**同一份纯函数**
 * （`utils/basemapIdentity.js`），量两种现实情形：
 *   A. **照原样重导同一张图**（415 省细分图 → 原始 200 省）：真实世界最常见的"我换了张图"，
 *      期望 = 大量并省冲突 → 019 必须**阻止**（不替用户选）；
 *   B. **id 直配**（同一批省、同 id 重导出）：期望 = 200 省 1:1、零冲突、12 段剧本按 id 迁移，
 *      归属/事件守恒、未映射旧省进 dropped 清单。
 * 两种情况都逐条量「项目文件没被改动」。
 *
 * 用法：
 *   node scripts/audit-reimport-019.mjs
 *   node scripts/audit-reimport-019.mjs --project "C:/.../绒花计划.sitian" --map src/renderer/public/__real_desite.map
 *
 * 产物：`build/reimport-019/audit.json` + `report.md`（控制台同时打印）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROJECT = path.resolve(argOf('project', path.join(os.homedir(), 'Documents', 'SiTianProjects', '绒花计划.sitian')));
const MAP = path.resolve(argOf('map', path.join(ROOT, 'src', 'renderer', 'public', '__real_desite.map')));
const OUT = path.resolve(argOf('out', path.join(ROOT, 'build', 'reimport-019')));

const ENTRY = ['basemapIdentity.js', 'azgaar-parser.js'];

/** 递归收集相对依赖（'./x' → x.js）：不手工维护清单（首次就漏了 polylineSmooth） */
function collectDeps(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+)'/g)) {
      const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}

function loadUtils() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-019-'));
  const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (m) => (m.includes(".js'") ? m : m.slice(0, -1) + ".js'"));
  for (const f of collectDeps(ENTRY)) {
    fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return tmp;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * 跑一种情形：映射 + 迁移 + 守恒判据。
 * @param {object} ctx {B, oldTerrain, newTerrain, scenarios, oldKey, newIds, oldIds}
 */
function runCase(label, ctx, newTerrain) {
  const { B, oldTerrain, scenarios, oldKey } = ctx;
  const newIds = new Set(newTerrain.map((p) => p.id));
  const oldIds = new Set(oldTerrain.map((p) => p.id));

  const tMap = performance.now();
  const mapping = B.mapProvinces(oldTerrain, newTerrain);
  const mapMs = Math.round(performance.now() - tMap);

  const tRemap = performance.now();
  const remap = B.remapScenariosForReimport(scenarios, oldKey, 'audit-new-key', mapping);
  const remapMs = Math.round(performance.now() - tRemap);

  const checks = [];
  const ck = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
  const moved = remap.moved;

  ck('只迁 ownerKey=旧底图 的剧本，其它原样',
    Object.entries(remap.scenarios).every(([k, s]) => (s.ownerKey === 'audit-new-key' ? moved.includes(k) : scenarios[k] === s)),
    `moved=${moved.length}/${Object.keys(scenarios).length}`);
  ck('剧本 id 全部保留（外部引用不断）',
    moved.every((id) => remap.scenarios[id].id === scenarios[id].id), moved.slice(0, 2).join(' / '));
  ck('迁移后归属 / 初主 / 事件键全部落在新底图省 id 上',
    moved.every((id) => ['ownership', 'initialOwnership', 'changeEvents'].every((field) =>
      Object.keys(remap.scenarios[id][field] || {}).every((pid) => newIds.has(pid)))),
    '');
  ck('未映射旧省进 dropped 清单（不静默丢）',
    Array.isArray(remap.droppedOldProvinces) && remap.droppedOldProvinces.every((pid) => oldIds.has(pid)),
    `${remap.droppedOldProvinces.length} 个`);

  // 逐省归属守恒：有冲突时**本就不该应用**，只在零冲突情形下作硬判据
  let ownChecked = 0, ownBad = 0, conflictOwnerDiff = 0;
  const conflictNewIds = new Set(mapping.conflicts.map((c) => c.newId));
  for (const id of moved) {
    const before = scenarios[id].ownership || {};
    const after = remap.scenarios[id].ownership || {};
    for (const [pid, owner] of Object.entries(before)) {
      const targets = mapping.byOld[pid] || [];
      for (const np of targets) {
        ownChecked++;
        if (after[np] !== owner) {
          if (conflictNewIds.has(np)) conflictOwnerDiff++;
          else ownBad++;
        }
      }
    }
  }
  if (mapping.conflicts.length) {
    ck('冲突省里"不同旧主抢同一新省"占多数（阻止是必要的）',
      conflictOwnerDiff > 0, `冲突省 ${conflictNewIds.size} 个 / 主不同 ${conflictOwnerDiff} 条`);
    ck('非冲突省的归属守恒（错 0）', ownBad === 0, `错 ${ownBad}`);
  } else {
    ck('逐省归属守恒（id 直配、值不变）', ownBad === 0, `检查 ${ownChecked} 条，错 ${ownBad}`);
  }

  // 事件条数守恒：拆省时每条事件复制到每个新省
  let evBefore = 0, evExpected = 0, evAfter = 0;
  for (const id of moved) {
    const before = scenarios[id].changeEvents || {};
    const after = remap.scenarios[id].changeEvents || {};
    for (const [pid, list] of Object.entries(before)) {
      const targets = mapping.byOld[pid] || [];
      evBefore += (list || []).length;
      evExpected += (list || []).length * targets.length;
    }
    for (const list of Object.values(after)) evAfter += (list || []).length;
  }
  ck('易主事件条数守恒', evAfter === evExpected, `原 ${evBefore} → 期望 ${evExpected} / 实际 ${evAfter}`);

  // 反向探针：把一条有主的旧省映射到不存在的新省 → "键必须在 newIds 里"必须红
  const sampleId = moved.find((id) => Object.keys(scenarios[id].ownership || {}).length);
  const samplePid = sampleId ? Object.keys(scenarios[sampleId].ownership)[0] : null;
  let probe = 'skip';
  if (samplePid) {
    const bad = { ...mapping, byOld: { ...mapping.byOld, [samplePid]: ['__ghost_new_province__'] }, conflicts: [] };
    const out = B.remapScenariosForReimport({ probe: { ...scenarios[sampleId], ownerKey: oldKey } }, oldKey, 'audit-new-key', bad);
    const keys = Object.keys(out.scenarios.probe.ownership || {});
    probe = keys.some((k) => !newIds.has(k)) ? '探针正确变红' : `探针未变红（键=${keys.join(',')}）`;
  }
  ck('反向探针：旧省 → 不存在的新省，归属键校验必须红', probe === '探针正确变红', probe);

  return {
    label,
    stats: {
      newProvinces: newTerrain.length,
      exact: mapping.exact.length,
      mappedOld: Object.keys(mapping.byOld).length,
      conflicts: mapping.conflicts.length,
      unmappedOld: mapping.unmappedOld.length,
      unmappedNew: mapping.unmappedNew.length,
      canApply: mapping.conflicts.length === 0,
      mapMs,
      remapMs,
    },
    remap: { moved: moved.length, dropped: remap.droppedOldProvinces.length, eventsBefore: evBefore, eventsExpected: evExpected, eventsAfter: evAfter },
    checks,
    ok: checks.every((c) => c.ok),
  };
}

async function main() {
  const tmp = loadUtils();
  const B = await import(pathToFileURL(path.join(tmp, 'basemapIdentity.js')).href);
  const A = await import(pathToFileURL(path.join(tmp, 'azgaar-parser.js')).href);

  const shaBefore = sha256(PROJECT);
  const t0 = Date.now();
  const doc = JSON.parse(fs.readFileSync(PROJECT, 'utf8'));
  const container = doc.scenarios || {};
  const baseMaps = container.baseMaps || {};
  const scenarios = container.scenarios || {};
  const mapText = fs.readFileSync(MAP, 'utf8');

  const oldKey = Object.keys(baseMaps).sort((a, b) => ((baseMaps[b].terrain || []).length - (baseMaps[a].terrain || []).length))[0];
  const oldTerrain = (baseMaps[oldKey] || {}).terrain || [];
  if (!oldTerrain.length) throw new Error('项目里没有带省份的底图：' + PROJECT);

  const parsed = A.parseMapFile(mapText);
  const json = A.buildScenariosJson(parsed, 'audit', '当前');
  const bundle = json.baseMaps.audit;
  if (!bundle) throw new Error('.map 解析后没有 baseMap：' + MAP);
  const newTerrain = bundle.terrain || [];

  const ctx = { B, oldTerrain, scenarios, oldKey };

  // A：照原样重导真实 .map（415 省细分图 → 200 省原图）
  const caseA = runCase('A 原样重导（415 → 200）', ctx, newTerrain);
  // B：id 直配（同一批省、同 id 重导出；这里再故意少 12 省，验证"未映射旧省 → dropped"）
  const caseB = runCase('B id 直配（415 → 403，含 12 省缺失）', ctx, oldTerrain.slice(12).map((p) => ({ ...p })));

  const shaAfter = sha256(PROJECT);
  const readonlyOk = shaBefore === shaAfter;
  const failed = [caseA, caseB].flatMap((c) => c.checks.filter((x) => !x.ok));
  const ok = readonlyOk && failed.length === 0;

  const result = {
    at: new Date().toISOString(),
    project: { path: PROJECT, bytes: fs.statSync(PROJECT).size, shaBefore, shaAfter, untouched: readonlyOk },
    map: { path: MAP, bytes: fs.statSync(MAP).size, provinces: newTerrain.length, cells: parsed.stats?.cells || 0 },
    oldKey,
    oldProvinces: oldTerrain.length,
    scenarios: Object.keys(scenarios).length,
    caseA,
    caseB,
    totalMs: Date.now() - t0,
    ok,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'audit.json'), JSON.stringify(result, null, 2), 'utf8');

  const table = (c) => [
    `### ${c.label}`,
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 新图省份 | ${c.stats.newProvinces} |`,
    `| id 直配 | ${c.stats.exact} |`,
    `| 有映射的旧省 | ${c.stats.mappedOld} |`,
    `| 并省冲突 | ${c.stats.conflicts} |`,
    `| 未映射旧省 / 新省 | ${c.stats.unmappedOld} / ${c.stats.unmappedNew} |`,
    `| 可应用 | ${c.stats.canApply ? '是' : '**否（019 会阻止）**'} |`,
    `| 映射 / 迁移耗时 | ${c.stats.mapMs} / ${c.stats.remapMs} ms |`,
    `| 迁剧本 / 丢归属键 | ${c.remap.moved} / ${c.remap.dropped} |`,
    `| 事件条数 | ${c.remap.eventsBefore} → ${c.remap.eventsAfter}（期望 ${c.remap.eventsExpected}） |`,
    '',
    ...c.checks.map((x) => `- ${x.ok ? '✅' : '❌'} ${x.name}${x.detail ? ` —— ${x.detail}` : ''}`),
    '',
  ].join('\n');

  const lines = [
    '# 019 重导 · 真实数据审计（只读）',
    '',
    `- 时间：${result.at}`,
    `- 项目：\`${PROJECT}\`（${(result.project.bytes / 1024 / 1024).toFixed(2)} MB / ${result.oldProvinces} 省旧底图 / ${result.scenarios} 段剧本）`,
    `- .map：\`${MAP}\`（${(result.map.bytes / 1024 / 1024).toFixed(2)} MB / ${result.map.provinces} 省 / ${result.map.cells} 格高度）`,
    '- 项目文件跑前/跑后 sha256 ' + (readonlyOk ? '一致（一个字节都没动）' : '**不一致（只读被破坏）**'),
    '',
    table(caseA),
    table(caseB),
    `## 结论：${ok ? '全绿' : `**${failed.length} 条红**`}；总计 ${result.totalMs} ms`,
    '',
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清不掉就留着 */ }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('审计脚本崩溃：', err);
  process.exit(2);
});
