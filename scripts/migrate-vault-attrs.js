#!/usr/bin/env node
/**
 * A-1：把存量「机器属性」从笔记搬进项目文件（搬家协议里的「搬家 + 清点 + 反向档」）
 *
 * 背景（《机器属性搬家——最终定案报告》①③④）
 *   现在「这是什么层级 / 挂在谁下面 / 属于哪类地点」这套**机器属性**由笔记 frontmatter 承载
 *   （`层级` / `上层区域` / `地点类型`）。用户必须人肉维护：看不懂的值要查表、还容易漏记 ——
 *   这就是「人肉替机器录数据」。定案：**结构归司天（`.sitian`），内容归笔记（vault）**。
 *   本脚本负责把**存量**搬过去；之后的「读路径切换」与「中文点选界面」是另外两步。
 *
 *   报告 ③ 的协议是：备份 → 搬家（纯复制）→ 清点 → 新旧并存跑一段 →（真要删时）删字段。
 *   本脚本实现前三件：**默认 dry-run 出清点表**，`--apply` 才写盘，写前整份备份 + 落反向档。
 *
 * 🔴 三条硬约束（不许破）
 *   1. **绝不覆盖项目里已有的值**。项目文件是构建层权威（用户可能在司天界面里改过）。
 *      只在项目侧**空**的时候补（layer 空 / `unknown`、parentId 空、placeType 空）；
 *      不一致一律进「冲突」清单**报告给人看**，不自动改。
 *   2. **绝不动笔记**。只读 —— 笔记里的原字段原地不动，这本身就是报告 ④ 里的「后悔药级」保险。
 *   3. **补 parentId 前必须校验目标父实体在项目里存在**，否则补上去就是悬空引用
 *      （项目校验会把悬空 parentId 静默置空 → 搬了个寂寞，还看不出为什么）。
 *
 * 用法
 *   node scripts/migrate-vault-attrs.js --project <file.sitian>              # 清点表（不写盘）
 *   node scripts/migrate-vault-attrs.js --project <file.sitian> --apply      # 备份 + 反向档 + 写入
 *   node scripts/migrate-vault-attrs.js --project x.sitian --vault D:/Vault  # 指定知识库
 *   node scripts/migrate-vault-attrs.js --project x.sitian --from-cache      # 用现有 .sitian/geodata.json
 *   node scripts/migrate-vault-attrs.js --project x.sitian --limit 20        # 抽查条数（默认 10）
 *
 * ⚠️ 跑 `--apply` 之前请先在司天里**关闭该项目**：脚本直接改 `.sitian` 文件，
 *    而司天的内存态会在下一次自动保存时把它盖回去（画布才是活副本 —— R7 的教训）。
 */
const fs = require('fs');
const path = require('path');
const { extractGeodata, normalizeRelPath } = require('./extract-data');
// 复用主进程的项目文件 IO（它顶层不 require electron，专为 Node 可测而设计）：
// 备份轮转、原子写都在那里**只有一份实现**，脚本不再写第二份
const { readProjectFile, writeProjectFile, atomicWriteJson, backupDirFor } = require('../src/main/handlers/projectHandler');

const DEFAULT_VAULT = 'E:/图书馆/ROSA';

/**
 * 解析命令行参数（**纯函数**：不读全局 argv，便于单测直接喂数组）。
 * 抽出它的原因：本仓的 Node 单测环境**无法再 spawn 一个 node 进程**（EBUSY），
 * 所以 CLI 外壳必须薄到「只有 parseArgs + runMigration」两层，逻辑层能被直接调用做端到端。
 */
function parseArgs(argv = []) {
  const has = (f) => argv.includes(f);
  const getArg = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : fallback;
  };
  const project = getArg('--project');
  return {
    projectPath: project ? path.resolve(project) : '',
    vault: getArg('--vault') || process.env.SITIAN_VAULT || DEFAULT_VAULT,
    apply: has('--apply'),
    fromCache: has('--from-cache'),
    limit: Math.max(1, Number(getArg('--limit', '10')) || 10),
    error: project ? '' : '缺少必需参数 --project <file.sitian>',
  };
}

