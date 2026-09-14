#!/usr/bin/env node
/**
 * 批次 R6：提取覆盖率审计（只读）
 *
 * 回答的问题：「知识库里该进地图的笔记，有多少真的成了司天节点？」
 *
 * 为什么需要
 *   架构审查曾记「03 设定 393 篇 vs 已提取 121 节点」并据此判为覆盖缺口 —— 那是**类别错误**：
 *   提取范围只有 `03 设定/11 地理系统` + `03 设定/02 场景地点`（见 extract-data.js 的 SCAN_SCOPE），
 *   `03 设定` 下的人物/基础设定本就不该成为地图节点。本脚本按**真实提取范围**算覆盖率，
 *   并把「范围外篇数」单独列出，避免同一个误判再次发生。
 *
 * 输出
 *   - stdout：总览 + 缺口清单 + 范围外分布
 *   - `--write-report`：额外写入 `<vault>/96 事务管理/提取覆盖率审计报告.md`（库内报告惯例目录）
 *
 * 用法
 *   node scripts/audit-coverage.js [--vault D:/Vault] [--write-report]
 */
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const { SCAN_SCOPE } = require('./extract-data.js');

const ARGS = process.argv.slice(2);
const WRITE_REPORT = ARGS.includes('--write-report');
const vaultIdx = ARGS.indexOf('--vault');
const VAULT = (vaultIdx !== -1 ? ARGS[vaultIdx + 1] : null)
  || process.env.SITIAN_VAULT
  || 'E:/图书馆/ROSA';

const REPORT_DIR = '96 事务管理';
const REPORT_NAME = '提取覆盖率审计报告.md';

const norm = (p) => String(p).replace(/\\/g, '/');
const excluded = new Set(SCAN_SCOPE.excludedBasenames || []);

