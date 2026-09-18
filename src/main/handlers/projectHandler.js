// src/main/handlers/projectHandler.js — `.sitian` 项目文件的文件系统侧（Phase 1：独立运行基础）
//
// 职责边界（刻意划死）：
//   本文件 = 「路径 + 磁盘 I/O + 备份」；**不解释项目内容**
//   内容结构 / 校验 / 迁移 / 快照 → `src/renderer/src/utils/projectSchema.js`
//   内存态 + UI 交互                  → `src/renderer/src/store/projectStore.js`
//
// ⚠️ 本文件**不在顶层 require('electron')**：核心 fs 函数必须能被纯 Node 直接 require，
//    这样 `scripts/tests/unit/test_project_io.js` 才能在不启动 Electron 的前提下做真实落盘测试
//    （渲染进程侧的 CDP 用例里 `window.sitianAPI` 是 mock，永远测不到真实文件 I/O）。
//    Electron 依赖（dialog/shell/app）全部经 registerProjectHandlers 注入。
//
// 安全约定：
//   · 只写 `.sitian` 扩展名的文件（防路径穿越/误覆盖用户的 md）
//   · 落盘一律「先备份旧文件 → 写临时文件 → rename 覆盖」（断电不会留半个 JSON）
//   · 备份目录 `<项目名>.backups/` 与项目文件同目录，保留最近 BACKUP_KEEP 份

const path = require('path');
const fs = require('fs').promises;
const { execFile } = require('child_process');

const PROJECT_EXT = '.sitian';
const BACKUP_KEEP = 10;

// 与 `src/main/index.js` 的 sanitizeFileName（batch-import-notes 用）共用同一套非法字符表。
// ⚠️ 清洗顺序与 index.js 相反：**先替换非法字符、再取 basename**。
//    index.js 先 basename 是因为它处理的只是一个词条名；项目名里用户可能写 `世界/子项目`，
//    先 basename 会把「世界/」整段丢掉（实测：'我的世界/A:B' → 'A_B'）。
//    先替换则 `/` 变 `_`，basename 仅作为「绝不产生目录层级」的第二道闸门。
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

function sanitizeFileName(name) {
  const cleaned = String(name || '').trim().replace(ILLEGAL_CHARS, '_');
  return path.basename(cleaned);
}

function isProjectPath(p) {
  return typeof p === 'string' && p.toLowerCase().endsWith(PROJECT_EXT);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch (e) { return false; }
}

