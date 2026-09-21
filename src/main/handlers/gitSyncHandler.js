// src/main/handlers/gitSyncHandler.js — 「一键同步到远程仓库」的文件系统侧
//
// 目标（用户需求 2026-09-21）：**傻瓜式** —— 用户只填一个仓库地址，点「同步」就把司天数据推到远端，
// 不要求他敲任何 git 命令、也不要求他懂分支/暂存区。
//
// 设计边界（与 projectHandler 同一套纪律）：
//   · 本文件**顶层不 require('electron')** —— 核心 git 函数必须能被纯 Node require，
//     这样 `scripts/tests/unit/test_git_sync.js` 能用「本地 bare 仓库当远程」做真实端到端测试（无需网络）。
//   · 本文件只碰 git（init / remote / add / commit / push），**不解释司天项目内容**。
//   · 用户可见文案一律「人话」，不要回显 git 原始报错堆栈（除非他要看详情）。
//
// 安全约定：
//   · 只通过 `git credential approve`（stdin 传入）把令牌写进系统凭据管理器 ——
//     **绝不把令牌拼进 remote URL**（那会明文落进 .git/config），**绝不写进日志/返回值**。
//   · 所有 git 调用带 `GIT_TERMINAL_PROMPT=0`：缺凭证时**立刻失败**，不会把 UI 挂死在等输入上。
//   · 同步时自动写 `.gitignore`（忽略临时文件与本地备份目录），避免仓库被 MB 级备份撑爆。

const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');

const DEFAULT_GITIGNORE = `# 司天同步自动生成：忽略写盘临时文件与本地备份（备份已有本地轮转 + 会话基线）
*.sitian.tmp-*
*.backups/
NUL
Thumbs.db
.DS_Store
`;

/** 跑一条 git 命令（永远非交互、有超时、输出有上限） */
function runGit(cwd, args, { timeout = 120000, env = {}, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...env },
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? (err.message || '') : '',
      });
    });
    if (child.stdin) {
      if (stdin != null) {
        child.stdin.end(stdin);
      } else {
        child.stdin.end();
      }
      child.stdin.on('error', () => {});
    }
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch (e) { return false; }
}

async function isGitRepo(dir) {
  if (!dir) return false;
  return exists(path.join(dir, '.git'));
}

/** 把 git 的原始报错翻成人话（用户不该看到 "fatal: not a git repository" 这种） */
function humanize(res, fallback = '操作失败') {
  const text = `${res.stderr || ''} ${res.stdout || ''} ${res.error || ''}`;
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username or password|403/i.test(text)) {
    return '远程仓库需要登录：请在下方填一次访问令牌（私有仓库必须）';
  }
  if (/Repository not found|not found/i.test(text)) {
    return '找不到远程仓库：检查地址是否写错，或仓库是否为私有（私有仓库需要令牌）';
  }
  if (/non-fast-forward|rejected|fetch first/i.test(text)) {
    return '远程仓库里有你本地没有的内容（可能来自另一台设备）：先在那边同步，或先手动拉取后再同步';
  }
  if (/Connection|resolve host|Could not|network|timed out|unable to access/i.test(text)) {
    return '连不上远程仓库：检查网络/代理，或仓库地址是否可访问';
  }
  if (/Permission denied|publickey/i.test(text)) {
    return 'SSH 密钥未被接受：改用 HTTPS 地址 + 访问令牌更简单';
  }
  const first = (res.stderr || res.error || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
  return first ? `${fallback}：${first}` : fallback;
}

/** 未初始化则 git init（并统一到 main 分支）；已初始化则原样返回 */
async function ensureRepo(dir) {
  if (!dir) return { ok: false, error: '没有目录' };
  await fs.mkdir(dir, { recursive: true });
  if (await isGitRepo(dir)) return { ok: true, created: false };
  const init = await runGit(dir, ['init']);
  if (!init.ok) return { ok: false, error: humanize(init, '初始化仓库失败') };
  // 老版 git 默认分支是 master —— 统一成 main（仅在没有提交时改，已有历史不动）
  const head = await runGit(dir, ['symbolic-ref', '--short', 'HEAD']);
  if (head.ok && head.stdout.trim() === 'master') {
    await runGit(dir, ['branch', '-M', 'main']);
  }
  return { ok: true, created: true };
}

