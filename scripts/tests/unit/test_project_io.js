#!/usr/bin/env node
/**
 * Node 单元测试：`.sitian` 项目文件的**文件系统侧**（src/main/handlers/projectHandler.js）
 *
 * 为什么单独有一层 Node 测试：
 *   渲染进程的 CDP 回归用例里 `window.sitianAPI` 是 mock（不落盘），主进程的真实文件 I/O
 *   在 45 个用例里**零覆盖**。而项目文件（Phase 1 独立运行的基础）一旦写坏就是用户数据丢失，
 *   必须有真实落盘的闸门。本文件只 require 纯 Node 模块（projectHandler 顶层不含 electron），
 *   因此可脱离 Electron 直接跑。
 *
 * 用法：node scripts/tests/unit/test_project_io.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 会把它作为前置步骤并计入失败）
 *
 * 纪律：只在 os.tmpdir() 下的临时目录里写文件（不碰真实库，不碰仓库）。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(ROOT, 'src', 'main', 'handlers', 'projectHandler.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// 临时目录：**不能只依赖 os.tmpdir()** —— TMP/TEMP 未设时它可能返回 `C:\WINDOWS`
// （实测：EPERM mkdir 'C:\WINDOWS\sitian-project-io-…' → 整个单测文件"无输出"失败）。
// 所以按候选顺序逐个试探：能 mkdir 且能写删探针文件者胜出；全部失败则明确报错。
const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP,
  process.env.TEMP,
  process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  path.join(os.homedir(), '.sitian-test-tmp'),
].filter(Boolean);

let TMP = '';
let DIR = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-project-io-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      DIR = path.join(dir, 'projects');
      return;
    } catch (e) {
      tried.push(`${base} → ${e.code || e.message}`);
    }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

function sampleProject(name) {
  return {
    version: '1.0.0',
    meta: { id: 'p-1', name, created: '2026-09-18T00:00:00.000Z', updated: '2026-09-18T00:00:00.000Z' },
    entities: { a: { id: 'a', name: '世界', layer: 'world', parentId: null, tags: [], coordinate: { x: 0, y: 0 } } },
    hyperlanes: [],
    scenarios: { version: 2, baseMaps: {}, scenarios: {} },
    maps: {},
    snapshots: [],
  };
}

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

async function main() {
  await resolveTmpRoot();
  await fsp.mkdir(DIR, { recursive: true });

  // ── 1. ILLEGAL_CHARS 与 main/index.js 的同名实现保持一致（防漂移）────────────
  await check('非法字符表与 main/index.js 一致', () => {
    const pick = (rel) => {
      const line = readSource(rel).split('\n').find(l => l.includes('ILLEGAL_CHARS = /'));
      assert(line, `${rel} 未找到 ILLEGAL_CHARS 定义`);
      return line.trim();
    };
    const a = pick('src/main/index.js');
    const b = pick('src/main/handlers/projectHandler.js');
    eq(b, a, 'ILLEGAL_CHARS 两份实现不一致');
    return '两份实现逐字符一致';
  });

  // ── 2. 路径守卫 ──────────────────────────────────────────────────────────
  await check('只接受 .sitian 目标路径', async () => {
    assert(H.isProjectPath('a/b/c.sitian'), '.sitian 未被识别');
    assert(H.isProjectPath('C:\\x\\D.SITIAN'), '大写扩展名未被识别');
    assert(!H.isProjectPath('a/b/c.md'), '.md 被误认成项目文件');
    assert(!H.isProjectPath(''), '空串被误认成项目文件');
    let rejected = false;
    try { await H.writeProjectFile(path.join(DIR, 'evil.md'), { a: 1 }); } catch (e) { rejected = true; }
    assert(rejected, '对 .md 的写入未被拒绝（路径守卫失效）');
    assert(!(await exists(path.join(DIR, 'evil.md'))), '.md 文件被创建了');
    return '非 .sitian 路径被拒绝且未落盘';
  });

  // ── 3. 创建 ─────────────────────────────────────────────────────────────
  let createdPath = '';
  let nestedPath = '';
  await check('创建项目（含非法字符净化 + 自动建目录）', async () => {
    const res = await H.createProjectFile(path.join(DIR, 'nested', 'deep'), '我的世界/A:B', sampleProject('我的世界/A:B'));
    assert(res.success, '创建失败');
    eq(path.basename(res.filePath), '我的世界_A_B.sitian', '文件名净化结果不符');
    eq(await exists(res.filePath), true, '文件未落盘');
    const parsed = JSON.parse(await fsp.readFile(res.filePath, 'utf-8'));
    eq(parsed.version, '1.0.0', 'version 丢失');
    nestedPath = res.filePath;
    return `→ ${path.basename(res.filePath)}（嵌套目录自动创建）`;
  });

  await check('主项目创建于 DIR（后续用例复用）', async () => {
    const res = await H.createProjectFile(DIR, '我的世界/A:B', sampleProject('我的世界/A:B'));
    assert(res.success, '创建失败');
    eq(path.dirname(res.filePath), DIR, '项目未创建在指定目录');
    createdPath = res.filePath;
    return `→ ${path.basename(res.filePath)}`;
  });

  await check('同名项目不覆盖（追加 -2/-3）', async () => {
    const before = await fsp.readFile(createdPath, 'utf-8');
    const second = await H.createProjectFile(DIR, '我的世界/A:B', sampleProject('第二个'));
    const third = await H.createProjectFile(DIR, '我的世界/A:B', sampleProject('第三个'));
    eq(path.basename(second.filePath), '我的世界_A_B-2.sitian', '第二个副本命名不符');
    eq(path.basename(third.filePath), '我的世界_A_B-3.sitian', '第三个副本命名不符');
    const after = await fsp.readFile(createdPath, 'utf-8');
    eq(after, before, '已存在的项目被覆盖了');
    return '-2/-3 命名正确，原件未被覆盖';
  });

  // ── 4. 读回 ─────────────────────────────────────────────────────────────
  await check('读回项目（解析 + mtime）', async () => {
    const res = await H.readProjectFile(createdPath);
    eq(res.success, true, '读取失败');
    eq(res.project.meta.name, '我的世界/A:B', 'meta.name 不一致');
    assert(res.mtime && res.mtime.length >= 10, `mtime 异常：${res.mtime}`);
    assert(res.bytes > 0, `bytes 异常：${res.bytes}`);
    return `bytes=${res.bytes}`;
  });

  await check('损坏的 JSON 会报错而不是返回半个对象', async () => {
    const broken = path.join(DIR, 'broken.sitian');
    await fsp.writeFile(broken, '{ "version": "1.0.0", ', 'utf-8');
    let threw = false;
    try { await H.readProjectFile(broken); } catch (e) { threw = true; }
    assert(threw, '损坏文件未抛错');
    return '抛错（调用方按 error 上报）';
  });

  // ── 5. 原子写 + 旧文件备份 ───────────────────────────────────────────────
  await check('保存：原子写 + 旧内容进备份 + 无 tmp 残留', async () => {
    const next = sampleProject('改名后');
    const res = await H.writeProjectFile(createdPath, next);
    eq(res.success, true, '写入失败');
    const onDisk = JSON.parse(await fsp.readFile(createdPath, 'utf-8'));
    eq(onDisk.meta.name, '改名后', '目标文件内容不是新内容');
    assert(res.backupPath, '首次覆盖未产生备份');
    const backedUp = JSON.parse(await fsp.readFile(res.backupPath, 'utf-8'));
    eq(backedUp.meta.name, '我的世界/A:B', '备份里的内容是覆盖后的（备份时点错误）');
    const leftovers = (await fsp.readdir(path.dirname(createdPath))).filter(f => f.includes('.tmp-'));
    eq(leftovers.length, 0, `存在 tmp 残留：${leftovers.join(',')}`);
    return `backup=${path.basename(res.backupPath)}`;
  });

  await check('备份轮转：写 12 次只留 10 份', async () => {
    for (let i = 0; i < 12; i++) {
      await H.writeProjectFile(createdPath, sampleProject(`第${i}次`));
    }
    const dir = H.backupDirFor(createdPath);
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.sitian'));
    assert(files.length <= 10, `备份未轮转：${files.length} 份`);
    assert(files.length >= 9, `备份被过度清理：${files.length} 份`);
    return `备份 ${files.length} 份（上限 10）`;
  });

  // ── 6. 列表 ─────────────────────────────────────────────────────────────
  await check('列出目录（含损坏项，不影响其余；忽略非 .sitian）', async () => {
    await fsp.writeFile(path.join(DIR, 'notes.md'), '# 不是项目', 'utf-8');
    const res = await H.listProjectFiles(DIR);
    eq(res.success, true, '列目录失败');
    const names = res.items.map(i => i.name);
    assert(!names.includes('notes.md'), '.md 被列进项目列表');
    assert(names.includes('broken.sitian'), '损坏项目未出现在列表里（应带 error 字段）');
    const broken = res.items.find(i => i.name === 'broken.sitian');
    assert(broken.error, '损坏项目没有 error 字段');
    const good = res.items.find(i => i.name === '我的世界_A_B.sitian');
    assert(good && good.meta, '正常项目的 meta 未读出');
    eq(good.entityCount, 1, 'entityCount 统计不符');
    assert(good.mtime && good.mtime.length >= 10, 'mtime 未填充');
    return `列出 ${res.items.length} 项（含 1 项损坏）`;
  });

  // ── 7. git 钩子：非仓库必须跳过而不是报错 ─────────────────────────────────
  await check('git 快照在非 git 目录下静默跳过', async () => {
    const res = await H.gitSnapshot({ filePath: createdPath, message: 'test' });
    eq(res.skipped, true, '未跳过（非 git 目录）');
    assert(/git 仓库/.test(res.reason || ''), `跳过原因不明确：${res.reason}`);
    return 'skipped:true';
  });

  // ── 8. IPC 注册：借假 ipcMain 走一遍全链路 ────────────────────────────────
  await check('registerProjectHandlers 注册 8 个通道并可端到端调用', async () => {
    const handlers = new Map();
    const fakeIpc = { handle: (name, fn) => handlers.set(name, fn) };
    let lastPath = '';
    let dialogPick = '';   // 假对话框返回的路径（由用例自己控制）
    const fakeDialog = {
      showOpenDialog: async () => ({ canceled: !dialogPick, filePaths: dialogPick ? [dialogPick] : [] }),
      showSaveDialog: async () => ({ canceled: true }),
    };
    const fakeShell = { showItemInFolder: () => { fakeShell.called = true; } };

    H.registerProjectHandlers({
      ipcMain: fakeIpc,
      dialog: fakeDialog,
      shell: fakeShell,
      getMainWindow: () => null,
      getDefaultProjectDir: () => DIR,
      getLastProjectPath: () => lastPath,
      setLastProjectPath: async (p) => { lastPath = p; return p; },
    });

    const expected = ['project-create', 'project-open', 'project-save', 'project-list',
      'project-pick-dir', 'project-reveal', 'project-backup-now', 'project-git-snapshot'];
    for (const ch of expected) assert(handlers.has(ch), `未注册通道 ${ch}`);
    eq(handlers.size, expected.length, '注册了预期之外的通道');

    // create
    const created = await handlers.get('project-create')(null, { name: 'IPC测试', dir: DIR, project: sampleProject('IPC测试') });
    eq(created.success, true, `create 失败：${created.error}`);
    eq(lastPath, created.filePath, 'create 未记住最近项目路径');
    // ⚠️ 必须回显项目正文：渲染层 adopt() 靠它装载（只回路径 → 新建项目在生产环境必然失败）
    assert(created.project && created.project.version === '1.0.0', 'project-create 未回显项目正文（渲染层 adopt 会拿到 undefined）');
    eq(created.project.meta.name, 'IPC测试', '回显的项目内容不对');

    // save（用 create 返回的路径）
    const saved = await handlers.get('project-save')(null, { filePath: created.filePath, project: sampleProject('IPC测试-改') });
    eq(saved.success, true, `save 失败：${saved.error}`);
    eq(JSON.parse(await fsp.readFile(created.filePath, 'utf-8')).meta.name, 'IPC测试-改', 'save 未写入新内容');

    // open（不给路径 → 走 dialog）
    dialogPick = created.filePath;
    const opened = await handlers.get('project-open')(null, '');
    eq(opened.success, true, `open 失败：${opened.error}`);
    eq(opened.project.meta.name, 'IPC测试-改', 'open 读到的内容不对');
    assert(opened.dir === path.dirname(created.filePath), 'open 未返回 dir');

    // open 对话框取消 → canceled:true（不能变成失败弹窗）
    dialogPick = '';
    const canceled = await handlers.get('project-open')(null, '');
    eq(canceled.canceled, true, '取消对话框未返回 canceled');

    // list
    const listed = await handlers.get('project-list')(null, DIR);
    eq(listed.success, true, 'list 失败');
    assert(listed.items.length >= 3, `list 项数异常：${listed.items.length}`);

    // pick-dir / reveal / backup / git（非仓库 → 跳过）
    dialogPick = DIR;
    eq((await handlers.get('project-pick-dir')(null)).dir, DIR, 'pick-dir 未返回目录');
    eq((await handlers.get('project-reveal')(null, created.filePath)).success, true, 'reveal 失败');
    assert(fakeShell.called, 'reveal 未调用 shell.showItemInFolder');
    eq((await handlers.get('project-backup-now')(null, created.filePath)).backedUp, true, '手动备份未生效');
    const git = await handlers.get('project-git-snapshot')(null, { filePath: created.filePath });
    eq(git.skipped, true, '非 git 目录未跳过');

    // 路径守卫在 IPC 层同样生效
    const bad = await handlers.get('project-save')(null, { filePath: path.join(DIR, 'evil2.md'), project: {} });
    eq(bad.success, false, 'IPC 层未拒绝非 .sitian 路径');
    return `${handlers.size} 个通道端到端可用`;
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 项目文件 I/O 单元测试（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }

  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
