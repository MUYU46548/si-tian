#!/usr/bin/env node
/**
 * Node 单元测试：一键同步（src/main/handlers/gitSyncHandler.js）
 *
 * 为什么单独一层：CDP 用例里 `window.sitianAPI` 是 mock，主进程的真实 git 行为**零覆盖**。
 * 而「同步」一旦出错后果是用户数据没推上去（以为备份了其实没有），必须有真实落地的闸门。
 *
 * 手法：**用本地 bare 仓库当远程**（`git init --bare`）→ push 走本地文件协议，
 * 不需要网络、不需要凭证、可在 CI/离线环境跑，但走的是**真实 git**（不是 mock）。
 *
 * 用法：node scripts/tests/unit/test_git_sync.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 会把它作为前置步骤并计入失败）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const H = require(path.join(ROOT, 'src', 'main', 'handlers', 'gitSyncHandler.js'));

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true, detail: detail || '' }); })
    .catch((err) => { results.push({ name, ok: false, detail: err && err.message ? err.message : String(err) }); });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// 临时目录：不能只依赖 os.tmpdir()（TMP/TEMP 未设时可能是 C:\WINDOWS → EPERM）
const TMP_CANDIDATES = [
  process.env.SITIAN_TEST_TMP,
  process.env.TEMP,
  process.env.TMP,
  (() => { try { return os.tmpdir(); } catch (e) { return ''; } })(),
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  path.join(os.homedir(), '.sitian-test-tmp'),
].filter(Boolean);

let TMP = '';
let WORK = '';
let REMOTE = '';

async function resolveTmpRoot() {
  const tried = [];
  for (const base of TMP_CANDIDATES) {
    const dir = path.join(base, `sitian-git-sync-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      await fsp.writeFile(probe, 'ok', 'utf-8');
      await fsp.unlink(probe);
      TMP = dir;
      WORK = path.join(dir, 'world');
      REMOTE = path.join(dir, 'remote.git');
      return;
    } catch (e) {
      tried.push(`${base} → ${e.code || e.message}`);
    }
  }
  throw new Error('找不到可写的临时目录。候选：' + tried.join(' | '));
}

async function git(args, cwd) {
  return H.runGit(cwd || TMP, args);
}

async function main() {
  await resolveTmpRoot();
  await fsp.mkdir(WORK, { recursive: true });

  // git 是否可用（不可用则跳过本文件，避免整个回归因为环境缺 git 而红）
  const probe = await git(['--version']);
  if (!probe.ok) {
    console.log('=== 同步单元测试（Node）===');
    console.log('  ⏭ 本机没有可用的 git，跳过（同步功能需要 git）');
    return 0;
  }

  // ── 1. 初始化 ────────────────────────────────────────────────────────────
  await check('ensureRepo：初始化仓库并把默认分支统一为 main', async () => {
    const r = await H.ensureRepo(WORK);
    assert(r.ok, `初始化失败：${r.error}`);
    eq(r.created, true, 'created 标记');
    assert(await H.isGitRepo(WORK), '.git 未生成');
    eq(await H.currentBranch(WORK), 'main', '分支名');
    const again = await H.ensureRepo(WORK);
    eq(again.created, false, '重复初始化应返回 created=false');
    return '分支 main（空仓库即统一，避免 master/main 混用）';
  });

  // ── 2. 远程地址：没有 → 人话报错；设置 → 记住 ─────────────────────────────
  await check('未配置远程时同步给出人话错误（不是 git 报错）', async () => {
    await fsp.writeFile(path.join(WORK, '世界.sitian'), '{"version":"1.0.0"}', 'utf-8');
    const r = await H.syncOnce(WORK);
    eq(r.success, false, '未配置远程却成功了');
    assert(/仓库地址/.test(r.error || ''), `错误文案不可执行：${r.error}`);
    return r.error;
  });

  await check('setRemote / getRemote（新增 + 替换）', async () => {
    const a = await H.setRemote(WORK, REMOTE);
    assert(a.ok, `setRemote 失败：${a.error}`);
    eq(await H.getRemote(WORK), REMOTE, 'remote 回读');
    const b = await H.setRemote(WORK, `${REMOTE}`);   // 再设一次 → 走 set-url 分支
    assert(b.ok, `二次 setRemote 失败：${b.error}`);
    eq(await H.getRemote(WORK), REMOTE, '二次设置后仍是同一地址');
    return path.basename(REMOTE);
  });

  // ── 3. 端到端：推到本地 bare 远程（真实 git，无网络）──────────────────────
  await check('首次同步：init→add→commit→push 真的进远程仓库', async () => {
    const bare = await git(['init', '--bare', REMOTE]);
    assert(bare.ok, `bare 仓库创建失败：${bare.error}`);
    const r = await H.syncOnce(WORK, { message: '首次同步' });
    assert(r.success, `同步失败：${r.error}`);
    eq(r.committed, true, '应有提交');
    eq(r.pushed, true, '应已推送');
    eq(r.branch, 'main', '推送分支');
    // 远程里必须真的有这个文件（-c core.quotepath=false 让 git 直接输出 UTF-8，不转义成 \344\270\226）
    const ls = await git(['--git-dir', REMOTE, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'main']);
    assert(ls.ok && ls.stdout.includes('世界.sitian'), `远程内容不对：${ls.stdout || ls.error}`);
    const log = await git(['--git-dir', REMOTE, 'log', '--oneline', 'main']);
    eq(log.stdout.trim().split('\n').length, 1, '远程提交数');
    return `远程已有 1 次提交（${path.basename(REMOTE)}）`;
  });

  await check('无改动时同步：不产生新提交（幂等）', async () => {
    const r = await H.syncOnce(WORK, { message: '空同步' });
    assert(r.success, `同步失败：${r.error}`);
    eq(r.changed, 0, 'changed 应为 0');
    eq(r.committed, false, '无改动不该提交');
    const log = await git(['--git-dir', REMOTE, 'log', '--oneline', 'main']);
    eq(log.stdout.trim().split('\n').length, 1, '提交数不该变');
    return '无改动 → 0 提交，直接回报成功';
  });

  await check('再改一次并同步：提交与推送都 +1', async () => {
    await fsp.writeFile(path.join(WORK, '世界.sitian'), '{"version":"1.0.0","n":2}', 'utf-8');
    const r = await H.syncOnce(WORK, { message: '第二次同步' });
    assert(r.success, `同步失败：${r.error}`);
    eq(r.committed, true, '应有提交');
    const log = await git(['--git-dir', REMOTE, 'log', '--oneline', 'main']);
    eq(log.stdout.trim().split('\n').length, 2, '远程提交数');
    return '2 次提交';
  });

  // ── 4. .gitignore：备份目录不进仓库（否则 MB 级备份撑爆仓库）───────────────
  await check('自动 .gitignore：忽略临时文件与 *.backups/（且真的没被提交）', async () => {
    const p = path.join(WORK, '.gitignore');
    assert(await fsp.readFile(p, 'utf-8').then(t => t.includes('*.backups/')), '.gitignore 未生成忽略项');
    await fsp.mkdir(path.join(WORK, '世界.sitian.backups'), { recursive: true });
    await fsp.writeFile(path.join(WORK, '世界.sitian.backups', '世界-1.sitian'), 'x', 'utf-8');
    await fsp.writeFile(path.join(WORK, '世界.sitian.tmp-123'), 'x', 'utf-8');
    const r = await H.syncOnce(WORK, { message: '带备份同步' });
    assert(r.success, `同步失败：${r.error}`);
    const ls = await git(['--git-dir', REMOTE, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'main']);
    assert(!ls.stdout.includes('.backups'), `备份被提交进仓库了：${ls.stdout}`);
    assert(!ls.stdout.includes('.tmp-'), `临时文件被提交进仓库了：${ls.stdout}`);
    return '备份 / 临时文件均未入库';
  });

  // ── 5. 失败路径也要是人话 ────────────────────────────────────────────────
  await check('推送失败（远程不可达）给出人话原因，且本地提交不丢', async () => {
    const bad = path.join(TMP, 'no-such-remote.git');
    await H.setRemote(WORK, bad);
    await fsp.writeFile(path.join(WORK, '世界.sitian'), '{"version":"1.0.0","n":3}', 'utf-8');
    const r = await H.syncOnce(WORK, { message: '失败路径' });
    eq(r.success, false, '不可达远程却报成功');
    assert(r.error && !/^fatal:|^error:/i.test(r.error), `错误文案未人话化：${r.error}`);
    // 本地提交已生成（数据不会因为推送失败而丢）
    const localLog = await git(['log', '--oneline'], WORK);
    assert(localLog.ok && localLog.stdout.includes('失败路径'), '本地提交丢失（推送失败不该丢数据）');
    await H.setRemote(WORK, REMOTE);   // 还原
    return `人话提示：${r.error.slice(0, 40)}…；本地提交仍在`;
  });

  await check('gitStatus：回读仓库/远程/分支/待同步数（供面板显示）', async () => {
    const s = await H.gitStatus(WORK);
    eq(s.isRepo, true, 'isRepo');
    eq(s.remote, REMOTE, 'remote');
    eq(s.branch, 'main', 'branch');
    assert(s.lastCommitAt, 'lastCommitAt 未填充');
    assert(s.lastCommit === '失败路径', `lastCommit 不对：${s.lastCommit}`);
    const empty = await H.gitStatus(path.join(TMP, 'never-inited'));
    eq(empty.isRepo, false, '未初始化目录的 isRepo');
    return `待同步 ${s.dirty} 项 / 最后提交「${s.lastCommit}」`;
  });

  await check('凭据：只经 stdin 交给 git，且不落进 .git/config', async () => {
    const r = await H.approveCredential({ host: 'example.com', username: 'tester', token: 'dummy-token-for-test' });
    assert(r.ok, `approve 失败：${r.error}`);
    eq(r.host, 'example.com', 'host 回显');
    // 断言 config 里没有令牌（红线：令牌绝不明文落盘进仓库配置）
    const cfg = await fsp.readFile(path.join(WORK, '.git', 'config'), 'utf-8');
    assert(!cfg.includes('dummy-token-for-test'), '令牌被写进了 .git/config（严重）');
    assert(!JSON.stringify(r).includes('dummy-token-for-test'), '令牌被回显给了调用方（严重）');
    return '令牌只进系统凭据管理器（config 与返回值均无令牌）';
  });

  // ── 汇总 ───────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.ok);
  console.log('=== 同步（git）单元测试（Node）===');
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
