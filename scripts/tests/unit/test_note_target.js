#!/usr/bin/env node
/**
 * Node 单元测试：新建笔记的**落点**与 **frontmatter**（`src/main/noteTarget.js`，2026-10-24）
 *
 * 为什么守这两件事：
 *   ① 落点曾写死在 handler 的 if/else 里，且**无条件 mkdir** —— 在一个没有 `03 设定` 的库里
 *      转正一个节点，会凭空替用户造一棵 `03 设定/11 地理系统/...`（等于替他改库结构）。
 *      用户拍板：能用约定目录就用，**实在没有才落库根**。
 *   ② frontmatter 曾写英文 `layer` + `coordinate` —— 与「坐标永不写入 frontmatter」红线冲突，
 *      也与库内规范（`层级` / `上层区域`）不一致。拍板：写 `层级`/`上层区域`/`tags`，**不写 coordinate**。
 *
 * 判据分四组：
 *   a 显式目录：`targetDir` 优先（相对/绝对都能落到库内）
 *   b 约定目录：`03 设定` 存在 → 层级子目录（子目录**不必**先存在）；地点类统一进「02 场景地点」
 *   c 根目录兜底：库根没有 `03 设定` → 落库根，并置 `usedRootFallback`
 *   d frontmatter：中文 `层级`、`上层区域` 优先父名、无英文 `layer`、**永不出现 coordinate**
 * 另外两组：
 *   e 真实文件系统：临时库上真跑 mkdir + 写文件（不是纯字符串断言）
 *   f 源码守卫：handler 真的用了这两个函数，且 create 段里不再出现 coordinate
 *
 * 用法：node scripts/tests/unit/test_note_target.js
 * 退出码：0 = 全通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const T = require(path.join(ROOT, 'src', 'main', 'noteTarget.js'));

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log('=== 新建笔记落点与 frontmatter（noteTarget）单元测试 ===');
  const vault = path.join(os.tmpdir(), 'sitian-note-target-vault');

  await check('a 显式目录 targetDir 优先（相对落在库内 / 绝对照用）', () => {
    const rel = T.resolveNoteTarget({ vault, layer: 'galaxy', targetDir: '99 我的沙盒', pathExists: () => true });
    eq(rel.dir, path.join(vault, '99 我的沙盒'), '相对目录');
    eq(rel.source, 'explicit', '来源');
    assert(!rel.usedRootFallback, '显式目录不该标成兜底');

    const abs = path.join(vault, '03 设定', '别处');
    const r2 = T.resolveNoteTarget({ vault, layer: 'galaxy', targetDir: abs, pathExists: () => true });
    eq(r2.dir, abs, '绝对目录');
    return '相对/绝对都落到指定目录，且不被约定规则覆盖';
  });

  await check('b 约定目录：`03 设定` 存在就用层级子目录（子目录不必先存在）', () => {
    // 只让根目录"存在"：证明判据是根目录，不是叶子
    const onlyRoot = (p) => p === path.join(vault, '03 设定');
    const geo = T.resolveNoteTarget({ vault, layer: 'galaxy', pathExists: onlyRoot });
    eq(geo.dir, path.join(vault, '03 设定', '11 地理系统', '星系'), '星系目录');
    eq(geo.source, 'convention', '来源');
    const planet = T.resolveNoteTarget({ vault, layer: 'planet', pathExists: onlyRoot });
    eq(planet.dir, path.join(vault, '03 设定', '11 地理系统', '行星'), '行星目录');
    const city = T.resolveNoteTarget({ vault, layer: 'city', pathExists: onlyRoot });
    eq(city.dir, path.join(vault, '03 设定', '02 场景地点'), '地点类目录');
    const unknown = T.resolveNoteTarget({ vault, layer: 'weird_layer', pathExists: onlyRoot });
    eq(unknown.dir, path.join(vault, '03 设定', '02 场景地点'), '未知层级也进场景地点');
    return '地理三层 → 11 地理系统/{星域,星系,行星}；其余 → 02 场景地点';
  });

  await check('c 根目录兜底：库里没有 `03 设定` → 落库根（不替用户造目录树）', () => {
    const none = T.resolveNoteTarget({ vault, layer: 'galaxy', pathExists: () => false });
    eq(none.dir, vault, '落点');
    eq(none.source, 'root', '来源');
    assert(none.usedRootFallback === true, '必须自报"用了根目录兜底"（调用方/用例据此说清原因）');
    return '库根 + usedRootFallback=true（而不是 mkdir 出一棵 03 设定）';
  });

  await check('d frontmatter：中文层级 / 上层区域优先父名 / 无英文 layer / 永不写 coordinate', () => {
    const fm = T.buildNoteFrontmatter({
      layer: 'galaxy', tags: ['地理', '', 42], parentName: '曜川星系', parentId: 'gal_1',
      coordinate: { x: 12, y: 34 },
    });
    eq(fm['层级'], '星系', '层级标签');
    eq(fm['上层区域'], '[[曜川星系]]', '上层区域（父名优先）');
    assert(!Object.prototype.hasOwnProperty.call(fm, 'layer'), '不该再写英文 layer 键');
    assert(!Object.prototype.hasOwnProperty.call(fm, 'coordinate'), '坐标绝不写进 frontmatter');
    assert(Array.isArray(fm.tags) && fm.tags.length === 1 && fm.tags[0] === '地理', `tags 清洗不对：${JSON.stringify(fm.tags)}`);

    const byId = T.buildNoteFrontmatter({ layer: 'city', parentId: 'city_9' });
    eq(byId['上层区域'], '[[city_9]]', '没有父名时用 id 兜底');
    eq(byId['层级'], '城市', '城市标签');
    assert(!Object.prototype.hasOwnProperty.call(byId, 'tags'), '空 tags 不写键');

    const bare = T.buildNoteFrontmatter({ layer: 'location' });
    assert(!Object.prototype.hasOwnProperty.call(bare, '上层区域'), '没有父级就不写上层区域');
    eq(bare['层级'], '地点', '地点标签');

    const raw = T.buildNoteFrontmatter({ layer: 'custom_kind' });
    eq(raw['层级'], 'custom_kind', '未知层级原样写入（不编造标签）');
    return `层级=${fm['层级']} / 上层区域=${fm['上层区域']} / tags=${JSON.stringify(fm.tags)}；coordinate 与英文 layer 都不出现`;
  });

  await check('e 真实文件系统：临时库上真 mkdir + 写文件（含根目录兜底路径）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-nt-'));
    const v1 = path.join(base, 'vault-with-convention');
    fs.mkdirSync(path.join(v1, '03 设定'), { recursive: true });
    const t1 = T.resolveNoteTarget({ vault: v1, layer: 'galaxy', pathExists: fs.existsSync });
    eq(t1.source, 'convention', '有约定根 → convention');
    fs.mkdirSync(t1.dir, { recursive: true });
    const f1 = path.join(t1.dir, '测试星系.md');
    fs.writeFileSync(f1, '# 测试星系\n', 'utf8');
    assert(fs.existsSync(f1), '约定目录里的文件没写出来');

    const v2 = path.join(base, 'vault-bare');
    fs.mkdirSync(v2, { recursive: true });
    const t2 = T.resolveNoteTarget({ vault: v2, layer: 'galaxy', pathExists: fs.existsSync });
    eq(t2.dir, v2, '裸库落根');
    assert(t2.usedRootFallback, '裸库必须标兜底');
    fs.mkdirSync(t2.dir, { recursive: true });
    const f2 = path.join(t2.dir, '裸库词条.md');
    fs.writeFileSync(f2, '# 裸库词条\n', 'utf8');
    assert(fs.existsSync(f2), '根目录文件没写出来');
    assert(!fs.existsSync(path.join(v2, '03 设定')), '裸库里被凭空造出了 03 设定（越界）');
    fs.rmSync(base, { recursive: true, force: true });
    return '约定目录与裸库两条路径都真写成功；裸库没有被造出 03 设定';
  });

  await check('f 源码守卫：handler 用 noteTarget 的两件，且 create 段不再出现 coordinate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.js'), 'utf8');
    const start = src.indexOf("ipcMain.handle('create-obsidian-note'");
    const end = src.indexOf('ipcMain.handle(', start + 10);
    assert(start >= 0, '找不到 create-obsidian-note');
    const seg = src.slice(start, end > 0 ? end : src.length);
    assert(seg.includes('resolveNoteTarget('), 'create 段没用 resolveNoteTarget（落点又会写死）');
    assert(seg.includes('buildNoteFrontmatter('), 'create 段没用 buildNoteFrontmatter');
    assert(!/coordinate/.test(seg), 'create 段里还出现 coordinate（红线：坐标不进 frontmatter）');
    assert(!/frontmatter\s*=\s*\{/.test(seg), 'create 段又自己拼 frontmatter 了（应交给 buildNoteFrontmatter）');
    return '落点与 frontmatter 都走 noteTarget；create 段零 coordinate、零手拼 frontmatter';
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