async function currentBranch(dir) {
  const r = await runGit(dir, ['symbolic-ref', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

async function hasCommits(dir) {
  const r = await runGit(dir, ['rev-parse', '--verify', 'HEAD']);
  return r.ok;
}

async function getRemote(dir) {
  const r = await runGit(dir, ['remote', 'get-url', 'origin']);
  return r.ok ? r.stdout.trim() : '';
}

/** 设置/替换 origin（没有则 add，已有则 set-url） */
async function setRemote(dir, url) {
  const clean = String(url || '').trim();
  if (!clean) return { ok: false, error: '仓库地址为空' };
  const cur = await getRemote(dir);
  const args = cur ? ['remote', 'set-url', 'origin', clean] : ['remote', 'add', 'origin', clean];
  const r = await runGit(dir, args);
  return r.ok ? { ok: true, url: clean } : { ok: false, error: humanize(r, '保存仓库地址失败') };
}

/** 自动写 .gitignore（已存在则只在缺少司天忽略项时追加） */
async function writeDefaultGitignore(dir) {
  const p = path.join(dir, '.gitignore');
  const marker = '*.backups/';
  try {
    const cur = await fs.readFile(p, 'utf-8');
    if (cur.includes(marker)) return { ok: true, changed: false };
    await fs.writeFile(p, `${cur.replace(/\s*$/, '')}\n\n${DEFAULT_GITIGNORE}`, 'utf-8');
    return { ok: true, changed: true };
  } catch (e) {
    await fs.writeFile(p, DEFAULT_GITIGNORE, 'utf-8');
    return { ok: true, changed: true };
  }
}

/** 提交者身份：优先用用户既有 git 配置，缺失时用 -c 兜底（不改用户的全局配置） */
async function identityArgs(dir) {
  const name = await runGit(dir, ['config', 'user.name']);
  const email = await runGit(dir, ['config', 'user.email']);
  const args = [];
  if (!name.ok || !name.stdout.trim()) args.push('-c', 'user.name=SiTian');
  if (!email.ok || !email.stdout.trim()) args.push('-c', 'user.email=sitian@localhost');
  return args;
}

/** 仓库状态（面板显示用；不改任何东西） */
async function gitStatus(dir) {
  const out = {
    dir, isRepo: false, remote: '', branch: '', dirty: 0, lastCommit: '', lastCommitAt: '', error: '',
  };
  if (!dir || !(await isGitRepo(dir))) return out;
  out.isRepo = true;
  out.remote = await getRemote(dir);
  out.branch = await currentBranch(dir);
  const st = await runGit(dir, ['status', '--porcelain']);
  if (st.ok) out.dirty = st.stdout.split('\n').filter(l => l.trim()).length;
  if (await hasCommits(dir)) {
    const log = await runGit(dir, ['log', '-1', '--format=%cI%n%s']);
    if (log.ok) {
      const lines = log.stdout.split('\n');
      out.lastCommitAt = (lines[0] || '').trim();
      out.lastCommit = (lines[1] || '').trim();
    }
  }
  return out;
}

/**
 * 一键同步：init（必要时）→ 写 .gitignore → add -A → commit → push origin
 * @returns {{success: boolean, skipped?: string, committed?: boolean, pushed?: boolean,
 *            branch?: string, changed?: number, error?: string, remote?: string}}
 */
async function syncOnce(dir, { message = '', branch = '' } = {}) {
  if (!dir) return { success: false, error: '没有指定同步目录' };
  const ensured = await ensureRepo(dir);
  if (!ensured.ok) return { success: false, error: ensured.error };

  const remote = await getRemote(dir);
  if (!remote) return { success: false, error: '还没有填远程仓库地址（面板里填一次「仓库地址」并保存）' };

  await writeDefaultGitignore(dir);

  const add = await runGit(dir, ['add', '-A']);
  if (!add.ok) return { success: false, error: humanize(add, '暂存改动失败') };

  const st = await runGit(dir, ['status', '--porcelain']);
  const changed = st.ok ? st.stdout.split('\n').filter(l => l.trim()).length : 0;

  let committed = false;
  if (changed > 0) {
    const msg = String(message || '').trim() || `司天同步 ${new Date().toLocaleString('zh-CN')}`;
    const ident = await identityArgs(dir);
    const commit = await runGit(dir, [...ident, 'commit', '-m', msg]);
    if (!commit.ok) return { success: false, error: humanize(commit, '提交失败'), changed };
    committed = true;
  } else if (!(await hasCommits(dir))) {
    // 空目录 + 空仓库：没有可提交内容，直接给结论，别让用户对着「成功」困惑
    return { success: false, error: '这个目录还是空的：先在司天里创建/打开项目，再来同步', changed: 0 };
  }

  const br = branch || (await currentBranch(dir)) || 'main';
  const push = await runGit(dir, ['push', '-u', 'origin', br], { timeout: 180000 });
  if (!push.ok) {
    return {
      success: false,
      committed,
      changed,
      branch: br,
      remote,
      error: humanize(push, '推送到远程仓库失败'),
    };
  }
  return { success: true, committed, pushed: true, changed, branch: br, remote };
}

/**
 * 把访问令牌写进**系统凭据管理器**（Windows 凭据管理器 / macOS Keychain）。
 * 令牌只经 stdin 传给 git，绝不进日志、绝不写进 .git/config、绝不回传渲染层。
 */
async function approveCredential({ host = 'github.com', username = '', token = '' } = {}) {
  const h = String(host || '').trim();
  const u = String(username || '').trim();
  const t = String(token || '').trim();
  if (!h || !t) return { ok: false, error: '缺少仓库域名或令牌' };
  const input = `protocol=https\nhost=${h}\nusername=${u || 'git'}\npassword=${t}\n\n`;
  const r = await runGit(process.cwd(), ['credential', 'approve'], { stdin: input });
  if (!r.ok) return { ok: false, error: humanize(r, '保存令牌失败') };
  return { ok: true, host: h, username: u || 'git' };
}

/** 从仓库地址里取域名（给「保存令牌」用，免去用户手填） */
function hostFromUrl(url) {
  const m = String(url || '').match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)/i);
  return m ? m[1] : '';
}

/**
 * 注册 IPC。依赖注入（本文件不 require electron）。
 * @param {{ ipcMain: any, getMainWindow?: () => any, getDefaultSyncDir?: () => string }} deps
 */
function registerGitSyncHandlers(deps) {
  const { ipcMain, getDefaultSyncDir = () => '' } = deps;
  const ok = (data) => ({ success: true, ...data });
  const fail = (err) => ({ success: false, error: (err && err.message) || String(err) });

  ipcMain.handle('git-sync-status', async (event, dir = '') => {
    try {
      return ok(await gitStatus(dir || getDefaultSyncDir()));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('git-sync-configure', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const ensured = await ensureRepo(dir);
      if (!ensured.ok) return { success: false, error: ensured.error };
      const set = await setRemote(dir, payload.remoteUrl);
      if (!set.ok) return { success: false, error: set.error };
      return ok({ dir, remoteUrl: set.url, created: ensured.created });
    } catch (err) { return fail(err); }
  });

  // 令牌：只确认「已保存到系统凭据管理器」，**不回显任何令牌内容**
  ipcMain.handle('git-sync-credential', async (event, payload = {}) => {
    try {
      const host = payload.host || hostFromUrl(payload.remoteUrl) || 'github.com';
      return ok(await approveCredential({ host, username: payload.username, token: payload.token }));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('git-sync-now', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const res = await syncOnce(dir, { message: payload.message, branch: payload.branch });
      return ok(res);   // 结构与 syncOnce 一致（含 success=false + 人话 error）
    } catch (err) { return fail(err); }
  });
}

module.exports = {
  DEFAULT_GITIGNORE,
  runGit,
  isGitRepo,
  ensureRepo,
  currentBranch,
  hasCommits,
  getRemote,
  setRemote,
  writeDefaultGitignore,
  gitStatus,
  syncOnce,
  approveCredential,
  hostFromUrl,
  registerGitSyncHandlers,
};
