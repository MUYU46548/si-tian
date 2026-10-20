#!/usr/bin/env node
/**
 * Node 单元测试：全库资料索引监听（src/main/vaultIndexWatcher.js）
 *
 * 背景（D2 / T6，2026-10-19）：索引是只读缓存；用户在 Obsidian 里改一篇笔记，
 * 司天里的搜索/候选应该跟着变，但**画布不能动**。本用例只验“watcher → 防抖 → 增量重建”：
 *   · 新增 / 修改 `.md` 都会触发；
 *   · 重建后的 summary 计数正确；
 *   · watcher 不把 `.sitian` 自己写的索引文件当成变更（否则会自激）。
 *
 * 用法：node scripts/tests/unit/test_vault_index_watcher.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(ROOT, 'scripts', 'tests', 'fixtures', 'vault-fixture-messy');
const { startIndexWatcher, IGNORED } = require(path.join(ROOT, 'src', 'main', 'vaultIndexWatcher.js'));
const vi = require(path.join(ROOT, 'src', 'main', 'vaultIndex.js'));

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const tmp = path.join(os.tmpdir(), `sitian-viw-${Date.now()}`);
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  let watcher = null;
  const events = [];

  try {
    await check('t1 IGNORED：.sitian / .obsidian / node_modules 不进监听，普通笔记进', () => {
      assert(IGNORED.test(path.join(tmp, '.sitian', 'note-index.json')), '.sitian 应忽略');
      assert(IGNORED.test(path.join(tmp, '.obsidian', 'app.json')), '.obsidian 应忽略');
      assert(!IGNORED.test(path.join(tmp, '散装', '人物', '新.md')), '普通笔记不该忽略');
      return '三类路径判定正确';
    });

    await check('t2 新增 .md → 250ms 内重建索引，summary 计数 +1', async () => {
      watcher = startIndexWatcher(tmp, (s) => events.push(s), { debounceMs: 50 });
      await sleep(900);                 // 等 chokidar ready
      events.length = 0;
      const p = path.join(tmp, '散装', '人物', '新来的.md');
      fs.writeFileSync(p, '# 新来的\n\n刚写的。\n', 'utf-8');
      const t0 = Date.now();
      let hit = null;
      while (Date.now() - t0 < 6000) {
        hit = events.find((e) => e.event === 'add' && String(e.path).includes('新来的'));
        if (hit) break;
        await sleep(50);
      }
      assert(hit, '6s 内没有收到 add 事件');
      assert(hit.total === 23, `total 应为 23，实际 ${hit.total}`);
      return `add 事件 ${Date.now() - t0}ms，total=${hit.total}`;
    });

    await check('t3 修改 .md → 触发 change；索引内容跟着变', async () => {
      events.length = 0;
      const p = path.join(tmp, '散装', '人物', '新来的.md');
      fs.writeFileSync(p, '# 新来的\n\n改过之后的内容。\n', 'utf-8');
      const t0 = Date.now();
      let hit = null;
      while (Date.now() - t0 < 6000) {
        hit = events.find((e) => e.event === 'change' && String(e.path).includes('新来的'));
        if (hit) break;
        await sleep(50);
      }
      assert(hit, '6s 内没有收到 change 事件');
      const idx = vi.loadIndex(tmp);
      assert(idx && idx.files['散装/人物/新来的.md'], '索引里应有新笔记');
      assert(idx.files['散装/人物/新来的.md'].firstLine.includes('改过之后'), '索引内容应更新');
      return `change 事件 ${Date.now() - t0}ms`;
    });

    await check('t4 close 之后不再回调（换库/退出时不能留 watcher）', async () => {
      watcher.close();
      watcher = null;
      events.length = 0;
      fs.writeFileSync(path.join(tmp, '散装', '人物', '关闭之后.md'), '# 关\n', 'utf-8');
      await sleep(800);
      assert(!events.some((e) => String(e.path).includes('关闭之后')), 'close 后仍有回调');
      return 'close 后零回调';
    });
  } finally {
    if (watcher) { try { watcher.close(); } catch (e) { /* ignore */ } }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
