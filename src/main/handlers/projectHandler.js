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

// 会话基线：每次「打开项目」时把文件原样复制一份，固定文件名、覆盖式（永远只有 1 份）。
// 为什么必须要它：快照轮转（BACKUP_KEEP=10）会被高频自动保存迅速刷光 —— 打开项目大改一场后，
// 备份目录里剩的全是最近几分钟的状态，「打开时的样子」永久丢失。基线不参与轮转，专门兜这一层。
// （用户原话：没有数据安全承诺的系统，投进去的手绘时间是无担保贷款。）
const BASELINE_TAG = '.session-baseline' + PROJECT_EXT;

// 原始底图来源（用户导入的 `.map`）备份：放在项目备份目录下的这个子目录里。
// 保留份数比项目备份多几份 —— `.map` 是**只读的原始素材**（几 MB，变化频率远低于项目文件），
// 而它是"地形/河流/道路能否重新导入"的唯一凭据，宁可多留（成本是几 MB 磁盘）。
const BASE_MAP_SRC_DIR = 'basemap-sources';
const BASE_MAP_SRC_KEEP = 10;

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
  // ⚠️ 排除会话基线（BASELINE_TAG）：它是「打开时状态」的唯一留底，绝不能被轮转删掉。
  try {
    const all = (await fs.readdir(dir))
      .filter(f => f.endsWith(PROJECT_EXT) && !f.endsWith(BASELINE_TAG))
      .sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) {
      await fs.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch (e) { /* 轮转失败不影响备份本身 */ }
  return { backedUp: true, backupPath: dest, backupDir: dir };
}

/** 会话基线文件路径：`<name>.sitian.backups/<name>.session-baseline.sitian` */
function sessionBaselinePath(filePath) {
  const dir = backupDirFor(filePath);
  const base = path.basename(filePath, PROJECT_EXT);
  return path.join(dir, `${base}${BASELINE_TAG}`);
}

/**
 * 写入/覆盖「会话基线」= 当前磁盘上项目文件的副本（打开项目时调用）。
 * 覆盖式（恒定 1 份）、不参与轮转 → 「本次会话开始前的数据」永远可回滚。
 */
async function makeSessionBaseline(filePath) {
  try {
    await fs.access(filePath);
  } catch (e) {
    return { backedUp: false, reason: 'no-existing-file' };
  }
  const dest = sessionBaselinePath(filePath);
  await ensureDir(path.dirname(dest));
  await fs.copyFile(filePath, dest);
  return { backedUp: true, baselinePath: dest, backupDir: path.dirname(dest) };
}

/**
 * 原子写**文本**：先写 .tmp-<ts> 再 rename（rename 在同一卷上是原子的）。
 *
 * 2026-10-24（收落盘 380ms）：渲染侧现在**直接递序列化好的 JSON 文本**（`projectJson`），
 * 主进程只负责落盘 —— 不再对 3.6MB 对象图第二次 `JSON.stringify`。`atomicWriteJson` 保留给
 * 内部仍拿对象的调用方（新建项目 / 测试），它只是本函数的薄壳。
 */
async function atomicWriteText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return { bytes: Buffer.byteLength(text, 'utf8') };
}

/** 原子写 JSON 对象（内部仍拿对象的调用方用；紧凑 JSON，口径见下） */
async function atomicWriteJson(filePath, project) {
  // 🔴 **紧凑 JSON（2026-10-11 体积裁剪）**：此前是 `JSON.stringify(project, null, 2)`。
  //    实测暮雨的真实项目：正文 39853484 字节 → 紧凑后 10302398 字节 = **缩进占 74%**。
  //    原因很具体：`scenarios.baseMaps[*].terrain[].points` 是 `[{x,y},…]` 的**上万点数组**，
  //    每点两行缩进 → 一个省的海岸线就是几十万行。项目文件是机器管理的产物，
  //    「人能读」换不来 4 倍体积，而体积直接决定**每次自动保存要写多少字节**（低配机的瓶颈）。
  //    代价（如实记录）：git 侧的一行 = 整个文件，`.sitian` 的 diff 不再逐行可读。
  //    若要恢复可读缩进，只改这一行；不要再在别处另写一份序列化（`serializeProject` 是给测试用的）。
  return atomicWriteText(filePath, JSON.stringify(project));
}

