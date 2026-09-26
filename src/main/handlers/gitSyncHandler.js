// src/main/handlers/gitSyncHandler.js — 「一键同步到远程仓库」的文件系统侧
//
// 目标（用户需求 2026-09-21 / 08）：**傻瓜式** —— 用户只填一个仓库地址，点「同步」就把司天数据推到远端，
// 不要求他敲任何 git 命令、也不要求他懂分支/暂存区；反向还要能「从远程恢复」（拉取，带明确警告）。
//
// 设计边界（与 projectHandler 同一套纪律）：
//   · 本文件**顶层不 require('electron')** —— 核心 git 函数必须能被纯 Node require，
//     这样 `scripts/tests/unit/test_git_sync.js` 能用「本地 bare 仓库当远程」做真实端到端测试（无需网络）。
//   · 本文件只碰 git（init / remote / add / commit / push / fetch / reset），**不解释司天项目内容**。
//   · 用户可见文案一律「人话」，不要回显 git 原始报错堆栈。
//
// 安全约定（2026-09-22 加固，见 gitCredentialStore.js 头部的真实事故说明）：
//   · 令牌**由本应用保管**（加密落盘），推送/拉取时通过**临时 credential helper + 环境变量**喂给 git：
//     `-c credential.helper= -c credential.helper=!f(){ echo password=$SITIAN_GIT_TOKEN; }`。
//     → 既写进 .git/config、也不进 argv（进程列表看不到）、更不依赖系统凭据管理器里"能不能取回来"。
//   · 系统凭据管理器（`git credential approve`）仍**附加写一次**，让用户在命令行里也能用；但它不是推送的前提。
//   · 所有 git 调用带 `GIT_TERMINAL_PROMPT=0`：缺凭证时**立刻失败**，不会把 UI 挂死在等输入上。
//   · 任何回给渲染层的字符串都先脱敏（令牌 + URL 内嵌凭据）。
//   · 地址里若内嵌凭据（`https://token@host/...`）→ 自动抽出令牌、把干净地址写进 remote（避免明文落 .git/config）。

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

/** 临时 credential helper：用户名写字面量，密码走环境变量（令牌不进 argv） */
const CREDENTIAL_HELPER = '!f() { echo username=$SITIAN_GIT_USERNAME; echo password=$SITIAN_GIT_TOKEN; }; f';

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

/** 脱敏：抹掉令牌与 URL 内嵌凭据（所有回渲染层的字符串都要过这一层） */
function sanitize(text, secrets = []) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    const t = String(s || '');
    if (t.length >= 6) out = out.split(t).join('***');
  }
  // https://user:pass@host / https://token@host
  out = out.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
  return out;
}

/** 从仓库地址里取域名（给「保存令牌」用，免去用户手填；已去掉内嵌凭据） */
function hostFromUrl(url) {
  const m = String(url || '').match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)/i);
  return m ? m[1] : '';
}

/**
 * 拆出 URL 里内嵌的凭据（用户常直接粘 `https://<token>@github.com/u/r.git`）。
 * 返回干净地址 + 抽出的令牌/用户名 —— 令牌交给凭据保管，地址不含明文。
 */
function extractUrlCredential(url) {
  const raw = String(url || '').trim();
  const m = raw.match(/^(https?:\/\/)(?:([^:@/\s]+)(?::([^@/\s]*))?@)?(.+)$/i);
  if (!m) return { url: raw, token: '', username: '' };
  const [, scheme, user, pass, rest] = m;
  const clean = `${scheme}${rest}`;
  if (!user) return { url: clean, token: '', username: '' };
  // 常见两种写法：`user:token@`（标准）与 `token@`（GitHub 也接受 token 当用户名）
  const token = pass || user;
  const username = pass ? user : '';
  return { url: clean, token, username };
}

