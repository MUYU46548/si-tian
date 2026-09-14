#!/usr/bin/env node
/**
 * 批次 R2-3：清理 .sitian/mapdata.json 中的旧（无世界前缀）key
 *
 * 背景
 *   P2-2 起 mapdata.json 的写盘 key 变为 `worldId/planetId`（如 `幻境/乐园星`），
 *   内存索引仍是 planetId。loadMapData（store/geodata.js）与主进程 get-map-data
 *   都保留了「新 key 无数据 → 回退读旧 key」的兼容分支，因此旧 key 永不参与
 *   读路径却一直留在文件里（本库实测：`乐园星` 5.8KB 陈旧快照 vs `幻境/乐园星` 1.5MB 现行数据）。
 *
 * 策略（不丢数据优先）
 *   1. 脚本默认 **只报告**（dry-run）；加 `--apply` 才写盘。
 *   2. 只处理「存在对应新 key」的旧 key —— 没有对应新 key 的旧 key 仍然会被
 *      回退分支读到，删除即数据丢失，一律保留并单独列在报告里。
 *   3. 写盘前先整体备份 mapdata.json 到 .sitian/backups/，
 *      并把被移除的旧条目原样存档到 .sitian/backups/archived-mapdata-legacy-<ts>.json。
 *      **旧 key 的独有内容不合并进现行数据**：那是用户主动重画后废弃的陈旧多边形，
 *      合并回去等于把已删除的地形复活（覆盖率差异只在报告里列出供人判断）。
 *
 * 用法
 *   node scripts/migrate-mapdata-keys.js                 # 查看报告（不改文件）
 *   node scripts/migrate-mapdata-keys.js --apply         # 备份 + 存档 + 清理
 *   node scripts/migrate-mapdata-keys.js --vault D:/Vault
 */
const fs = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const vaultIdx = ARGS.indexOf('--vault');
const VAULT = (vaultIdx !== -1 ? ARGS[vaultIdx + 1] : null)
  || process.env.SITIAN_VAULT
  || 'E:/图书馆/ROSA';

const SITIAN_DIR = path.join(VAULT, '.sitian');
const MAPDATA_PATH = path.join(SITIAN_DIR, 'mapdata.json');
const GEODATA_PATH = path.join(SITIAN_DIR, 'geodata.json');
const BACKUP_DIR = path.join(SITIAN_DIR, 'backups');