/** 递归收集 md（跳过 `_`/`.` 前缀与排除名，与 extract-data.js 的扫描规则一致） */
function walkMd(relDir) {
  const abs = path.join(VAULT, ...relDir.split('/'));
  const out = [];
  if (!fs.existsSync(abs)) return out;
  (function rec(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { rec(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      if (excluded.has(path.basename(entry.name, '.md'))) continue;
      out.push(norm(path.relative(VAULT, full)));
    }
  })(abs);
  return out;
}

function main() {
  const geodataPath = path.join(VAULT, '.sitian', 'geodata.json');
  if (!fs.existsSync(geodataPath)) {
    console.error(`未找到 ${geodataPath}。先运行 npm run extract-data 再审计。`);
    process.exit(2);
  }
  const geodata = JSON.parse(fs.readFileSync(geodataPath, 'utf-8'));
  const nodes = geodata.nodes || [];
  const updatedAt = geodata.updatedAt || '(未知)';

  // 节点来源：一个文件可能对应多个节点（如地理系统索引 → 多个世界）
  const bySource = new Map();
  for (const n of nodes) {
    const sp = norm(n.sourcePath || '');
    if (!sp) continue;
    if (!bySource.has(sp)) bySource.set(sp, []);
    bySource.get(sp).push(n.name);
  }

  const scopes = [
    { key: '地理系统', dir: SCAN_SCOPE.geoSystem },
    { key: '场景地点', dir: SCAN_SCOPE.locations },
  ];

  const rows = [];
  const missing = [];
  for (const s of scopes) {
    const files = walkMd(s.dir);
    const miss = files.filter(f => !bySource.has(f));
    rows.push({ name: s.key, dir: s.dir, files: files.length, covered: files.length - miss.length, missing: miss.length });
    for (const f of miss) {
      let layer = '(无 frontmatter 层级)';
      try {
        const fm = matter(fs.readFileSync(path.join(VAULT, ...f.split('/')), 'utf-8')).data;
        if (fm && fm['层级']) layer = String(fm['层级']);
      } catch (e) { layer = '(读取失败)'; }
      missing.push({ file: f, layer });
    }
  }
  // 索引文件（世界节点的来源）
  const indexExists = fs.existsSync(path.join(VAULT, ...SCAN_SCOPE.index.split('/')));
  const indexNodeNames = bySource.get(norm(SCAN_SCOPE.index)) || [];

  const inScopeFiles = new Set(scopes.flatMap(s => walkMd(s.dir)));
  const totalFiles = inScopeFiles.size + (indexExists ? 1 : 0);
  const totalCovered = rows.reduce((a, r) => a + r.covered, 0) + (indexExists ? 1 : 0);
  const pct = totalFiles ? ((totalCovered / totalFiles) * 100).toFixed(1) : '0.0';

  // 范围外：03 设定 下所有非提取范围目录（仅计数，不算缺口）
  const settingRoot = '03 设定';
  const outside = new Map();
  for (const f of walkMd(settingRoot)) {
    if (inScopeFiles.has(f)) continue;
    const seg = f.split('/')[1] || '(根)';
    outside.set(seg, (outside.get(seg) || 0) + 1);
  }
  const outsideTotal = [...outside.values()].reduce((a, b) => a + b, 0);

  // 异常：节点指向提取范围之外（用户创建节点/其他来源）
  const inScopeOrIndex = new Set([...inScopeFiles, norm(SCAN_SCOPE.index)]);
  const outOfScopeNodes = [...bySource.keys()].filter(sp => !inScopeOrIndex.has(sp));

  const multi = [...bySource.entries()].filter(([, names]) => names.length > 1);

  // ===== stdout =====
  console.log(`知识库: ${VAULT}`);
  console.log(`geodata 缓存: ${nodes.length} 节点（updatedAt: ${updatedAt}）`);
  console.log('');
  console.log('提取范围内覆盖率:');
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(6)} ${r.dir} → ${r.covered}/${r.files} 篇成节点${r.missing ? `（缺 ${r.missing}）` : ''}`);
  }
  if (indexExists) console.log(`  索引    ${SCAN_SCOPE.index} → 已提取（产出 ${indexNodeNames.length} 个世界节点）`);
  console.log(`  合计    ${totalCovered}/${totalFiles} = ${pct}%`);
  console.log('');
  if (missing.length === 0) {
    console.log('✅ 范围内无缺口：该进地图的笔记全部成了节点。');
  } else {
    console.log(`⚠️ 范围内缺口 ${missing.length} 篇（原因多为缺 frontmatter 层级或提取缓存过期）：`);
    for (const m of missing) console.log(`   - ${m.file}  [层级: ${m.layer}]`);
  }
  console.log('');
  console.log(`范围外笔记（不计入覆盖率，本就不该成为地图节点）: ${outsideTotal} 篇`);
  for (const [k, v] of [...outside.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`   - ${settingRoot}/${k}: ${v}`);
  }
  if (outOfScopeNodes.length) {
    console.log('');
    console.log(`范围外 sourcePath 的节点（用户创建/派生，${outOfScopeNodes.length} 条）:`);
    for (const sp of outOfScopeNodes.slice(0, 10)) console.log(`   - ${sp} → ${bySource.get(sp).join('、')}`);
  }
  if (multi.length) {
    console.log('');
    console.log(`一个文件产出多个节点（${multi.length} 个文件，属正常：索引/派生）:`);
    for (const [sp, names] of multi) console.log(`   - ${sp} → ${names.join('、')}`);
  }

  // ===== 报告文件 =====
  if (WRITE_REPORT) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const L = [];
    L.push('# 🗺️ 司天提取覆盖率审计报告');
    L.push('');
    L.push(`> **生成时间**：${stamp}`);
    L.push('> **模式**：只读（未修改任何文件）');
    L.push(`> **库路径**：\`${VAULT}\``);
    L.push(`> **数据源**：\`.sitian/geodata.json\`（updatedAt: ${updatedAt}，共 ${nodes.length} 节点）`);
    L.push('');
    L.push('## 1️⃣ 提取范围内覆盖率');
    L.push('');
    L.push('| 范围 | 目录 | 磁盘篇数 | 已成节点 | 缺口 | 覆盖率 |');
    L.push('|:---|:---|---:|---:|---:|---:|');
    for (const r of rows) {
      L.push(`| ${r.name} | \`${r.dir}\` | ${r.files} | ${r.covered} | ${r.missing} | ${r.files ? ((r.covered / r.files) * 100).toFixed(1) : '0.0'}% |`);
    }
    if (indexExists) L.push(`| 索引 | \`${SCAN_SCOPE.index}\` | 1 | 1 | 0 | 100.0% |`);
    L.push(`| **合计** | — | **${totalFiles}** | **${totalCovered}** | **${totalFiles - totalCovered}** | **${pct}%** |`);
    L.push('');
    L.push('## 2️⃣ 缺口清单（提取范围内未成节点的笔记）');
    L.push('');
    if (missing.length === 0) {
      L.push('✅ 无缺口。');
    } else {
      L.push('| 笔记 | frontmatter 层级 |');
      L.push('|:---|:---|');
      for (const m of missing) L.push(`| \`${m.file}\` | ${m.layer} |`);
    }
    L.push('');
    L.push('## 3️⃣ 范围外笔记（不计入覆盖率）');
    L.push('');
    L.push(`提取范围由 \`scripts/extract-data.js\` 的 \`SCAN_SCOPE\` 定义（地理系统 + 场景地点 + 地理系统索引）。`);
    L.push(`\`${settingRoot}\` 下其余 ${outsideTotal} 篇属人物/基础设定等**非地理内容，本就不应成为地图节点**：`);
    L.push('');
    L.push('| 子目录 | 篇数 |');
    L.push('|:---|---:|');
    for (const [k, v] of [...outside.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${settingRoot}/${k} | ${v} |`);
    L.push('');
    if (multi.length) {
      L.push('## 4️⃣ 一个文件产出多个节点（正常）');
      L.push('');
      for (const [sp, names] of multi) L.push(`- \`${sp}\` → ${names.join('、')}`);
      L.push('');
    }
    const outPath = path.join(VAULT, REPORT_DIR, REPORT_NAME);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf-8');
    console.log('');
    console.log(`报告已写入: ${outPath}`);
  }
}

main();