/** 把 git 的原始报错翻成人话（用户不该看到 "fatal: not a git repository" 这种） */
function humanize(res, fallback = '操作失败') {
  const text = sanitize(`${res.stderr || ''} ${res.stdout || ''} ${res.error || ''}`);
  // ① 令牌被明确拒绝（远端给了 401/403 / Authentication failed）——
  //    与「压根没找到凭据」区分开：这两种要给完全不同的指引（本次事故就是混为一谈）
  if (/Authentication failed|Invalid username or password|Support for password authentication|\b40[13]\b|Bad credentials|Permission to .* denied/i.test(text)) {
    return '远程仓库拒绝了这个令牌：请确认令牌没有过期、且有该仓库的读写权限'
      + '（GitHub: 经典令牌勾 repo；细粒度令牌勾 Contents: Read and write，并把该仓库加入授权列表）';
  }
  if (/not a git repository/i.test(text)) return '这个目录还不是 git 仓库（第一次同步会自动创建）';
  if (/Repository not found|repository .* (not found|does not exist)|not found/i.test(text)) {
    return '找不到远程仓库：地址可能写错，或令牌无权访问它（私有仓库必须授权该仓库；GitHub 对无权限的私有仓库统一回 404）';
  }
  if (/could not read Username|could not read Password|terminal prompts disabled|No credential/i.test(text)) {
    return '远程仓库需要登录：请在下方填一次访问令牌（私有仓库必须）';
  }
  if (/non-fast-forward|rejected|fetch first/i.test(text)) {
    return '远程仓库里有你本地没有的内容（可能来自另一台设备）：先点「从远程恢复」拉取，或先在另一台设备同步';
  }
  if (/Connection|resolve host|Could not|network|timed out|unable to access/i.test(text)) {
    return '连不上远程仓库：检查网络/代理，或仓库地址是否可访问';
  }
  if (/Permission denied|publickey/i.test(text)) {
    return 'SSH 密钥未被接受：改用 HTTPS 地址 + 访问令牌更简单';
  }
  const first = sanitize((res.stderr || res.error || '')).split('\n').map(s => s.trim()).filter(Boolean)[0];
  return first ? `${fallback}：${first}` : fallback;
}

// ===== 凭据注入 =====

/**
 * `-c credential.helper=` 先清空继承来的 helper，再接上我们自己的（令牌走环境变量）。
 *
 * 🔴 **无令牌时也必须清空**（2026-09-24 修，用户实测被 GUI 弹窗打断）：
 *    旧实现 `cred === null → return []`，于是任何「**还没填令牌就访问远程**」的路径
 *    （典型：点「测试连接」，或 `remoteHeads`）都会让 git 去用**系统配置的凭据助手** ——
 *    Windows 上通常是 Git Credential Manager，它会弹出一个
 *    「Credential Helper Selector」GUI 窗口打断用户。
 *    ⚠️ `GIT_TERMINAL_PROMPT=0` 只挡得住**终端**输入，**挡不住外部 GUI 助手**。
 *    清空后 git 会直接失败，由 `humanize()` 给出「请先填令牌」的人话提示 —— 这才是正确交互。
 */
function credentialArgs(cred) {
  const reset = ['-c', 'credential.helper='];
  if (!cred || !cred.token) return reset;
  return [...reset, '-c', `credential.helper=${CREDENTIAL_HELPER}`];
}

function credentialEnv(cred) {
  if (!cred || !cred.token) return {};
  return {
    SITIAN_GIT_USERNAME: String(cred.username || 'git'),
    SITIAN_GIT_TOKEN: String(cred.token),
  };
}

/**
 * 取本次操作要用的凭据：先看应用侧保管（主路径），再退回地址里内嵌的凭据。
 * @returns {Promise<{host:string, username:string, token:string}|null>}
 */
async function resolveCredential({ dir, url = '', credentialStore = null } = {}) {
  // ⚠️ 用**原始**地址（保留内嵌凭据）：getRemote 会剥掉凭据，手工配置的仓库就取不到了
  const remote = url || (dir ? await getRemoteRaw(dir) : '');
  const host = hostFromUrl(remote);
  if (credentialStore && host) {
    try {
      const saved = await credentialStore.get(host);
      if (saved && saved.token) return { host, username: saved.username || '', token: saved.token };
    } catch (e) { /* 保管层异常 → 走下面的兜底 */ }
  }
  const inline = extractUrlCredential(remote);
  if (inline.token) return { host, username: inline.username, token: inline.token };
  return null;
}

/** 令牌要脱敏的部分（回渲染层前抹掉） */
function secretsOf(cred) {
  return cred && cred.token ? [cred.token] : [];
}

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

