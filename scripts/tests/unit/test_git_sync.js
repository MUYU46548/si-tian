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

// 🔴 测试必须**完全隔离用户的全局 git 配置**（2026-09-24 修，实测踩到）：
//    `git credential approve / fill` 会去用**用户系统里配置的凭据助手** —— Windows 上通常是
//    Git Credential Manager，它会弹出「Credential Helper Selector」GUI 窗口**打断用户**，
//    还可能把测试用的假令牌写进用户的凭据库。
//    做法：把 `GIT_CONFIG_GLOBAL` 指到测试自己的临时配置（含提交必需的 user.name/email），
//    再用 `GIT_CONFIG_NOSYSTEM=1` 忽略系统级配置 —— 本进程后续所有 git 调用都不再碰用户环境。
//    注：`gitSyncHandler.runGit` 的 env 是 `{ ...process.env, ... }`，所以在这里改即全局生效。
const TEST_GITCONFIG = path.join(os.tmpdir(), `sitian-test-gitconfig-${process.pid}`);
try {
  fs.writeFileSync(
    TEST_GITCONFIG,
    '[user]\n\tname = SiTian Test\n\temail = test@sitian.local\n[init]\n\tdefaultBranch = main\n'
  );
} catch (e) { /* 写不了就让 git 自身失败，用例会如实报红 */ }
process.env.GIT_CONFIG_GLOBAL = TEST_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';

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

  // ── 6. 令牌注入机制（本次事故的修复点）──────────────────────────────────
  // 旧实现只把令牌交给系统凭据管理器 → 推送时取不回来（用户填了令牌仍被要求登录）。
  // 现在用「临时 credential helper + 环境变量」把令牌直接喂给 git。这里用 `git credential fill`
  // 验证机制本身（无需网络），并断言令牌**不进 argv、不出现在返回值里**。
  await check('令牌注入：credential helper + 环境变量，git 能取到且 argv 里没有令牌', async () => {
    const TOKEN = 'ghp_fake_token_for_credential_helper_test';
    const args = [...H.credentialArgs({ username: 'muyu', token: TOKEN }), 'credential', 'fill'];
    assert(!args.join(' ').includes(TOKEN), '令牌出现在 argv 里（进程列表可见，严重）');
    const r = await H.runGit(TMP, args, {
      stdin: 'protocol=https\nhost=example.com\n\n',
      env: H.credentialEnv({ username: 'muyu', token: TOKEN }),
    });
    assert(r.ok, `credential fill 失败：${r.stderr || r.error}`);
    assert(r.stdout.includes('password=' + TOKEN), `git 没取到令牌：${r.stdout.slice(0, 120)}`);
    assert(r.stdout.includes('username=muyu'), `用户名没传对：${r.stdout.slice(0, 120)}`);
    // 无令牌时不该注入 helper（否则会拿空密码去撞验证，走到 "Authentication failed" 而非"缺令牌"）
    // 🔴 无令牌时**必须仍然清空**系统 credential helper（而不是返回空参数）——
    //    否则 git 会落到系统凭据助手（Windows 上是 GCM，会弹 GUI 窗口打断用户）。
    const resetArgs = H.credentialArgs(null);
    eq(resetArgs.join(' '), '-c credential.helper=', '无令牌时应只清空系统 helper（不得落到系统 GCM，也不得注入令牌）');
    return '令牌经环境变量进入 git，不进 argv';
  });

  await check('resolveCredential：优先应用侧保管，其次地址内嵌凭据', async () => {
    const { createCredentialStore } = require(path.join(ROOT, 'src', 'main', 'gitCredentialStore.js'));
    const store = createCredentialStore({ dir: TMP, encrypt: (s) => 'enc:' + s, decrypt: (s) => String(s).slice(4) });
    await H.setRemote(WORK, 'https://github.com/demo/world.git');
    eq(await H.resolveCredential({ dir: WORK, credentialStore: store }), null, '未保存令牌时应返回 null');
    await store.set({ host: 'github.com', username: 'demo', token: 'tok-from-store' });
    const cred = await H.resolveCredential({ dir: WORK, credentialStore: store });
    eq(cred && cred.token, 'tok-from-store', '应从保管取到令牌');
    eq(cred.username, 'demo', '用户名');
    // 没有保管层时，退到地址里内嵌的凭据。
    // ⚠️ 必须用 git remote set-url 直接写**原始**地址来模拟"用户手工配过的仓库"——
    //    走 setRemote 的话凭据会被剥掉（那是刻意的），测不到这条兜底路径。
    await H.runGit(WORK, ['remote', 'set-url', 'origin', 'https://inline-token@github.com/demo/world.git']);
    const inline = await H.resolveCredential({ dir: WORK });
    eq(inline && inline.token, 'inline-token', '应能抽出地址内嵌令牌');
    await H.setRemote(WORK, REMOTE);
    return 'ok';
  });

  await check('地址内嵌令牌：抽出来存好，不写进 .git/config', async () => {
    const parsed = H.extractUrlCredential('https://ghp_secret_x@github.com/a/b.git');
    eq(parsed.url, 'https://github.com/a/b.git', '干净地址');
    eq(parsed.token, 'ghp_secret_x', '抽出的令牌');
    const parsed2 = H.extractUrlCredential('https://muyu:ghp_secret_y@github.com/a/b.git');
    eq(parsed2.url, 'https://github.com/a/b.git', '干净地址（user:pass 形式）');
    eq(parsed2.token, 'ghp_secret_y', '令牌');
    eq(parsed2.username, 'muyu', '用户名');

    const r = await H.setRemote(WORK, 'https://muyu:ghp_secret_z@github.com/a/b.git');
    assert(r.ok, `setRemote 失败：${r.error}`);
    eq(r.inlineToken, 'ghp_secret_z', '应回报抽出的令牌（供保管层保存）');
    eq(await H.getRemote(WORK), 'https://github.com/a/b.git', 'remote 应是干净地址');
    const cfg = await fsp.readFile(path.join(WORK, '.git', 'config'), 'utf-8');
    assert(!cfg.includes('ghp_secret_z'), '令牌被写进了 .git/config（严重）');
    await H.setRemote(WORK, REMOTE);
    return '内嵌令牌被剥离并回报（供加密保管）';
  });

  await check('sanitize：回渲染层前抹掉令牌与 URL 内嵌凭据', async () => {
    const s = H.sanitize('fatal: https://ghp_abc123@github.com/x/y.git 拒绝 token=ghp_abc123', ['ghp_abc123']);
    assert(!s.includes('ghp_abc123'), `令牌没被抹掉：${s}`);
    assert(s.includes('https://***@github.com'), `URL 凭据没被抹掉：${s}`);
    return s;
  });

  await check('humanize：区分「令牌被拒」与「没找到凭据」（本次事故的关键）', async () => {
    const a = H.humanize({ stderr: 'remote: Invalid username or password.\nfatal: Authentication failed for ...' });
    assert(/令牌/.test(a), `认证失败应指向令牌：${a}`);
    const b = H.humanize({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" });
    assert(/需要登录|令牌/.test(b), `缺凭据应指向"去填令牌"：${b}`);
    assert(a !== b, '两种情形必须给出不同指引');
    return `被拒 →「${a.slice(0, 22)}…」；缺凭据 →「${b.slice(0, 22)}…」`;
  });

  // ── 7. 测试连接（ls-remote）─────────────────────────────────────────────
  await check('testRemote：本地 bare 仓库当远程 → 连接成功并回报分支数', async () => {
    await H.setRemote(WORK, REMOTE);
    const r = await H.testRemote(WORK);
    assert(r.success, `测试连接失败：${r.error}`);
    assert(r.heads >= 1, `分支数不对：${r.heads}`);
    assert(/连接成功/.test(r.note || ''), `回执不像人话：${r.note}`);
    const missing = path.join(TMP, 'never-inited-dir');
    const r2 = await H.testRemote(missing);
    eq(r2.success, false, '未初始化目录应失败');
    assert(/仓库/.test(r2.error || ''), `未初始化目录的错误文案：${r2.error}`);
    return r.note;
  });

  await check('testRemote：远程空的也说人话（正好用来首次推送）', async () => {
    const emptyRemote = path.join(TMP, 'empty-remote.git');
    const bare = await git(['init', '--bare', emptyRemote]);
    assert(bare.ok, `bare 创建失败：${bare.error}`);
    const dir2 = path.join(TMP, 'empty-work');
    await H.ensureRepo(dir2);
    await H.setRemote(dir2, emptyRemote);
    const r = await H.testRemote(dir2);
    assert(r.success, `空远程测试连接失败：${r.error}`);
    eq(r.heads, 0, 'heads');
    return r.note;
  });

  // ── 8. 从远程恢复（拉取）：两步确认 + 不丢数据 ──────────────────────────
  await check('拉取：第一步只探测（不改工作区），第二步才对齐远端且不丢本地内容', async () => {
    const WORK2 = path.join(TMP, 'world2');
    // -b main：远端 HEAD 因历史原因可能指向 master（bare 仓库初始化时的默认值），显式取 main 更贴近真实"另一台设备"
    const clone = await H.runGit(TMP, ['clone', '-b', 'main', REMOTE, WORK2]);
    assert(clone.ok, `clone 失败：${clone.error}`);

    // 第二台设备改一笔并推上去
    await fsp.writeFile(path.join(WORK2, '世界.sitian'), '{"version":"1.0.0","from":"设备B"}', 'utf-8');
    const pushed = await H.syncOnce(WORK2, { message: '设备B 的改动' });
    assert(pushed.success, `设备B 推送失败：${pushed.error}`);

    // 本机还没拉 → 先探测：必须只回 needsConfirm，且**不动工作区**
    const before = await fsp.readFile(path.join(WORK, '世界.sitian'), 'utf-8');
    const probe = await H.pullOnce(WORK, { confirm: false });
    eq(probe.success, false, '未确认不该执行恢复');
    eq(probe.needsConfirm, true, 'needsConfirm');
    assert(probe.behind >= 1, `应报告落后的提交数：${probe.behind}`);
    // 工作区文件在探测阶段不能被动过（否则"探测"就是破坏性操作）
    const afterProbe = await fsp.readFile(path.join(WORK, '世界.sitian'), 'utf-8');
    eq(afterProbe, before, '探测阶段动了工作区文件（严重）');

    // 本机也改一笔（未同步）→ 恢复后必须仍能在本地 git 历史里找回
    await fsp.writeFile(path.join(WORK, '本地未同步.txt'), '本机独有内容-不能丢', 'utf-8');

    const pulled = await H.pullOnce(WORK, { confirm: true });
    assert(pulled.success, `恢复失败：${pulled.error}`);
    eq(pulled.pulled, true, 'pulled');
    eq(pulled.localSnapshot, true, '本地未同步内容应先被提交成一条本地快照');

    const nowFile = await fsp.readFile(path.join(WORK, '世界.sitian'), 'utf-8');
    assert(nowFile.includes('设备B'), '恢复后文件内容不是远端版本');
    assert(!(await fsp.access(path.join(WORK, '本地未同步.txt')).then(() => true).catch(() => false)),
      'reset --hard 本该把工作区对齐远端（本地独有文件应已移出工作区，转而留在救援分支里）');

    // 🔴 关键：本地内容必须有一个**分支名**指着（只提交的话 reset 后就成悬空对象，用户找不回来）
    assert(pulled.rescueBranch, `没有生成救援分支：${JSON.stringify(pulled)}`);
    const branches = await git(['branch', '--list', pulled.rescueBranch], WORK);
    assert(branches.ok && branches.stdout.includes(pulled.rescueBranch), `救援分支不存在：${branches.stdout}`);
    const rescued = await git(['-c', 'core.quotepath=false', 'log', '--name-only', '--oneline', pulled.rescueBranch], WORK);
    assert(/拉取前的本地快照/.test(rescued.stdout), `救援分支上没有本地快照提交：${rescued.stdout}`);
    assert(rescued.stdout.includes('本地未同步'), '本地独有文件没被留在救援分支（会永久丢失）');
    // 救援分支只留在本地仓库里（不会被 push 上去污染远端）
    const remoteBranches = await git(['--git-dir', REMOTE, 'branch', '--list']);
    assert(!remoteBranches.stdout.includes('sitian-rescue'), '救援分支被推到远端了（不该污染远端）');
    return `落后 ${probe.behind} 项 → 内容与远端一致，本地改动留在分支 ${pulled.rescueBranch}`;
  });

  await check('拉取：已是最新时如实回报「远程没有新内容」', async () => {
    const r = await H.pullOnce(WORK, { confirm: false });
    eq(r.success, true, `应成功探测：${r.error}`);
    eq(r.pulled, false, '不该有内容可拉');
    assert(/没有新内容/.test(r.message || ''), `文案不对：${r.message}`);
    return r.message;
  });

  await check('拉取：远程为空时给出结论而不是报错', async () => {
    const emptyRemote = path.join(TMP, 'empty-remote-2.git');
    await git(['init', '--bare', emptyRemote]);
    const dir3 = path.join(TMP, 'pull-empty');
    await H.ensureRepo(dir3);
    await fsp.writeFile(path.join(dir3, 'x.txt'), 'x', 'utf-8');
    await H.setRemote(dir3, emptyRemote);
    const r = await H.pullOnce(dir3, { confirm: false });
    eq(r.success, true, `空远程应算成功（只是没内容）：${r.error}`);
    eq(r.pulled, false, 'pulled');
    assert(/空/.test(r.message || ''), `文案不对：${r.message}`);
    return r.message;
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
  // 顺手清掉为「隔离用户全局 git 配置」建的临时配置文件
  await fsp.rm(TEST_GITCONFIG, { force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error('单元测试运行器异常:', err);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(TEST_GITCONFIG, { force: true }).catch(() => {});
    process.exit(1);
  });