/**
 * 写出项目文件（含旧文件备份）。
 * @param {string|object} projectOrText 已序列化的 JSON 文本（首选），或待序列化的项目对象
 * @returns {{ success: true, filePath: string, bytes: number, backupPath: string|null }}
 */
async function writeProjectFile(filePath, projectOrText, { backup = true, keep = BACKUP_KEEP } = {}) {
  assertProjectPath(filePath);
  let backupInfo = { backedUp: false, backupPath: null };
  if (backup) backupInfo = await makeBackup(filePath, keep);
  const { bytes } = typeof projectOrText === 'string'
    ? await atomicWriteText(filePath, projectOrText)
    : await atomicWriteJson(filePath, projectOrText);
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
/**
 * 🔴 **原始底图来源备份（2026-10-11）** —— 补一个真实造成过损失的缺口。
 *
 * 事故形态：暮雨的 `desite` 底图建于 2026-09-10，当时解析器还读不出高度图/河流/道路，
 * 于是那些数据**从来没进过项目**；等到想补时，唯一的来源是**用户自己还留着的那份
 * 生成器导出**（`desite.map`，4.3MB）。而司天此前**只备份自己的项目文件**
 * （`<名>.sitian.backups/` 轮转 10 份 + 会话基线），**从不留用户导入的 `.map`** ——
 * 那份文件一旦丢了，地形/河流/道路就永久无法恢复（只能去生成器重新做一张，
 * 而新图的海岸线与现有几百块省份边界并不一致）。
 *
 * 所以：**导入 `.map` 时顺手把它原样存一份**，与项目文件放在同一个备份目录下。
 * 三条设计约束：
 *   · **原样字节**（不做任何解析/重编码）：它是"再次导入/刷新"的唯一凭据，改了就不是凭据了；
 *   · **原子写**（先 `.tmp-<ts>` 再 rename）+ **轮转**（只留最近 keep 份）——
 *     与项目文件备份同一套纪律，不另立一套；
 *   · **文件名清洗 + 固定后缀**：用户给的文件名可能带路径分隔符/非法字符，
 *     落盘前过 `sanitizeFileName`（与项目名同一张非法字符表）。
 *
 * ⚠️ 目录里只放 `.map`，与项目备份的 `*.sitian` 混放但**互不干扰**：
 *    项目备份的轮转按 `PROJECT_EXT` 过滤，本函数的轮转按 `.map` 过滤（各扫各的）。
 *
 * @param {string} projectFilePath 当前项目文件（用它定位备份目录）
 * @param {{name?:string, text?:string}} payload `text` = `.map` 的完整原文
 * @returns {{success:true, path:string, bytes:number, dir:string, pruned:number}}
 */
async function saveBaseMapSource(projectFilePath, payload = {}) {
  assertProjectPath(projectFilePath);
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) throw new Error('底图来源内容为空，拒绝写入（不产生空备份）');
  const rawName = sanitizeFileName(payload.name || 'basemap.map');
  const baseName = rawName.toLowerCase().endsWith('.map') ? rawName : `${rawName}.map`;
  const dir = path.join(backupDirFor(projectFilePath), BASE_MAP_SRC_DIR);
  await ensureDir(dir);
  const dest = await uniquePath(path.join(dir, baseName));
  const tmp = `${dest}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf-8');
  try {
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  // 轮转：只保留最近 BASE_MAP_SRC_KEEP 份 `.map`。
  // 🔴 **必须按 mtime 排序，不能按文件名** —— 首版用 `.sort()` 按名字排，于是
  //    「刚写进去的 `reverse.map`」因为字母序靠前被当成"最旧"删掉（单测 e3 当场抓到：
  //    ENOENT，刚留的底还没用就没了）。文件名（`desite.map` / `旧版.map` / `x-2.map`）
  //    与写入先后**没有任何关系**，只有 mtime 是真相。
  let pruned = 0;
  try {
    const names = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith('.map'));
    const withTime = [];
    for (const f of names) {
      const full = path.join(dir, f);
      const st = await fs.stat(full).catch(() => null);
      withTime.push({ full, mtime: st ? st.mtimeMs : 0 });
    }
    withTime.sort((a, b) => a.mtime - b.mtime);            // 最旧的在前
    for (const it of withTime.slice(0, Math.max(0, withTime.length - BASE_MAP_SRC_KEEP))) {
      await fs.unlink(it.full).catch(() => {});
      pruned++;
    }
  } catch (e) { /* 轮转失败不影响备份本身 */ }
  return { success: true, path: dest, bytes: Buffer.byteLength(text, 'utf8'), dir, pruned };
}

/** 列出已备份的原始底图来源（给 UI 显示"我能从哪几份 .map 恢复"） */
async function listBaseMapSources(projectFilePath) {
  assertProjectPath(projectFilePath);
  const dir = path.join(backupDirFor(projectFilePath), BASE_MAP_SRC_DIR);
  try {
    const files = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith('.map'));
    const out = [];
    for (const f of files) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      out.push({
        name: f,
        path: path.join(dir, f),
        bytes: st ? st.size : 0,
        mtime: st ? st.mtime.toISOString() : null,
      });
    }
    out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    return { success: true, dir, files: out };
  } catch (e) {
    return { success: true, dir, files: [] };
  }
}

/**
 * 读回一份**已留底**的原始底图来源（只读；2026-10-13）。
 *
 * 为什么需要它：`saveBaseMapSource` 从 0.2.8 起把导入过的 `.map` 原文留在了
 * `<项目>.sitian.backups/basemap-sources/`，但**只有"列清单"没有"读回来"** ——
 * 于是那批留底在 UI 上等于不存在（"恢复"只能靠用户自己去资源管理器里翻目录、再走一遍
 * 文件选择器）。备份**读不回来**就不算备份。
 *
 * 纪律（与 save 侧对称）：
 *   · **只读**：不写、不改、不动 mtime；
 *   · **只能读 basemap-sources 里的 `.map`**：名字过 `sanitizeFileName`（消掉目录层级），
 *     **再加一道 resolve 后仍在留底目录内的校验** —— 消毒是"不产生层级"，
 *     这道是"即使将来消毒规则被改松，也不许读出去"；
 *   · 找不到就**明确报错**（不返回空串让上层以为读到了一份空底图）。
 */
async function readBaseMapSource(projectFilePath, name) {
  assertProjectPath(projectFilePath);
  const safe = sanitizeFileName(name || '');
  if (!safe || !safe.toLowerCase().endsWith('.map')) {
    throw new Error(`只允许读回 basemap-sources 里的 .map 留底（收到：${name}）`);
  }
  const dir = path.join(backupDirFor(projectFilePath), BASE_MAP_SRC_DIR);
  const full = path.join(dir, safe);
  if (path.dirname(path.resolve(full)) !== path.resolve(dir)) {
    throw new Error(`留底文件名不合法：${name}`);
  }
  const st = await fs.stat(full).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`留底文件不存在：${safe}`);
  const text = await fs.readFile(full, 'utf-8');
  return {
    success: true,
    name: safe,
    path: full,
    bytes: Buffer.byteLength(text, 'utf8'),
    mtime: st.mtime.toISOString(),
    text,
  };
}

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
      // ⚠️ 必须回显项目正文：渲染层 adopt() 的入参是「{filePath, project}」，
      // 只回路径会让「新建项目」解析到 undefined → validateProject 报「项目内容不是对象」→ 新建失败。
      // （该缺陷曾被 CDP 用例的假绿掩盖，由 Node 单测的通道级断言补上真实覆盖。）
      return ok({ ...res, project: payload.project || {} });
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
      // 数据安全：打开时留一份「会话基线」（覆盖式，1 份，不参与轮转）
      //   → 本次会话里无论自动保存刷了多少次，「打开时的样子」永远能取回。
      // ⚠️ 基线失败**不阻塞打开**，但也**不能静默**（2026-09-24 修）：用户会以为有回滚点，
      //    等 10 份轮转备份把它刷掉后就永久失去「打开时的样子」→ 必须把告警带回渲染层。
      let baseline = { backedUp: false };
      let baselineWarning = '';
      try {
        baseline = await makeSessionBaseline(target);
      } catch (e) {
        baselineWarning = `会话基线未能创建（${(e && e.message) || e}）：「打开时的样子」没有留底，本次会话不可回滚到打开时状态`;
        console.warn('[project] 会话基线创建失败:', e);
      }
      await setLastProjectPath(target);
      return ok({
        ...read,
        dir: path.dirname(target),
        baselinePath: baseline.baselinePath || null,
        baselineWarning: baselineWarning || null,
      });
    } catch (err) {
      return fail(err);
    }
  });

  // 保存项目（备份旧文件 → 原子覆盖；不解释内容）
  // 载荷两种形态：`projectJson`（渲染侧已序列化好的文本，**首选**，省掉这里第二次 stringify）
  // 与 `project`（对象，给旧调用方/测试留的兼容口）。
  ipcMain.handle('project-save', async (event, payload = {}) => {
    try {
      const target = payload.filePath || getLastProjectPath();
      if (!target) return { success: false, error: '项目尚未落盘（没有 filePath）' };
      if (typeof payload.projectJson === 'string') {
        const res = await writeProjectFile(target, payload.projectJson);
        await setLastProjectPath(target);
        return ok(res);
      }
      const res = await writeProjectFile(target, payload.project || {});
      await setLastProjectPath(target);
      return ok(res);
    } catch (err) {
      return fail(err);
    }
  });

  // 上次打开的项目路径（B4，2026-09-24）—— 供启动时自动恢复。
  // ⚠️ 只回报「文件确实还在」的路径：否则渲染层会为一个已删除/已移动的项目反复报错，
  //    而这条路径是**启动时**用的，报错会发生在用户还没做任何事的时候。
  ipcMain.handle('project-get-last-path', async () => {
    try {
      const last = getLastProjectPath();
      if (!last) return ok({ path: null });
      if (!(await fileExists(last))) return ok({ path: null, missing: last });
      return ok({ path: last });
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

  /**
   * 🔴 只读：主进程侧「当前项目路径」的**权威回答**（2026-10-11）。
   * 为什么要它：底图来源备份发生在 `ScenarioMap` 的导入流程里，而那个组件**不该**为了
   * 一个路径去 import projectStore（组件与 store 的接线越少越好，且 geodata 侧已有
   * 「只经 canvasBridge」的纪律）。主进程本来就通过 `setLastProjectPath` 记着这个值
   * （每次新建/打开都会写），所以直接问它即可 —— 也顺带避免了"渲染层记住了陈旧路径"。
   * 只读、不写盘、不改配置。
   */
  ipcMain.handle('project-current-path', async () => {
    try {
      const p = getLastProjectPath() || '';
      return ok({ filePath: p, exists: p ? await fileExists(p) : false });
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

  // 🔴 Git 快照（补注册，2026-10-11）：`gitSnapshot()` 一直存在且已导出、
  //    preload 也一直暴露着 `projectGitSnapshot`，但**这个通道从来没注册过** ——
  //    `ProjectPanel.vue` 的「司天快照」按钮在真机上必然抛
  //    `Error: No handler registered for 'project-git-snapshot'`（只在被点时才炸）。
  //    CDP 用例里 `window.sitianAPI` 是 mock，这条漏接在那层**永远看不见**；
  //    抓出它的是新加的「IPC 通道名双向对齐」单测（preload invoke ↔ 主进程 handle）。
  ipcMain.handle('project-git-snapshot', async (event, payload = {}) => {
    try {
      return ok(await gitSnapshot(payload));
    } catch (err) {
      return fail(err);
    }
  });

  // 🔴 原始底图来源备份（2026-10-11）：导入 `.map` 时把原文留一份（见 saveBaseMapSource 头注）
  ipcMain.handle('basemap-source-save', async (event, payload = {}) => {
    try {
      return ok(await saveBaseMapSource(payload.projectPath, payload));
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle('basemap-source-list', async (event, payload = {}) => {
    try {
      return ok(await listBaseMapSources(payload.projectPath));
    } catch (err) {
      return fail(err);
    }
  });
  // 只读：把一份留底读回渲染层（"从留底恢复"用）
  ipcMain.handle('basemap-source-read', async (event, payload = {}) => {
    try {
      return ok(await readBaseMapSource(payload.projectPath, payload.name));
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = {
  PROJECT_EXT,
  BACKUP_KEEP,
  BASELINE_TAG,
  BASE_MAP_SRC_DIR,
  BASE_MAP_SRC_KEEP,
  ILLEGAL_CHARS,
  sanitizeFileName,
  isProjectPath,
  backupDirFor,
  makeBackup,
  sessionBaselinePath,
  makeSessionBaseline,
  atomicWriteJson,
  writeProjectFile,
  readProjectFile,
  createProjectFile,
  listProjectFiles,
  isGitRepo,
  gitSnapshot,
  saveBaseMapSource,
  listBaseMapSources,
  readBaseMapSource,
  registerProjectHandlers,
};
