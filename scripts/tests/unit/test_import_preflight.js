#!/usr/bin/env node
/**
 * Node 单测：导入前体检（2026-11-08，搬家前置）
 *
 * 背景：真库实测（`build/_vault-audit-20261108/`）里 143 个节点 100% 连通，
 * 但有 5 个地点没有任何上层线索、31 条“待人工”里 25 条根本不是地图页。
 * 本用例守的就是这三件：
 *   ① 目录兜底：`02 场景地点/07 粘土世界/至日剑封印地.md` 挂在目录同名节点下；
 *      目录没有同名笔记时造一个空壳父节点（`synthesized: true`），不是把地点丢到根上；
 *   ② 桶目录不兜底：`99 杂项/` 不是地理容器，听证厅不许被挂到“杂项”底下（负向探针）；
 *      层级目录（`星域/`、`星系/`）也不算容器名，不许造一个叫“星域”的实体（负向探针）；
 *   ③ 占位名不造节点：`tags: [待补充]` 不许变成区域节点；
 *   ④ 报告分流：散文/帮助页进 `nonMap`（不催、不丢），解析失败与真断点留在 `needsHuman`。
 *
 * 用法：node scripts/tests/unit/test_import_preflight.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));
const classify = require(path.join(ROOT, 'scripts', 'lib', 'vaultClassify.js'));
const { extractGeodata } = require(path.join(ROOT, 'scripts', 'extract-data.js'));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: (e && e.message) || String(e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, label) {
  if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const FILES = {
  // ── 两个世界：粘土世界有笔记，柯依尔世界只有目录 ──
  '03 设定/11 地理系统/世界/粘土世界.md': '---\n层级: 世界\n---\n世界观总览。\n',
  // ── 目录兜底（挂到已存在的同名节点）──
  '03 设定/02 场景地点/07 粘土世界/至日剑封印地.md': '---\n层级: 设施\n---\n封印地。\n',
  // ── 目录兜底（目录没有同名笔记 → 造空壳父节点）──
  '03 设定/02 场景地点/05 柯依尔世界/莱姆哈顿.md': '---\n层级: 城市\n---\n城里。\n',
  // ── 负向探针：桶目录不是地理容器 ──
  '03 设定/99 杂项/人工智能监管厅听证厅.md': '---\n层级: 设施\n---\n还没建地图的听证厅。\n',
  // ── 负向探针：层级目录不是实体名 ──
  '03 设定/11 地理系统/星域/孤星域.md': '---\n层级: 星域\n---\n孤零零一个星域。\n',
  // ── 占位名：两篇共用 tags [待补充]，不许长出“待补充”节点 ──
  '03 设定/02 场景地点/07 粘土世界/甲馆.md': '---\n层级: 设施\ntags: [待补充]\n---\n甲。\n',
  '03 设定/02 场景地点/07 粘土世界/乙馆.md': '---\n层级: 设施\ntags: [待补充]\n---\n乙。\n',
  // ── 散文：不是地图页 ──
  '随笔/茶叶统计.md': '只有一段散文，没有任何字段。\n',
};

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-preflight-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
  return dir;
}

function snapshot(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.sitian') { out.push(['.sitian', 0, 0]); continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push([path.relative(root, full).replace(/\\/g, '/'), fs.statSync(full).size]);
    }
  })(root);
  out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(out);
}

async function main() {
  const vault = makeVault();
  const before = snapshot(vault);
  // 目录兜底是**可选**的：容器目录由调用方给（这里模拟用户配置）
  const containerDirs = ['03 设定/02 场景地点', '03 设定/11 地理系统'];
  const payload = await extractGeodata(vault, {
    generic: true, writeCache: false, forceFull: true, collectReport: true, containerDirs,
  });
  const nodes = payload.nodes || [];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const index = vi.buildIndex(vault, { forceFull: true, write: false }).index;
  const report = vi.classifyReport(index, { containerDirs });

  await check('一：目录兜底 —— 挂到目录同名的已有节点', () => {
    const node = byName.get('至日剑封印地');
    assert(node, '至日剑封印地应在节点表里');
    eq(node.parentId, '粘土世界', '父应为粘土世界');
    // 大小写两种形状都对：通用路径由分类器给出 `inferred:directory`，标准路径由提取器补 `directory`。
    // 判据只认“来源是目录”，不认字符串长相。
    assert(/directory$/i.test(String(node.parentSource || '')),
      `父来源必须标 directory（不是 frontmatter），实际 ${JSON.stringify(node.parentSource)}`);
    return '至日剑封印地 → 粘土世界（目录）';
  });

  await check('二：目录兜底 —— 目录没有同名笔记时造空壳父节点', () => {
    const parent = byName.get('柯依尔世界');
    assert(parent, '应造出空壳父节点 柯依尔世界');
    eq(parent.synthesized, true, '空壳必须带 synthesized 标记');
    eq(parent.sourcePath, '', '空壳没有源文件');
    eq(parent.layer, 'world', '“柯依尔世界”应以层级词收尾 → world');
    eq(byName.get('莱姆哈顿').parentId, '柯依尔世界', '莱姆哈顿应挂在空壳下');
    const syn = (payload.report && payload.report.synthesized) || [];
    assert(syn.some((s) => s.name === '柯依尔世界'), '报告里要记下造了哪些空壳');
    return '柯依尔世界（空壳, world）→ 莱姆哈顿';
  });

  await check('三：负向探针 —— 桶目录（99 杂项）不许当父', () => {
    const node = byName.get('人工智能监管厅听证厅');
    assert(node, '听证厅仍是地图实体（用户：还没建地图的真地点）');
    eq(node.parentId, null, '不许挂到“杂项”底下');
    assert(!byName.has('杂项'), '更不许造一个叫“杂项”的实体');
    return '听证厅留在根上（父待定），没有造“杂项”';
  });

  await check('四：负向探针 —— 层级目录（星域/）不算容器名', () => {
    const node = byName.get('孤星域');
    assert(node, '孤星域应在节点表里');
    eq(node.parentId, null, '星域目录没有上层信息时不许硬造父级');
    assert(!byName.has('星域'), '不许造一个叫“星域”的实体（那是层级维度，不是地方）');
    return '孤星域留在根上，没有造“星域”';
  });

  await check('五：占位名不进实体表（tags: [待补充] 不造节点）', () => {
    assert(!byName.has('待补充'), '不许把“待补充”造成节点');
    assert(byName.has('甲馆') && byName.has('乙馆'), '两篇真笔记不受影响');
    return '两篇共用 [待补充] 标签，树上没有“待补充”';
  });

  await check('六：报告分流 —— 散文进 nonMap、真断点留 needsHuman', () => {
    const nm = (report.nonMap || []).map((x) => x.path);
    assert(nm.includes('随笔/茶叶统计.md'), '散文应进 nonMap');
    const need = (report.needsHuman || []).map((x) => x.path);
    assert(!need.includes('随笔/茶叶统计.md'), '散文不许混进待人工');
    assert(need.includes('03 设定/99 杂项/人工智能监管厅听证厅.md'), '没有上层的真地点留在待人工');
    assert(need.includes('03 设定/11 地理系统/星域/孤星域.md'), '没有上层的星域留在待人工');
    eq(need.length, 2, '本夹具的待人工应恰好 2 条（听证厅 + 孤星域）');
    return `待人工 ${need.length} / 不是地图页 ${nm.length}`;
  });

  await check('七：确定性 —— 连跑两次节点集合一致（空壳 id 不抖）', async () => {
    const again = await extractGeodata(vault, {
      generic: true, writeCache: false, forceFull: true, collectReport: true, containerDirs,
    });
    const ids = (p) => p.nodes.map((n) => `${n.id}|${n.layer}|${n.parentId || ''}`).sort().join('\n');
    eq(ids(again), ids(payload), '两次提取的 节点/层级/父 必须一致');
    return `${payload.nodes.length} 个节点的身份两次一致`;
  });

  await check('八：只读 —— 不建 .sitian、不改任何笔记', () => {
    eq(snapshot(vault), before, '库指纹必须逐字节一致');
    return `${Object.keys(FILES).length} 篇未改动；无 .sitian`;
  });

  await check('九：★ 不配置容器目录 = 不猜（通用默认，别人的库不该被套上我们的目录习惯）', async () => {
    const opts = { generic: true, writeCache: false, forceFull: true, collectReport: true };
    const plain = await extractGeodata(vault, opts);
    assert(plain.nodes.some((n) => n.name === '至日剑封印地' && !n.parentId),
      '不配置时不许自动挂到目录同名节点');
    assert(!plain.nodes.some((n) => n.synthesized), '不配置时不许造空壳节点');
    const plainReport = vi.classifyReport(vi.buildIndex(vault, { forceFull: true, write: false }).index);
    const need = (plainReport.needsHuman || []).map((x) => x.path);
    assert(need.length >= 4, `不配置时应把缺口如实报成待人工（实际 ${need.length}）`);
    // 但**建议**要给出来：同一个目录下攒够 2 条缺上层的，就建议把它当容器
    const sugg = plainReport.containerSuggestions || [];
    assert(sugg.some((s) => s.dir === '03 设定/02 场景地点' && s.count >= 2),
      `应给出容器建议（不自动应用）：${JSON.stringify(sugg)}`);
    return `不配置：空壳 0 / 待人工 ${need.length} / 建议 ${sugg.map((s) => `${s.dir}(${s.count})`).join('、')}`;
  });

  const ok = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}  — ${r.detail}`);
  console.log(`\n${ok}/${results.length} 通过`);
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
  if (ok !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
