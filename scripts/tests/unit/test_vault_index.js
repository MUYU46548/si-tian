#!/usr/bin/env node
/**
 * Node 单元测试：全库只读索引 / 实体候选（src/main/vaultIndex.js）
 *
 * 背景（D1 / T1-T2，2026-10-19）：
 *   S0 实测：真实库 1,353 篇只扫 141 篇；缺 `01 索引/地理系统索引.md` 时提取直接 ENOENT。
 *   本模块补的是“另一个问题”：库里有什么、标题/标签/双链/首段是什么；以及“哪些笔记像地图实体”。
 *
 * 判错的后果都是静默的：
 *   · 索引把 `.obsidian/.git` 扫进来 → 计数虚高、搜索噪音；
 *   · 增量指纹没生效 → 每次启动全量解析 1,353 篇；
 *   · containment 漏了 → 渲染层能借 IPC 读库外任意文件；
 *   · 候选把所有笔记都算进去 → 1,353 个“实体”淹掉真正的地图笔记。
 *
 * 用法：node scripts/tests/unit/test_vault_index.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture-messy');
const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));
const { extractGeodata } = require(path.join(ROOT, 'scripts', 'extract-data.js'));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function main() {
  const tmp = path.join(os.tmpdir(), `sitian-vi-${Date.now()}`);
  fs.cpSync(FIXTURE, tmp, { recursive: true });

  try {
    // ---------- 1. walk ----------
    await check('t1 walkMarkdown 跳过 .obsidian/.git，包含深层目录与 `_` 开头模板', () => {
      const list = vi.walkMarkdown(tmp);
      eq(list.length, 22, 'md 总数');
      assert(list.includes('嵌套/一/二/三/四/五/深处.md'), '深层目录');
      assert(list.includes('无标题.md'), '根目录');
      assert(!list.some((p) => p.startsWith('.obsidian/')), '.obsidian 必须排除');
      return '22 篇；深层/根目录都在，.obsidian 不在';
    });

    // ---------- 2. build ----------
    let index = null;
    await check('t2 buildIndex 全量：22 篇、无解析错误、按顶层目录统计', () => {
      const built = vi.buildIndex(tmp, { forceFull: true });
      index = built.index;
      eq(built.summary.total, 22, 'total');
      eq(built.summary.parseErrors, 0, 'parseErrors');
      assert(built.summary.byTop['03 设定'] === 2, '03 设定 2 篇');
      assert(index.files['散装/人物/艾琳.md'].title === '艾琳', '无 frontmatter 用 H1 标题');
      assert(index.files['散装/人物/艾琳.md'].wikilinks.includes('老陶'), 'wikilinks');
      assert(index.files['地理/北境/风岬港.md'].layerHint === 'city', '层级→layerHint');
      return `22 篇，byTop ${Object.keys(built.summary.byTop).length} 组`;
    });

    // ---------- 3. 增量 ----------
    await check('t3 增量：第二次全命中（mtime+size 指纹），不重新解析', () => {
      const built = vi.buildIndex(tmp);
      eq(built.summary.hits, 22, 'hits');
      eq(built.summary.misses, 0, 'misses');
      return 'hits=22 / misses=0';
    });

    // ---------- 4. 候选 ----------
    await check('t4 discoverCandidates：乱目录/无 frontmatter 也能产出候选，且不把纯人物笔记算进去', () => {
      const c = vi.discoverCandidates(index);
      assert(c.count >= 8, `候选应 ≥8，实际 ${c.count}`);
      const paths = new Set(c.candidates.map((x) => x.path));
      assert(paths.has('地理/北境/风岬港.md'), '有层级/上层区域的城市');
      assert(paths.has('别处/风岬港.md'), '跨目录重名的另一篇');
      assert(paths.has('带附件/地图笔记.md'), '只有层级的地点');
      assert(!paths.has('散装/人物/艾琳.md'), '无任何地图线索的人物不应成为候选');
      const city = c.candidates.find((x) => x.path === '地理/北境/风岬港.md');
      eq(city.confidence, 'high', '城市置信度');
      eq(city.layer, 'city', '城市 layer');
      return `候选 ${c.count}；byLayer ${JSON.stringify(c.byLayer)}`;
    });

    // ---------- 5. 搜索 ----------
    await check('t5 searchIndex：标题/正文提及/别名都能命中，且“资料条目”也能被搜到', () => {
      const r1 = vi.searchIndex(index, '风岬');
      assert(r1.length >= 3, `搜“风岬”应 ≥3，实际 ${r1.length}`);
      assert(r1.some((x) => x.path === '事件/第三纪元/风岬港大火.md'), '正文提及/标题命中资料条目');
      const r2 = vi.searchIndex(index, '船匠');
      assert(r2.some((x) => x.path === '散装/人物/老陶.md'), '标签命中');
      return `“风岬” ${r1.length} 条；“船匠” ${r2.length} 条`;
    });

    // ---------- 6. containment ----------
    await check('t6 readNote：库内可读；越界路径必须拒绝（不能借 IPC 读库外文件）', () => {
      const note = vi.readNote(tmp, '散装/人物/艾琳.md');
      assert(note.content.includes('灯塔守'), '正文');
      let threw = false;
      try { vi.readNote(tmp, '../package.json'); } catch (e) { threw = true; }
      assert(threw, '越界路径应抛错');
      let threw2 = false;
      try { vi.readNote(tmp, '..\\package.json'); } catch (e) { threw2 = true; }
      assert(threw2, 'Windows 反斜杠越界也应抛错');
      return '库内可读；`../` 与 `..\\` 都被拒';
    });

    // ---------- 7. B0 ----------
    await check('t7 B0：缺 `01 索引/地理系统索引.md` 时 extractGeodata 不再整次失败', async () => {
      const nodes = await extractGeodata(tmp);
      assert(nodes && Array.isArray(nodes.nodes), '应返回 nodes 数组');
      eq(nodes.nodeCount, 2, '扫描范围内 2 篇 → 2 个节点');
      return '提取成功：2 个节点（无索引不再 ENOENT）';
    });

    // ---------- 8. status ----------
    await check('t8 indexStatus：索引文件存在且可读，统计与 build 一致', () => {
      const st = vi.indexStatus(tmp);
      assert(st.exists, '索引应存在');
      eq(st.stats.total, 22, 'status.total');
      assert(fs.existsSync(st.indexFile), '索引文件落盘');
      return `index ${st.sizeBytes} B`;
    });

    // ---------- 9. 接线（source gate） ----------
    await check('t9 主进程 5 条 IPC 已注册，且 preload 全部暴露（防“注册了但渲染层看不到”）', () => {
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf-8');
      const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf-8');
      const channels = ['vault-index-build', 'vault-index-status', 'vault-note-read', 'vault-index-search', 'vault-entity-candidates',
        'vault-note-resolve', 'vault-note-search', 'vault-asset-read'];
      for (const ch of channels) {
        assert(mainSrc.includes(`ipcMain.handle('${ch}'`), `主进程缺 ${ch}`);
      }
      for (const name of ['vaultIndexBuild', 'vaultIndexStatus', 'vaultNoteRead', 'vaultIndexSearch', 'vaultEntityCandidates',
        'vaultNoteResolve', 'vaultNoteSearch', 'vaultAssetRead']) {
        assert(preloadSrc.includes(`${name}:`), `preload 缺 ${name}`);
      }
      assert(mainSrc.includes('startIndexWatcher'), '主进程未接索引 watcher');
      assert(mainSrc.includes('restartIndexWatcher'), '主进程未在换库时重启索引 watcher');
      assert(preloadSrc.includes('onVaultIndexUpdated:'), 'preload 未暴露索引变更事件');
      return '8 条 IPC + 8 个 preload 方法 + 索引 watcher 接线都在';
    });

    // ---------- 10. 阅读器：链接解析 + 正文搜索 ----------
    await check('t10 resolveNote / searchIndexDeep：双链目标可解析；正文里的词能搜到', () => {
      const byName = vi.resolveNote(index, '风岬港');
      assert(byName.path, '风岬港应解析到路径');
      assert(byName.candidates.length >= 2, `重名应给 ≥2 候选，实际 ${byName.candidates.length}`);
      const byAlias = vi.resolveNote(index, '北境');
      assert(byAlias.path, '北境应解析到路径');
      const deep = vi.searchIndexDeep(tmp, index, '三次被封');
      assert(deep.some((x) => x.path === '资料收藏/剪贴/一段剪报.md'), '正文搜索应命中剪报（首段是引用，不算 firstLine）');
      assert(deep.some((x) => x.matchedIn === 'content'), '应标记 matchedIn=content');
      return `风岬港 ${byName.candidates.length} 候选；正文命中 ${deep.length}`;
    });

    // ---------- 11. 阅读器：附件读取 + containment ----------
    await check('t11 readAsset：按笔记目录/库内文件名找到图，返回 dataUrl；越界拒绝', () => {
      const a = vi.readAsset(tmp, '图.png', '带附件/地图笔记.md');
      assert(a.mime === 'image/png', `mime=${a.mime}`);
      assert(String(a.dataUrl).startsWith('data:image/png;base64,'), 'dataUrl 前缀');
      let threw = false;
      try { vi.readAsset(tmp, '../package.json', '散装/人物/艾琳.md'); } catch (e) { threw = true; }
      assert(threw, '越界附件应拒绝');
      return `附件 ${a.path} ${a.size}B`;
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