/** 实例内以 '/' 分隔的数组字段（用于覆盖率对比） */
const LIST_FIELDS = ['terrain', 'regions', 'markers', 'routes', 'textLabels', 'referenceImages'];

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/** 节点 → 世界 id（沿 parentId 上溯；与 store/geodata.js 的 getWorldIdForNode 同逻辑） */
function getWorldIdForNode(nodeId, byId) {
  const visited = new Set();
  let cur = byId.get(nodeId);
  while (cur && cur.id && !visited.has(cur.id)) {
    visited.add(cur.id);
    if (cur.layer === 'world') return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return '';
}

/** 列表条目的身份键：优先 id，其次 name，其次坐标 */
function itemKey(item) {
  if (item == null || typeof item !== 'object') return String(item);
  if (item.id) return `id:${item.id}`;
  if (item.name) return `name:${item.name}`;
  return `x:${item.x},y:${item.y}`;
}

function main() {
  if (!fs.existsSync(MAPDATA_PATH)) {
    console.error(`未找到 ${MAPDATA_PATH}（用 --vault 指定知识库目录）`);
    process.exit(2);
  }
  if (!fs.existsSync(GEODATA_PATH)) {
    console.error(`未找到 ${GEODATA_PATH}：无法推导「世界/行星」新 key，本脚本拒绝在缺少 geodata 时删除任何 key`);
    process.exit(2);
  }

  const mapdata = readJson(MAPDATA_PATH);
  const geodata = readJson(GEODATA_PATH);
  const byId = new Map((geodata.nodes || []).map(n => [n.id, n]));

  const allKeys = Object.keys(mapdata);
  const legacyKeys = allKeys.filter(k => !k.includes('/'));

  const removable = [];   // { legacyKey, newKey, diff }
  const keep = [];        // 无对应新 key 的旧 key

  for (const legacyKey of legacyKeys) {
    const worldId = getWorldIdForNode(legacyKey, byId);
    const newKey = worldId ? `${worldId}/${legacyKey}` : null;
    if (!newKey || !Object.prototype.hasOwnProperty.call(mapdata, newKey)) {
      keep.push({ legacyKey, worldId: worldId || '(未找到世界)' });
      continue;
    }
    const oldData = mapdata[legacyKey] || {};
    const newData = mapdata[newKey] || {};
    const diff = {
      onlyInLegacy: {},          // 旧 key 独有的条目（删除后会消失 —— 仅报告）
      missingFields: [],         // 旧 key 有、新 key 没有的顶层字段
    };
    for (const f of LIST_FIELDS) {
      const oldList = Array.isArray(oldData[f]) ? oldData[f] : [];
      const newList = Array.isArray(newData[f]) ? newData[f] : [];
      const newIds = new Set(newList.map(itemKey));
      const only = oldList.filter(it => !newIds.has(itemKey(it)));
      if (only.length) {
        diff.onlyInLegacy[f] = only.map(it => it && (it.name || it.id) || '(未命名)');
      }
    }
    for (const k of Object.keys(oldData)) {
      if (!(k in newData)) diff.missingFields.push(k);
    }
    removable.push({ legacyKey, newKey, diff });
  }

  // ===== 报告 =====
  console.log(`知识库: ${VAULT}`);
  console.log(`mapdata.json 现有 key（${allKeys.length} 个）: ${allKeys.join(', ')}`);
  console.log(`旧（无世界前缀）key: ${legacyKeys.length} 个`);
  console.log('');

  if (removable.length === 0 && keep.length === 0) {
    console.log('✅ 没有需要处理的旧 key —— 无需清理。');
    return;
  }

  for (const r of removable) {
    console.log(`可清理: ${r.legacyKey}  →  已有新 key ${r.newKey}`);
    const only = r.diff.onlyInLegacy;
    const onlyKeys = Object.keys(only);
    if (onlyKeys.length === 0 && r.diff.missingFields.length === 0) {
      console.log('  · 旧 key 内容是新 key 的子集，无独有条目');
    } else {
      for (const f of onlyKeys) {
        console.log(`  · 旧 key 独有 ${f}（${only[f].length} 项，清理后不再出现在现行数据中）: ${only[f].slice(0, 12).join(' / ')}${only[f].length > 12 ? ' …' : ''}`);
      }
      if (r.diff.missingFields.length) {
        console.log(`  · 旧 key 独有字段（新 key 没有）: ${r.diff.missingFields.join(', ')}`);
      }
    }
    console.log('  · 旧条目会被完整存档到 .sitian/backups/，需要时可人工取回');
  }
  for (const k of keep) {
    console.log(`保留: ${k.legacyKey} —— 无对应新 key（世界: ${k.worldId}），删除将导致数据丢失，不动`);
  }

  if (!APPLY) {
    console.log('');
    console.log('（dry-run：未修改任何文件。确认无误后加 --apply 执行清理）');
    return;
  }

  // ===== 执行 =====
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = ts();
  const backupPath = path.join(BACKUP_DIR, `mapdata-${stamp}.json`);
  fs.copyFileSync(MAPDATA_PATH, backupPath);

  const archived = {};
  const next = { ...mapdata };
  for (const r of removable) {
    archived[r.legacyKey] = { newKey: r.newKey, data: mapdata[r.legacyKey] };
    delete next[r.legacyKey];
  }
  const archivePath = path.join(BACKUP_DIR, `archived-mapdata-legacy-${stamp}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(archived, null, 2), 'utf-8');
  fs.writeFileSync(MAPDATA_PATH, JSON.stringify(next, null, 2), 'utf-8');

  console.log('');
  console.log(`✅ 已清理 ${removable.length} 个旧 key`);
  console.log(`   备份: ${backupPath}`);
  console.log(`   存档: ${archivePath}`);
  console.log(`   剩余 key: ${Object.keys(next).join(', ')}`);
}

main();
