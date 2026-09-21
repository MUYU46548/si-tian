#!/usr/bin/env node
/**
 * clean-cache-junk.js — 清理 .sitian 缓存里的历史垃圾（空名地形 / 空壳底图 / 测试残留节点）
 *
 * 背景：三类垃圾都由历史 bug 产生，现行代码不再生成
 *   1. terrain  空名地形 —— PlanetMap 旧凸包笔刷产出的 `name: ''` 多边形（本库实测 22 个），
 *      在画布上渲染成无标识图块，地形列表/图例里也会出现空条目。
 *   2. basemap  空壳底图 —— 早期「打开剧本模式就凭空建一张默认底图」的产物（本库实测 `德斯特星`：
 *      terrain 为空、无 heightmap、无参考图、没有任何剧本的 ownerKey 指向它）。该默认行为已删除。
 *   3. testnode 测试残留节点 —— 历史测试/联调把节点写进真实库缓存的产物（如 `测试建筑`）。
 *
 * 安全约定（不丢数据优先）
 *   1. 默认 **只报告**（dry-run）；加 `--apply` 才写盘。
 *   2. 删空名地形前自检：① 其 id 没有被该行星的其他字段引用；② 删除后地形包围盒不变
 *      （变了会让涂色网格原点重推 → 已涂的 terrainGrid 错位）；③ 地形不会因此清空。
 *   3. 删底图前自检：没有任何剧本（或文件其他部分）引用它；且底图不会因此清空。
 *   4. 删测试节点前自检：没有别的节点挂在它下面。
 *   5. 写盘前把受影响文件整体备份到 <repo>/backups/cleanup-<ts>/，被移除条目原样存档到同名 archived-*.json。
 *
 * 用法
 *   node scripts/clean-cache-junk.js                          # 查看报告（不改文件）
 *   node scripts/clean-cache-junk.js --apply                  # 备份 + 清理
 *   node scripts/clean-cache-junk.js --only=terrain,basemap    # 只处理指定类别（terrain|basemap|testnode）
 *   node scripts/clean-cache-junk.js --vault D:/Vault
 */
const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const vaultIdx = ARGS.indexOf('--vault');
const VAULT = (vaultIdx !== -1 ? ARGS[vaultIdx + 1] : null)
  || process.env.SITIAN_VAULT
  || 'E:/图书馆/ROSA';

const onlyArg = ARGS.find(a => a.startsWith('--only='));
const CATS = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)
  : ['terrain', 'basemap', 'testnode'];
const on = (c) => CATS.includes(c);

const SITIAN_DIR = path.join(VAULT, '.sitian');
const PATHS = {
  mapdata: path.join(SITIAN_DIR, 'mapdata.json'),
  scenarios: path.join(SITIAN_DIR, 'scenarios.json'),
  geodata: path.join(SITIAN_DIR, 'geodata.json'),
};
// 备份放项目目录（.sitian/ 是缓存层，不往里塞人看的东西）；与 migrate-mapdata-keys.js 一致
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

/** 地形包围盒（世界单位）；无点时返回 null */
function bbox(terrain) {
  const xs = [];
  const ys = [];
  for (const t of terrain || []) {
    for (const p of t.points || []) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  if (!xs.length) return null;
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const sameBBox = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const removed = { terrain: [], basemap: [], testnode: [] };
const plan = [];      // 待写文件
let skipped = 0;

// ─── 1) 空名地形 ────────────────────────────────────────────────────────────
if (on('terrain') && fs.existsSync(PATHS.mapdata)) {
  const mapdata = readJson(PATHS.mapdata);
  let touched = false;
  for (const [key, entry] of Object.entries(mapdata)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.terrain)) continue;
    const junk = entry.terrain.filter(t => !String((t && t.name) || '').trim());
    if (!junk.length) continue;
    const keep = entry.terrain.filter(t => !junk.includes(t));
    const ids = junk.map(t => t.id).filter(Boolean);
    // ② 包围盒不变
    if (!sameBBox(bbox(entry.terrain), bbox(keep))) {
      console.log(`  ⚠️ 跳过 [${key}]：删除空名地形会改变地形包围盒（涂色网格原点会漂移）`);
      skipped += junk.length;
      continue;
    }
    // ① 没有其他字段引用这些 id
    const rest = { ...entry };
    delete rest.terrain;
    const restStr = JSON.stringify(rest);
    const refd = ids.filter(id => restStr.includes(id));
    if (refd.length) {
      console.log(`  ⚠️ 跳过 [${key}]：空名地形被其他字段引用 ${JSON.stringify(refd.slice(0, 3))}`);
      skipped += junk.length;
      continue;
    }
    // ③ 不清空
    if (!keep.length) {
      console.log(`  ⚠️ 跳过 [${key}]：删除后地形会清空`);
      skipped += junk.length;
      continue;
    }
    console.log(`  [${key}] 空名地形 ${junk.length} 个（共 ${entry.terrain.length} 个，保留 ${keep.length}）`
      + `，点数 ${junk.reduce((n, t) => n + (t.points || []).length, 0)}`);
    entry.terrain = keep;
    removed.terrain.push({ key, items: junk });
    touched = true;
  }
  if (touched) plan.push({ path: PATHS.mapdata, data: mapdata, name: 'mapdata' });
}