// 时间戳带毫秒：**秒级时间戳会被同一秒内的多次保存撞名互相覆盖**
// （实测：连续写 12 次只剩 1 份备份）。毫秒仍可能撞，故再套一层 -2/-3 去重。
function stamp(d) {
  return (d instanceof Date ? d : new Date()).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

// 目标路径已被占用时追加 -2/-3 …，绝不覆盖已存在的备份
async function uniquePath(p) {
  if (!(await fileExists(p))) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; i <= 9999; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error(`备份文件过多，无法生成唯一名字：${p}`);
}

function assertProjectPath(p) {
  if (!isProjectPath(p)) throw new Error(`不是司天项目文件（需以 ${PROJECT_EXT} 结尾）：${p}`);
  return p;
}

function backupDirFor(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, PROJECT_EXT);
  return path.join(dir, `${base}${PROJECT_EXT}.backups`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 备份项目文件到 `<name>.sitian.backups/<name>-<ts>.sitian`，只保留最近 keep 份。
 * 旧文件不存在时返回 { backedUp: false }（首次落盘）。
 */
async function makeBackup(filePath, keep = BACKUP_KEEP) {
  try {
    await fs.access(filePath);
  } catch (e) {
    return { backedUp: false, reason: 'no-existing-file' };
  }
  const dir = backupDirFor(filePath);
  await ensureDir(dir);
  const base = path.basename(filePath, PROJECT_EXT);
  const dest = await uniquePath(path.join(dir, `${base}-${stamp()}.sitian`));
  await fs.copyFile(filePath, dest);
  // 轮转：只保留最近 keep 份
  try {
    const all = (await fs.readdir(dir)).filter(f => f.endsWith(PROJECT_EXT)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) {
      await fs.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch (e) { /* 轮转失败不影响备份本身 */ }
  return { backedUp: true, backupPath: dest, backupDir: dir };
}

/** 原子写：先写 .tmp-<ts> 再 rename（rename 在同一卷上是原子的） */
async function atomicWriteJson(filePath, project) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  const text = JSON.stringify(project, null, 2);
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return { bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 写出项目文件（含旧文件备份）。
 * @returns {{ success: true, filePath: string, bytes: number, backupPath: string|null }}
 */
async function writeProjectFile(filePath, project, { backup = true, keep = BACKUP_KEEP } = {}) {
  assertProjectPath(filePath);
  let backupInfo = { backedUp: false, backupPath: null };
  if (backup) backupInfo = await makeBackup(filePath, keep);
  const { bytes } = await atomicWriteJson(filePath, project);
  return { success: true, filePath, bytes, backupPath: backupInfo.backupPath || null };
}

/**
 * 读取项目文件（只解析，不校验 —— 校验在渲染进程的 projectSchema）。
 * @returns {{ success: true, filePath, project, bytes, mtime }}
 */
async function readProjectFile(filePath) {
  assertProjectPath(filePath);
  const raw = await fs.readFile(filePath, 'utf-8');
  const stat = await fs.stat(filePath);
  return {
    success: true,
    filePath,
    project: JSON.parse(raw),
    bytes: Buffer.byteLength(raw, 'utf8'),
    mtime: stat.mtime.toISOString(),
  };
}

/** 在 dir 内新建项目文件；同名时自动追加 -2 / -3 …（绝不覆盖已有项目） */
async function createProjectFile(dir, name, project) {
  await ensureDir(dir);
  const safe = sanitizeFileName(name) || '未命名项目';
  let filePath = path.join(dir, `${safe}${PROJECT_EXT}`);
  let i = 2;
  while (true) {
    try {
      await fs.access(filePath);
    } catch (e) {
      break; // 不存在 → 可用
    }
    filePath = path.join(dir, `${safe}-${i}${PROJECT_EXT}`);
    i += 1;
    if (i > 999) throw new Error('同名项目过多，请换个名字');
  }
  const { bytes } = await atomicWriteJson(filePath, project);
  return { success: true, filePath, dir, bytes, name: path.basename(filePath) };
}

/** 列出目录下的 .sitian 项目（读 meta 供列表展示；单个文件损坏不影响其余） */
async function listProjectFiles(dir) {
  await ensureDir(dir);
  const names = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith(PROJECT_EXT));
  const items = [];
  for (const n of names) {
    const fp = path.join(dir, n);
    const item = { name: n, filePath: fp, meta: null, bytes: 0, mtime: '', error: '' };
    try {
      const stat = await fs.stat(fp);
      item.bytes = stat.size;
      item.mtime = stat.mtime.toISOString();
      const parsed = JSON.parse(await fs.readFile(fp, 'utf-8'));
      item.meta = (parsed && parsed.meta) || null;
      item.version = (parsed && parsed.version) || '';
      item.entityCount = parsed && parsed.entities && typeof parsed.entities === 'object'
        ? Object.keys(parsed.entities).length : 0;
    } catch (err) {
      item.error = err.message;
    }
    items.push(item);
  }
  items.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return { success: true, dir, items };
}

/** 项目文件所在目录是否是 git 仓库 */
async function isGitRepo(filePath) {
  try {
    await fs.access(path.join(path.dirname(filePath), '.git'));
    return true;
  } catch (e) {
    return false;
  }
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : '' });
    });
  });
}

/**
 * Git 集成钩子（Phase 1.5）：仅在项目目录本身是 git 仓库时提交，否则静默跳过。
 * 刻意**不在保存流程里自动调用** —— 由用户显式触发，避免替用户 commit。
 */
async function gitSnapshot({ filePath, message = '司天快照' }) {
  assertProjectPath(filePath);
  const dir = path.dirname(filePath);
  if (!(await isGitRepo(filePath))) {
    return { success: false, skipped: true, reason: '项目目录不是 git 仓库（git 集成已跳过）' };
  }
  const add = await runGit(dir, ['add', '-A']);
  if (!add.ok) return { success: false, error: add.error || add.stderr };
  const commit = await runGit(dir, ['commit', '-m', String(message)]);
  if (!commit.ok) {
    // 无变更时 git commit 退出码非 0 —— 不算失败
    const nothing = /nothing to commit|no changes added/i.test(commit.stdout + commit.stderr);
    return { success: nothing, skipped: nothing, reason: nothing ? '没有需要提交的变更' : (commit.error || commit.stderr) };
  }
  return { success: true, stdout: commit.stdout.trim() };
}