const USAGE = [
  '用法：node scripts/migrate-vault-attrs.js --project <file.sitian> [--vault <path>] [--apply] [--from-cache] [--limit N]',
  '（默认 dry-run：只出清点表，不写盘）',
].join('\n');


/** 可搬的字段：与项目实体 / 画布节点同名的三个机器属性 */
const MIGRATABLE_FIELDS = ['layer', 'parentId', 'placeType'];
const FIELD_LABELS = { layer: '层级', parentId: '上层挂靠', placeType: '地点类型' };

/**
 * 项目侧该字段是否「空」（需要补）。
 * `layer` 额外把 `unknown` 当空 —— 提取器推断不出时写的就是它，等价于"没有层级"。
 */
function isBlank(entity, field) {
  const v = entity && entity[field];
  if (field === 'layer') return !v || v === 'unknown';
  if (field === 'parentId') return !v;
  return v === undefined || v === null || v === '';
}

/**
 * 生成搬家计划（**纯函数**，不改任何输入）。
 *
 * @param {{entities?: Object, vaultNodes?: Array}} input
 *   entities   —— 项目文件里的 `entities`（`{id: entity}`）
 *   vaultNodes —— 提取器产出的节点列表（含 `layer`/`layerLabel`/`parentId`/`placeType`/`sourcePath`）
 * @returns {{matched:number, patches:Array, conflicts:Array, parentMissing:Array,
 *            unmatchedEntities:Array, already:number, noteCount:number}}
 *   patches          待补的字段（只含"项目侧为空"的）
 *   conflicts        项目侧已有值且与笔记不同 → **不自动改**，交人看
 *   parentMissing    笔记给了父级，但那个父实体在项目里不存在 → 跳过并点名
 *   unmatchedEntities 有 sourcePath 但库里找不到对应笔记（多半是改名了 → 先跑「检查笔记改名」）
 */
function buildMigrationPlan({ entities = {}, vaultNodes = [] } = {}) {
  const byPath = new Map();
  for (const n of vaultNodes) {
    const p = normalizeRelPath(n && n.sourcePath);
    if (p) byPath.set(p, n);
  }

  const patches = [];
  const conflicts = [];
  const parentMissing = [];
  const unmatchedEntities = [];
  let matched = 0;
  let already = 0;

  for (const e of Object.values(entities)) {
    if (!e || !e.id) continue;
    const sp = normalizeRelPath(e.sourcePath);
    if (!sp) continue;                       // 用户自建实体（无来源笔记）不参与搬家
    const vn = byPath.get(sp);
    if (!vn) {
      unmatchedEntities.push({ id: e.id, name: e.name, sourcePath: sp });
      continue;
    }
    matched += 1;
    for (const field of MIGRATABLE_FIELDS) {
      const raw = vn[field];
      if (raw === undefined || raw === null || raw === '') continue;   // 笔记侧没有这项，无处可搬
      const to = field === 'parentId' ? normalizeRelPath(raw) : raw;

      if (!isBlank(e, field)) {
        // 项目侧已有值 → 权威优先；只在两者不一致时报告（一致则计入 already）
        if (String(e[field]) !== String(to)) {
          conflicts.push({ id: e.id, name: e.name, field, project: e[field], note: to, sourcePath: sp });
        } else {
          already += 1;
        }
        continue;
      }

      // 补 parentId 前校验父实体存在（否则补出悬空引用 → 会被校验静默置空）
      if (field === 'parentId' && !entities[to]) {
        parentMissing.push({ id: e.id, name: e.name, wantParentId: to, sourcePath: sp });
        continue;
      }

      const patch = { id: e.id, name: e.name, field, from: e[field] === undefined ? null : e[field], to, note: sp };
      if (field === 'layer') patch.label = vn.layerLabel || to;   // 徽标文案跟着一起补
      patches.push(patch);
    }
  }

  return { matched, patches, conflicts, parentMissing, unmatchedEntities, already, noteCount: byPath.size };
}

/**
 * 应用计划（**纯函数**：返回新 project，不改入参）。
 * @param {object} project 项目对象
 * @param {Array} patches buildMigrationPlan 的 patches
 */