// ─── 2) 空壳底图 ────────────────────────────────────────────────────────────
if (on('basemap') && fs.existsSync(PATHS.scenarios)) {
  const scenarios = readJson(PATHS.scenarios);
  const baseMaps = scenarios.baseMaps || {};
  const keys = Object.keys(baseMaps);
  const shell = keys.filter((k) => {
    const b = baseMaps[k] || {};
    const hasTerrain = Array.isArray(b.terrain) && b.terrain.length > 0;
    const hasHeight = !!(b.heightmap && Object.keys(b.heightmap).length);
    const hasRef = Array.isArray(b.referenceImages) && b.referenceImages.length > 0;
    return !hasTerrain && !hasHeight && !hasRef;
  });
  if (!shell.length) {
    console.log('  （无）');
  }
  for (const k of shell) {
    // 自检：文件其他部分（剧本等）不能引用它；不能把底图清空
    const rest = JSON.stringify({ version: scenarios.version, scenarios: scenarios.scenarios });
    if (rest.includes(k)) {
      console.log(`  ⚠️ 跳过底图 [${k}]：仍被剧本或其他字段引用`);
      skipped += 1;
      continue;
    }
    if (keys.length - removed.basemap.length <= 1) {
      console.log(`  ⚠️ 跳过底图 [${k}]：删除后 baseMaps 会清空`);
      skipped += 1;
      continue;
    }
    console.log(`  [${k}] 空壳底图（terrain 0 / 无 heightmap / 无参考图 / 无剧本引用）`);
    removed.basemap.push({ key: k, item: baseMaps[k] });
  }
  if (removed.basemap.length) {
    for (const r of removed.basemap) delete baseMaps[r.key];
    scenarios.baseMaps = baseMaps;
    plan.push({ path: PATHS.scenarios, data: scenarios, name: 'scenarios' });
  }
}

// ─── 3) 测试残留节点 ────────────────────────────────────────────────────────
if (on('testnode') && fs.existsSync(PATHS.geodata)) {
  const geodata = readJson(PATHS.geodata);
  const nodes = geodata.nodes || [];
  const junk = nodes.filter(n => /^测试/.test(String((n && n.name) || '')));
  if (!junk.length) {
    console.log('  （无）');
  }
  const childOf = new Set(nodes.map(n => n.parentId).filter(Boolean));
  const doable = [];
  for (const n of junk) {
    if (childOf.has(n.id)) {
      console.log(`  ⚠️ 跳过节点 [${n.name}]：有子节点挂在它下面`);
      skipped += 1;
      continue;
    }
    doable.push(n);
  }
  for (const n of doable) {
    console.log(`  [${n.name}] layer=${n.layer} id=${n.id} parent=${n.parentId || '(根)'}`);
    removed.testnode.push({ id: n.id, item: n });
  }
  if (doable.length) {
    const dead = new Set(doable.map(n => n.id));
    geodata.nodes = nodes.filter(n => !dead.has(n.id));
    plan.push({ path: PATHS.geodata, data: geodata, name: 'geodata' });
  }
}

// ─── 汇总 / 落盘 ────────────────────────────────────────────────────────────
const total = removed.terrain.reduce((n, r) => n + r.items.length, 0)
  + removed.basemap.length + removed.testnode.length;

console.log('');
console.log(`汇总：将移除 空名地形 ${removed.terrain.reduce((n, r) => n + r.items.length, 0)} 个 / `
  + `空壳底图 ${removed.basemap.length} 张 / 测试节点 ${removed.testnode.length} 个`
  + (skipped ? `（跳过 ${skipped} 个，见上方 ⚠️）` : ''));

if (!total) {
  console.log('缓存里没有可清理的历史垃圾 ✓');
  process.exit(0);
}

if (!APPLY) {
  console.log('（dry-run：未写盘。加 --apply 执行清理）');
  process.exit(0);
}

const dir = path.join(BACKUP_DIR, `cleanup-${ts()}`);
fs.mkdirSync(dir, { recursive: true });
for (const p of plan) {
  fs.copyFileSync(p.path, path.join(dir, path.basename(p.path)));
  writeJson(p.path, p.data);
  console.log(`  写入 ${p.name}.json（原文件已备份到 ${path.relative(path.join(__dirname, '..'), dir)}/）`);
}
writeJson(path.join(dir, 'archived-removed.json'), removed);
console.log(`已清理 ${total} 项；被移除条目原样存档：`
  + `${path.relative(path.join(__dirname, '..'), path.join(dir, 'archived-removed.json'))}`);