/**
 * 注册 IPC。依赖全部注入（本文件不 require('electron')）。
 * @param {{ ipcMain, dialog, shell, getMainWindow?: () => any,
 *           getDefaultProjectDir: () => string, getLastProjectPath?: () => string,
 *           setLastProjectPath?: (p: string) => any }} deps
 */
function registerProjectHandlers(deps) {
  const {
    ipcMain, dialog, shell,
    getMainWindow = () => null,
    getDefaultProjectDir,
    getLastProjectPath = () => '',
    setLastProjectPath = async () => '',
  } = deps;

  const ok = (data) => ({ success: true, ...data });
  const fail = (err) => ({ success: false, error: (err && err.message) || String(err) });

  // 新建项目
  ipcMain.handle('project-create', async (event, payload = {}) => {
    try {
      const dir = payload.dir || getDefaultProjectDir();
      const res = await createProjectFile(dir, payload.name || '未命名项目', payload.project || {});
      await setLastProjectPath(res.filePath);
      return ok(res);
    } catch (err) {
      return fail(err);
    }
  });

  // 打开项目（未给路径 → 弹选择框）
  ipcMain.handle('project-open', async (event, filePath = '') => {
    try {
      let target = filePath;
      if (!target) {
        const res = await dialog.showOpenDialog(getMainWindow(), {
          title: '打开司天项目',
          defaultPath: getLastProjectPath() || getDefaultProjectDir(),
          filters: [{ name: '司天项目', extensions: ['sitian'] }],
          properties: ['openFile'],
        });
        if (res.canceled || !res.filePaths || !res.filePaths[0]) return { success: false, canceled: true };
        target = res.filePaths[0];
      }
      const read = await readProjectFile(target);
      await setLastProjectPath(target);
      return ok({ ...read, dir: path.dirname(target) });
    } catch (err) {
      return fail(err);
    }
  });

  // 保存项目（备份旧文件 → 原子覆盖；不解释内容）
  ipcMain.handle('project-save', async (event, payload = {}) => {
    try {
      const target = payload.filePath || getLastProjectPath();
      if (!target) return { success: false, error: '项目尚未落盘（没有 filePath）' };
      const res = await writeProjectFile(target, payload.project || {});
      await setLastProjectPath(target);
      return ok(res);
    } catch (err) {
      return fail(err);
    }
  });

  // 项目列表
  ipcMain.handle('project-list', async (event, dir = '') => {
    try {
      return ok(await listProjectFiles(dir || getDefaultProjectDir()));
    } catch (err) {
      return fail(err);
    }
  });

  // 选择项目目录
  ipcMain.handle('project-pick-dir', async () => {
    try {
      const res = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择项目目录',
        defaultPath: getDefaultProjectDir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { success: false, canceled: true };
      return ok({ dir: res.filePaths[0] });
    } catch (err) {
      return fail(err);
    }
  });

  // 在文件管理器中定位项目文件
  ipcMain.handle('project-reveal', async (event, filePath) => {
    try {
      assertProjectPath(filePath);
      shell.showItemInFolder(filePath);
      return ok({ filePath });
    } catch (err) {
      return fail(err);
    }
  });

  // 手动备份
  ipcMain.handle('project-backup-now', async (event, filePath) => {
    try {
      assertProjectPath(filePath);
      return ok(await makeBackup(filePath, BACKUP_KEEP));
    } catch (err) {
      return fail(err);
    }
  });

  // Git 快照（仅在项目目录是 git 仓库时生效）
  ipcMain.handle('project-git-snapshot', async (event, payload = {}) => {
    try {
      return ok(await gitSnapshot(payload));
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = {
  PROJECT_EXT,
  BACKUP_KEEP,
  ILLEGAL_CHARS,
  sanitizeFileName,
  isProjectPath,
  backupDirFor,
  makeBackup,
  atomicWriteJson,
  writeProjectFile,
  readProjectFile,
  createProjectFile,
  listProjectFiles,
  isGitRepo,
  gitSnapshot,
  registerProjectHandlers,
};