/** 当前 origin 地址（已去掉内嵌凭据，绝不明文回渲染层） */
async function getRemote(dir) {
  const r = await runGit(dir, ['remote', 'get-url', 'origin']);
  if (!r.ok) return '';
  return extractUrlCredential(r.stdout.trim()).url;
}

/**
 * 原始 origin 地址（**保留内嵌凭据**）—— 只给凭据解析用，绝不回渲染层。
 * 手工用 `git remote set-url https://token@…` 配过的仓库只有这里能看到令牌。
 */
async function getRemoteRaw(dir) {
  const r = await runGit(dir, ['remote', 'get-url', 'origin']);
  return r.ok ? r.stdout.trim() : '';
}

/** 远程分支清单（--heads）：既用于「测试连接」，也用于判断"远程是空的/分支名不一样" */
async function remoteHeads(dir, { credential = null, timeout = 60000 } = {}) {
  const r = await runGit(dir, [...credentialArgs(credential), 'ls-remote', '--heads', 'origin'], {
    timeout, env: credentialEnv(credential),
  });
  if (!r.ok) return { ok: false, heads: [], error: humanize(r, '连接远程仓库失败'), needsToken: !credential };
  const heads = r.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => (l.split(/\s+/)[1] || '')).filter(Boolean);
  return { ok: true, heads };
}