function applyPatches(project, patches, { now = '' } = {}) {
  const ts = now || new Date().toISOString();
  const entities = { ...(project.entities || {}) };
  for (const p of patches) {
    const cur = entities[p.id];
    if (!cur) continue;
    const next = { ...cur, [p.field]: p.to, updatedAt: ts };
    if (p.label) next.layerLabel = p.label;
    entities[p.id] = next;
  }
  return { ...project, entities, meta: { ...(project.meta || {}), updated: ts } };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function fmtVal(v) {
  if (v === undefined || v === null || v === '') return '（空）';
  return String(v);
}

function countByField(list) {
  const out = {};
  for (const it of list) out[it.field] = (out[it.field] || 0) + 1;
  return out;
}

function fmtCounts(counts) {
  const parts = MIGRATABLE_FIELDS.filter(f => counts[f]).map(f => `${FIELD_LABELS[f]} ${counts[f]}`);
  return parts.length ? parts.join(' / ') : '无';
}

/** 渲染清点表文本（**纯函数**：返回字符串而不直接打印 —— 用例要能捕获全文做断言） */
function renderReport({ projectPath, srcLabel, entityCount, plan, limit }) {
  const L = [];
  L.push('');
  L.push('══════════ 搬家清点表 ══════════');
  L.push(`项目文件：${projectPath}（${entityCount} 个实体）`);
  L.push(`知识库：  ${srcLabel}`);
  L.push(`可认亲实体：${plan.matched} 个（按来源笔记路径配对；其余 ${plan.unmatchedEntities.length} 个认不到）`);
  L.push('');
  L.push(`  待补属性  ${plan.patches.length} 处    ${fmtCounts(countByField(plan.patches))}`);
  L.push(`  已一致    ${plan.already} 处`);
  L.push(`  冲突      ${plan.conflicts.length} 处    ${fmtCounts(countByField(plan.conflicts))}（**不改动**，见下）`);
  L.push(`  父级缺失  ${plan.parentMissing.length} 处（笔记给的父实体不在项目里 → 跳过）`);
  L.push(`  认不到    ${plan.unmatchedEntities.length} 个实体（来源笔记不在库里 → 先跑「检查笔记改名」重连）`);

  if (plan.patches.length) {
    L.push('');
    L.push(`── 抽查（前 ${Math.min(limit, plan.patches.length)} 条待补）──`);
    for (const p of plan.patches.slice(0, limit)) {
      L.push(`  ${p.name}  ${FIELD_LABELS[p.field]}: ${fmtVal(p.from)} → ${fmtVal(p.to)}    [${p.note}]`);
    }
    if (plan.patches.length > limit) L.push(`  …另有 ${plan.patches.length - limit} 条（用 --limit 调整）`);
  }
  if (plan.conflicts.length) {
    L.push('');
    L.push('── 冲突（项目值优先，脚本不动它们）──');
    for (const c of plan.conflicts.slice(0, limit)) {
      L.push(`  ${c.name}  ${FIELD_LABELS[c.field]}: 项目=${fmtVal(c.project)} vs 笔记=${fmtVal(c.note)}`);
    }
    if (plan.conflicts.length > limit) L.push(`  …另有 ${plan.conflicts.length - limit} 条`);
  }
  if (plan.parentMissing.length) {
    L.push('');
    L.push('── 父级缺失（笔记里有挂靠，项目里没有这个父实体 → 跳过，避免悬空引用）──');
    for (const p of plan.parentMissing.slice(0, limit)) {
      L.push(`  ${p.name}  期望父级=${p.wantParentId}`);
    }
  }
  if (plan.unmatchedEntities.length) {
    L.push('');
    L.push('── 认不到（这些实体的来源笔记在库里不存在）──');
    for (const u of plan.unmatchedEntities.slice(0, limit)) {
      L.push(`  ${u.name}  [${u.sourcePath}]`);
    }
  }
  return L.join('\n');
}

/**
 * 执行一次搬家（**可被直接调用的逻辑层**：不读 process.argv、不 process.exit）。
 * CLI 外壳只负责解析参数、把 `log` 接到 console、按返回值定退出码。
 *
 * @param {{projectPath:string, vault:string, fromCache?:boolean, apply?:boolean, limit?:number, log?:Function}} opts
 * @returns {Promise<{ok:boolean, error?:string, plan?:object, written?:boolean, bytes?:number,
 *                    backupPath?:string|null, archivePath?:string, entityCount?:number, srcLabel?:string, report?:string}>}
 */
async function runMigration({ projectPath, vault = DEFAULT_VAULT, fromCache = false, apply = false, limit = 10, log = () => {} } = {}) {
  if (!projectPath) return { ok: false, error: '缺少项目文件路径（--project）' };
  if (!fs.existsSync(projectPath)) return { ok: false, error: `项目文件不存在：${projectPath}` };

  const loaded = await readProjectFile(projectPath);
  const project = loaded.project || {};
  const entities = project.entities || {};

  // ── 取知识库侧的机器属性 ──
  let vaultNodes = [];
  let srcLabel = '';
  if (fromCache) {
    const cachePath = path.join(vault, '.sitian', 'geodata.json');
    if (!fs.existsSync(cachePath)) {
      return { ok: false, error: `--from-cache 指定了缓存来源，但文件不存在：${cachePath}` };
    }
    vaultNodes = (JSON.parse(fs.readFileSync(cachePath, 'utf-8')).nodes) || [];
    srcLabel = `缓存 ${cachePath}（${vaultNodes.length} 个节点）`;
  } else {
    const data = await extractGeodata(vault);
    vaultNodes = data.nodes || [];
    srcLabel = `实时提取 ${vault}（${vaultNodes.length} 个节点）`;
  }

  const plan = buildMigrationPlan({ entities, vaultNodes });
  const entityCount = Object.keys(entities).length;
  const report = renderReport({ projectPath, srcLabel, entityCount, plan, limit });
  log(report);

  if (!apply) {
    log('\n（dry-run：未写入任何文件。确认清点表无误后加 --apply）');
    return { ok: true, plan, written: false, entityCount, srcLabel, report };
  }
  if (plan.patches.length === 0) {
    log('\n没有需要补的属性 —— 未改动项目文件。');
    return { ok: true, plan, written: false, entityCount, srcLabel, report };
  }

  const next = applyPatches(project, plan.patches);
  const res = await writeProjectFile(projectPath, next, { backup: true });   // 内含旧文件备份（轮转 10 份）

  const archive = {
    version: 1,
    kind: 'migrate-vault-attrs',
    at: new Date().toISOString(),
    project: projectPath,
    vault,
    source: fromCache ? 'cache' : 'extract',
    entityCount,
    patchCount: plan.patches.length,
    // 反向档主体：这次到底把哪些字段从什么改成了什么（人可读、可逐条核）
    applied: plan.patches,
    conflicts: plan.conflicts,
    parentMissing: plan.parentMissing,
    unmatchedEntities: plan.unmatchedEntities,
  };
  const archivePath = path.join(backupDirFor(projectPath), `migrate-attrs-${stamp()}.json`);
  await atomicWriteJson(archivePath, archive);

  log('');
  log(`✅ 已补 ${plan.patches.length} 处属性（${fmtCounts(countByField(plan.patches))}）`);
  log(`   项目文件已写：${res.filePath}（${res.bytes} 字节）`);
  log(`   旧文件备份：  ${res.backupPath || '（无 —— 文件原本不存在）'}`);
  log(`   反向档：      ${archivePath}`);
  log('倒回办法：反向档逐条记着「哪个实体的哪个字段从什么改成了什么」；没再做别的改动时，');
  log('          直接用上面那份旧文件备份覆盖回去即可。');
  log('⚠️ 笔记未被改动（原字段原地不动）—— 这是报告 ④ 的「后悔药级」保险。');

  return {
    ok: true, plan, written: true, bytes: res.bytes, backupPath: res.backupPath || null,
    archivePath, entityCount, srcLabel, report,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error(USAGE);
    console.error(opts.error);
    process.exit(2);
  }
  const res = await runMigration({ ...opts, log: (...a) => console.log(...a) });
  if (!res.ok) {
    console.error(`搬家失败：${res.error}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, runMigration, buildMigrationPlan, applyPatches, isBlank, MIGRATABLE_FIELDS, FIELD_LABELS };

if (require.main === module) {
  main().catch((e) => {
    console.error('搬家失败：', (e && e.stack) || e);
    process.exit(1);
  });
}