/** 设置/替换 origin（没有则 add，已有则 set-url）；内嵌凭据会被抽出返回 */
async function setRemote(dir, url) {
  const clean = String(url || '').trim();
  if (!clean) return { ok: false, error: '仓库地址为空' };
  if (!/^(https?:\/\/|git@|ssh:\/\/|\/|[A-Za-z]:[\\/])/i.test(clean)) {
    return { ok: false, error: '地址看起来不对：请填 https://github.com/你的用户名/仓库.git（或在本地路径/SSH 地址）' };
  }
  const parsed = extractUrlCredential(clean);
  const cur = await getRemote(dir);
  const args = cur ? ['remote', 'set-url', 'origin', parsed.url] : ['remote', 'add', 'origin', parsed.url];
  const r = await runGit(dir, args);
  if (!r.ok) return { ok: false, error: humanize(r, '保存仓库地址失败') };
  return { ok: true, url: parsed.url, inlineToken: parsed.token, inlineUsername: parsed.username };
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
async function gitStatus(dir, { credentialStore = null } = {}) {
  const out = {
    dir, isRepo: false, remote: '', branch: '', dirty: 0, lastCommit: '', lastCommitAt: '',
    hasToken: false, tokenUsername: '', error: '',
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
  // 「令牌已保存？」——面板据此给明确回执（用户最恨「我明明填了却还说没登录」）
  if (credentialStore && out.remote) {
    try {
      const cred = await credentialStore.get(hostFromUrl(out.remote));
      if (cred && cred.token) {
        out.hasToken = true;
        out.tokenUsername = cred.username || '';
      }
    } catch (e) { /* 忽略 */ }
  }
  return out;
}

/**
 * 一键同步：init（必要时）→ 写 .gitignore → add -A → commit → push origin
 * @param {{credential?: {username:string,token:string}|null}} opts 凭据（来自 credentialStore）
 */
async function syncOnce(dir, { message = '', branch = '', credential = null } = {}) {
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
    return { success: false, error: '这个目录还是空的：先在司天里创建/打开项目，再来同步', changed: 0 };
  }

  const br = branch || (await currentBranch(dir)) || 'main';
  const push = await runGit(dir, [...credentialArgs(credential), 'push', '-u', 'origin', br], {
    timeout: 180000, env: credentialEnv(credential),
  });
  if (!push.ok) {
    return {
      success: false,
      committed,
      changed,
      branch: br,
      remote: sanitize(remote, secretsOf(credential)),
      needsToken: !credential,
      error: humanize(push, '推送到远程仓库失败'),
    };
  }
  return { success: true, committed, pushed: true, changed, branch: br, remote: sanitize(remote, secretsOf(credential)) };
}

/**
 * 「测试连接」：用当前凭据访问远端（ls-remote），把失败原因在人话层就分清。
 * 价值：用户填完令牌立刻知道能不能用，而不是等 push 时撞一句含糊的「需要登录」。
 */
async function testRemote(dir, { credential = null, timeout = 60000 } = {}) {
  if (!dir) return { success: false, error: '没有指定同步目录' };
  if (!(await isGitRepo(dir))) return { success: false, error: '这个目录还没建成仓库（先点「保存并连接」）' };
  const remote = await getRemote(dir);
  if (!remote) return { success: false, error: '还没有填远程仓库地址' };
  const r = await runGit(dir, [...credentialArgs(credential), 'ls-remote', '--heads', 'origin'], {
    timeout, env: credentialEnv(credential),
  });
  if (!r.ok) {
    return { success: false, error: humanize(r, '连接远程仓库失败'), needsToken: !credential };
  }
  const heads = r.stdout.split('\n').map(l => l.trim()).filter(Boolean).length;
  return {
    success: true,
    host: hostFromUrl(remote),
    heads,
    note: heads === 0 ? '连接成功（远端仓库目前是空的，正好用来首次推送）' : `连接成功（远端有 ${heads} 个分支）`,
  };
}

/**
 * 「从远程恢复」（拉取）。⚠️ 破坏性：会把本地改成与远端一致。
 *
 * 安全设计（两道闸门，缺一不可）：
 *   1. 非 confirm 调用**只做 fetch 探测**并回报差异（behind/ahead/dirty），不改动工作区。
 *   2. 真拉取前先把本地当前内容 `add -A + commit` 一次 —— 于是 `reset --hard FETCH_HEAD`
 *      不会丢任何东西（旧状态仍在本地 git 历史里），同时也解决了「未跟踪文件挡住 reset」的问题。
 *      界面文案必须如实说明这一点。
 */
async function pullOnce(dir, { branch = '', credential = null, confirm = false } = {}) {
  if (!dir) return { success: false, error: '没有指定同步目录' };
  if (!(await isGitRepo(dir))) return { success: false, error: '这个目录还没建成仓库（先点「保存并连接」）' };
  const remote = await getRemote(dir);
  if (!remote) return { success: false, error: '还没有填远程仓库地址' };
  let br = branch || (await currentBranch(dir)) || 'main';
  const credArgs = credentialArgs(credential);
  const credOpts = { timeout: 180000, env: credentialEnv(credential) };

  let fetchRes = await runGit(dir, [...credArgs, 'fetch', 'origin', br], credOpts);
  let branchNote = '';
  if (!fetchRes.ok && /couldn't find remote ref|does not exist|not found/i.test(`${fetchRes.stderr} ${fetchRes.error}`)) {
    // 本地分支名与远端不一致（例：本地 master、远端 main；或远程还是空仓库）
    const heads = await remoteHeads(dir, { credential });
    if (heads.ok && heads.heads.length === 0) {
      return { success: true, pulled: false, behind: 0, ahead: 0, message: '远程仓库还是空的：没有可恢复的内容' };
    }
    if (heads.ok) {
      const names = heads.heads.map(h => h.replace(/^refs\/heads\//, ''));
      const pick = names.includes('main') ? 'main' : names[0];
      if (pick && pick !== br) {
        const retry = await runGit(dir, [...credArgs, 'fetch', 'origin', pick], credOpts);
        if (retry.ok) {
          branchNote = `（本地在 ${br}，远端内容在 ${pick}，已按远端分支读取；同步到远端时建议统一分支名）`;
          fetchRes = retry;
          br = pick;
        }
      }
    }
  }
  if (!fetchRes.ok) {
    return { success: false, error: humanize(fetchRes, '从远程仓库读取失败'), needsToken: !credential };
  }
  const fetchHead = await runGit(dir, ['rev-parse', '--verify', 'FETCH_HEAD']);
  if (!fetchHead.ok) {
    return { success: true, pulled: false, behind: 0, ahead: 0, message: '远程仓库还是空的：没有可恢复的内容' };
  }

  let behind = 0;
  let ahead = 0;
  if (await hasCommits(dir)) {
    const b = await runGit(dir, ['rev-list', '--count', 'HEAD..FETCH_HEAD']);
    const a = await runGit(dir, ['rev-list', '--count', 'FETCH_HEAD..HEAD']);
    behind = b.ok ? parseInt(b.stdout.trim(), 10) || 0 : 0;
    ahead = a.ok ? parseInt(a.stdout.trim(), 10) || 0 : 0;
  } else {
    behind = -1;   // 本地还没有任何提交 → 差异无法按提交数计算，一律按「有内容要恢复」处理
  }

  const st = await runGit(dir, ['status', '--porcelain']);
  const dirty = st.ok ? st.stdout.split('\n').filter(l => l.trim()).length : 0;

  if (behind === 0) {
    return { success: true, pulled: false, behind: 0, ahead, dirty, branchNote,
             message: '远程没有新内容，本地不必恢复' + branchNote };
  }
  if (!confirm) {
    return {
      success: false,
      needsConfirm: true,
      behind, ahead, dirty, branch: br, branchNote,
      remote: sanitize(remote, secretsOf(credential)),
      error: `远程有 ${behind < 0 ? '一批' : behind} 项新内容：恢复会把本地改成与远端一致${branchNote}`,
    };
  }

  // —— 真拉取：先给本地状态留一条退路（提交 + 独立救援分支），再对齐远端
  // 🔴 只提交是不够的：`reset --hard` 之后那条快照提交会变成悬空对象（只在 reflog 里），
  //    普通用户根本找不回来。所以必须给它一个**分支名**（本地分支，不会被 push 上去）。
  const ident = await identityArgs(dir);
  let localSnapshot = false;
  let rescueBranch = '';
  const oldHeadRes = await runGit(dir, ['rev-parse', '--verify', 'HEAD']);
  const oldHead = oldHeadRes.ok ? oldHeadRes.stdout.trim() : '';
  const add = await runGit(dir, ['add', '-A']);
  if (add.ok) {
    const st2 = await runGit(dir, ['status', '--porcelain']);
    const changedNow = st2.ok ? st2.stdout.split('\n').filter(l => l.trim()).length : 0;
    if (changedNow > 0) {
      const c = await runGit(dir, [...ident, 'commit', '-m', `拉取前的本地快照 ${new Date().toLocaleString('zh-CN')}`]);
      localSnapshot = c.ok;
    }
  }
  if (oldHead || localSnapshot) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `sitian-rescue-${ts}`;
    const mk = await runGit(dir, ['branch', '-f', name]);
    if (mk.ok) rescueBranch = name;
  }

  const reset = await runGit(dir, ['reset', '--hard', 'FETCH_HEAD']);
  if (!reset.ok) return { success: false, error: humanize(reset, '恢复到远端版本失败'), localSnapshot, rescueBranch };

  let changedFiles = [];
  if (oldHead) {
    const diff = await runGit(dir, ['diff', '--name-only', oldHead, 'FETCH_HEAD']);
    if (diff.ok) changedFiles = diff.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 30);
  }

  return {
    success: true,
    pulled: true,
    behind: behind < 0 ? null : behind,
    ahead,
    dirty,
    branch: br,
    branchNote,
    localSnapshot,
    rescueBranch,
    changedFiles,
    remote: sanitize(remote, secretsOf(credential)),
  };
}

/**
 * 把访问令牌写进**系统凭据管理器**（附加动作，不是推送的前提）。
 * 令牌只经 stdin 传给 git，绝不进日志、绝不写进 .git/config、绝不回传渲染层。
 */
async function approveCredential({ host = 'github.com', username = '', token = '' } = {}) {
  const h = String(host || '').trim();
  const u = String(username || '').trim();
  const t = String(token || '').trim();
  if (!h || !t) return { ok: false, error: '缺少仓库域名或令牌' };
  const input = `protocol=https\nhost=${h}\nusername=${u || 'git'}\npassword=${t}\n\n`;
  const r = await runGit(process.cwd(), ['credential', 'approve'], { stdin: input });
  if (!r.ok) return { ok: false, error: humanize(r, '保存令牌到系统凭据管理器失败') };
  return { ok: true, host: h, username: u || 'git' };
}

/**
 * 注册 IPC。依赖注入（本文件不 require electron）。
 * @param {{ ipcMain: any, getMainWindow?: () => any, getDefaultSyncDir?: () => string,
 *           credentialStore?: any, saveCredentialInline?: (host:string, payload:object)=>Promise<void> }} deps
 */
function registerGitSyncHandlers(deps) {
  const { ipcMain, getDefaultSyncDir = () => '', credentialStore = null } = deps;
  const ok = (data) => ({ success: true, ...data });
  const fail = (err) => ({ success: false, error: (err && err.message) || String(err) });

  ipcMain.handle('git-sync-status', async (event, dir = '') => {
    try {
      return ok(await gitStatus(dir || getDefaultSyncDir(), { credentialStore }));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('git-sync-configure', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const ensured = await ensureRepo(dir);
      if (!ensured.ok) return { success: false, error: ensured.error };
      const set = await setRemote(dir, payload.remoteUrl);   // 地址内嵌凭据会被剥离
      if (!set.ok) return { success: false, error: set.error };
      // 用户粘的地址里带了令牌 → 顺手存进凭据保管，避免明文落 .git/config
      let inlineTokenSaved = false;
      if (set.inlineToken && credentialStore) {
        const res = await credentialStore.set({
          host: hostFromUrl(set.url), username: set.inlineUsername || payload.username || '', token: set.inlineToken,
        });
        inlineTokenSaved = !!res.ok;
      }
      return ok({
        dir, remoteUrl: set.url, created: ensured.created,
        inlineTokenSaved,
        note: inlineTokenSaved ? '地址里的令牌已抽出保存（不再明文写在仓库配置里）' : '',
      });
    } catch (err) { return fail(err); }
  });

  // 令牌：应用侧加密保管（主路径）+ 系统凭据管理器（附加）。**不回显任何令牌内容**
  ipcMain.handle('git-sync-credential', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const remote = payload.remoteUrl || (dir ? await getRemote(dir) : '');
      const host = payload.host || hostFromUrl(remote) || 'github.com';
      const token = String(payload.token || '').trim();
      const username = String(payload.username || '').trim();
      if (!token) return { success: false, error: '令牌为空' };

      let saved = { ok: false, persistent: false, error: '未配置凭据保管（内部错误）' };
      let toSys = { ok: false };
      if (credentialStore) saved = await credentialStore.set({ host, username, token });
      if (!saved.ok) return { success: false, error: saved.error || '保存令牌失败' };
      // 附加：写进系统凭据管理器（失败不影响主路径）
      toSys = await approveCredential({ host, username, token });

      return ok({
        host,
        persistent: !!saved.persistent,
        systemCredential: !!toSys.ok,
        note: saved.persistent
          ? '令牌已加密保存在本机（推送时直接使用，不再依赖系统凭据管理器）'
          : '令牌只在本次运行内有效（本机无加密存储能力）—— 重启后需要重新填一次',
      });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('git-sync-forget', async (event, payload = {}) => {
    try {
      const host = payload.host || hostFromUrl(payload.remoteUrl) || '';
      if (!credentialStore || !host) return { success: false, error: '没有可清除的令牌' };
      const res = await credentialStore.clear(host);
      return res.ok ? ok({ host }) : { success: false, error: res.error };
    } catch (err) { return fail(err); }
  });

  // 「测试连接」：立即验证地址 + 令牌是否真的能用（用户最需要的确定性）
  ipcMain.handle('git-sync-test', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const credential = await resolveCredential({ dir, url: payload.remoteUrl || '', credentialStore });
      return ok(await testRemote(dir, { credential }));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('git-sync-now', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const credential = await resolveCredential({ dir, url: payload.remoteUrl || '', credentialStore });
      const res = await syncOnce(dir, { message: payload.message, branch: payload.branch, credential });
      return ok(res);   // 结构与 syncOnce 一致（含 success=false + 人话 error）
    } catch (err) { return fail(err); }
  });

  // 「从远程恢复」：不带 confirm 时只探测差异（只 fetch，不动工作区）
  ipcMain.handle('git-sync-pull', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultSyncDir();
      const credential = await resolveCredential({ dir, url: payload.remoteUrl || '', credentialStore });
      const res = await pullOnce(dir, { branch: payload.branch, credential, confirm: !!payload.confirm });
      return ok(res);
    } catch (err) { return fail(err); }
  });
}

module.exports = {
  DEFAULT_GITIGNORE,
  CREDENTIAL_HELPER,
  runGit,
  sanitize,
  humanize,
  isGitRepo,
  ensureRepo,
  currentBranch,
  hasCommits,
  getRemote,
  setRemote,
  extractUrlCredential,
  writeDefaultGitignore,
  gitStatus,
  syncOnce,
  pullOnce,
  testRemote,
  approveCredential,
  hostFromUrl,
  credentialArgs,
  credentialEnv,
  resolveCredential,
  registerGitSyncHandlers,
};
