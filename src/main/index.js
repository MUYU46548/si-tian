const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const matter = require('gray-matter');
const { extractGeodata } = require('../../scripts/extract-data');
const { startWatcher, stopWatcher } = require('./vault-watcher');
const { loadConfig, getVaultPath, setVaultPath, getWindowMode, setWindowMode } = require('./config');
const { createTray, destroyTray, getIsQuitting } = require('./tray');

let mainWindow;
let vaultWatcherEnabled = true;

// 按配置应用窗口模式（批次A7：默认最大化启动，设置面板可改；三种模式间切换均可还原）
function applyWindowMode(win, mode) {
  if (mode === 'fullscreen') {
    win.setFullScreen(true);
    return;
  }
  if (win.isFullScreen()) win.setFullScreen(false);
  if (mode === 'maximized') {
    win.maximize();
  } else if (win.isMaximized()) {
    win.unmaximize();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'SiTian — 世界观动态构建系统',
    backgroundColor: '#0a0e18',
    // 窗口/任务栏图标（问题2）：打包后 exe 资源由 electron-builder 注入，
    // 开发与未打包运行时由此处提供；macOS 窗口图标由系统取 app bundle，无需设置
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../../build/icon.ico')
      : path.join(__dirname, '../../build/icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  applyWindowMode(mainWindow, getWindowMode());

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5180');
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 启动 Vault 文件监听（若已配置知识库路径）
  if (vaultWatcherEnabled) {
    startWatcher(mainWindow, getVaultPath());
  }

  // 窗口关闭拦截：用户点 × 时最小化到托盘，而非退出
  // 退出只能通过托盘菜单「退出」或 Alt+F4（应用退出时 getIsQuitting() === true）
  mainWindow.on('close', (event) => {
    if (!getIsQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 创建系统托盘
  createTray(mainWindow);
}

// 单实例锁：防止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.whenReady().then(async () => {
  await loadConfig();
  // 启动时静默备份 .sitian/ 缓存（P1-2 数据安全；失败不影响启动）
  backupSitianCache();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopWatcher();
  destroyTray();
});

// IPC: 获取地理数据
ipcMain.handle('get-geodata', async () => {
  try {
    const raw = await fs.readFile(path.join(getVaultPath(), '.sitian', 'geodata.json'), 'utf-8');
    return { success: true, data: JSON.parse(raw) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 保存坐标数据（仅 JSON）
ipcMain.handle('save-geodata', async (event, data) => {
  try {
    await fs.writeFile(path.join(getVaultPath(), '.sitian', 'geodata.json'), JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 从 Markdown 重新提取
ipcMain.handle('reextract-geodata', async () => {
  try {
    const data = await extractGeodata(getVaultPath());
    await fs.writeFile(path.join(getVaultPath(), '.sitian', 'geodata.json'), JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== 数据备份（P1-2）：.sitian/ → .sitian/backups/ 带时间戳，保留最近 10 批 =====
const BACKUP_KEEP = 10;

async function backupSitianCache() {
  try {
    const sitianDir = path.join(getVaultPath(), '.sitian');
    const backupDir = path.join(sitianDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const copied = [];
    for (const name of ['geodata.json', 'mapdata.json']) {
      const src = path.join(sitianDir, name);
      try {
        await fs.access(src);
      } catch (e) {
        continue; // 文件不存在（如 mapdata 尚未生成）跳过
      }
      const dest = path.join(backupDir, `${name.replace('.json', '')}-${ts}.json`);
      await fs.copyFile(src, dest);
      copied.push(path.basename(dest));
    }
    // 清理旧备份：同一时间戳的 geodata/mapdata 算一批，只保留最近 BACKUP_KEEP 批
    const all = (await fs.readdir(backupDir)).filter(f => f.endsWith('.json'));
    const batches = [...new Set(all.map(f => f.replace(/^(geodata|mapdata)-/, '')))].sort();
    const removeBatches = new Set(batches.slice(0, Math.max(0, batches.length - BACKUP_KEEP)));
    for (const f of all) {
      if (removeBatches.has(f.replace(/^(geodata|mapdata)-/, ''))) {
        await fs.unlink(path.join(backupDir, f)).catch(() => {});
      }
    }
    return { success: true, backupDir, count: copied.length, files: copied };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('backup-sitian-cache', async () => backupSitianCache());

// IPC: 获取 Vault 路径
ipcMain.handle('get-vault-path', () => getVaultPath());

// IPC: 窗口启动模式（批次A7）：读取 / 设置（立即生效并持久化）
ipcMain.handle('get-window-mode', () => getWindowMode());
ipcMain.handle('set-window-mode', async (event, mode) => {
  const applied = await setWindowMode(mode);
  if (mainWindow && !mainWindow.isDestroyed()) {
    applyWindowMode(mainWindow, applied);
  }
  return { success: true, mode: applied };
});

// IPC: 选择 Vault 库目录（首次引导/设置面板），校验 .obsidian 后保存并重新提取（2026-08-16）
ipcMain.handle('select-vault-path', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Obsidian 知识库目录（应包含 .obsidian 文件夹）',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const selected = result.filePaths[0];
    const validation = await validateVaultPath(selected);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    await setVaultPath(selected);
    return { success: true, path: selected };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 直接设置 Vault 路径（设置面板手动输入）
ipcMain.handle('set-vault-path', async (event, newPath) => {
  try {
    if (!newPath || typeof newPath !== 'string') {
      return { success: false, error: '路径无效' };
    }
    const validation = await validateVaultPath(newPath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    await setVaultPath(newPath);
    return { success: true, path: newPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 校验目录是否为 Obsidian 库（存在 .obsidian 目录）
async function validateVaultPath(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) return { valid: false, error: '选择的不是文件夹' };
    const obsidianDir = path.join(dirPath, '.obsidian');
    await fs.access(obsidianDir);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: '目录下未找到 .obsidian 文件夹，请选择 Obsidian 知识库根目录' };
  }
}

// IPC: 读取 Obsidian 笔记内容
ipcMain.handle('read-obsidian-note', async (event, sourcePath) => {
  try {
    const fullPath = path.join(getVaultPath(), sourcePath);
    const raw = await fs.readFile(fullPath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    
    const wikilinks = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      wikilinks.push(match[1].trim());
    }
    
    return { success: true, data: { frontmatter, content, wikilinks } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 在文件管理器中显示
ipcMain.handle('reveal-in-explorer', async (event, fullPath) => {
  try {
    shell.showItemInFolder(fullPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 打开外部 URL（如 obsidian:// 协议）
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== 批量导入笔记（P2-1，纯创建式：只创建不修改）=====
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;
const LAYER_IMPORT_DIRS = {
  star_domain: ['03 设定', '11 地理系统', '星域'],
  galaxy: ['03 设定', '11 地理系统', '星系'],
  planet: ['03 设定', '11 地理系统', '行星'],
};
const LAYER_IMPORT_CN = { star_domain: '星域', galaxy: '星系', planet: '行星', city: '城市', town: '城镇', village: '村庄', facility: '设施', location: '地点', region: '区域' };

function sanitizeFileName(name) {
  return path.basename(String(name || '').trim()).replace(ILLEGAL_CHARS, '_');
}

ipcMain.handle('batch-import-notes', async (event, payload) => {
  const { worldName = '', layer = 'location', names = [], parentName = '' } = payload || {};
  const vault = getVaultPath();
  const created = [];
  const skipped = [];
  const errors = [];
  try {
    // 目标目录：地理类 → 11 地理系统/<层级>；地点类 → 02 场景地点/<世界>/<父节点?>
    let targetDir;
    if (LAYER_IMPORT_DIRS[layer]) {
      targetDir = path.join(vault, ...LAYER_IMPORT_DIRS[layer]);
    } else {
      const worldDir = sanitizeFileName(worldName) || '未分类';
      targetDir = path.join(vault, '03 设定', '02 场景地点', worldDir);
      if (parentName) targetDir = path.join(targetDir, sanitizeFileName(parentName));
    }
    await fs.mkdir(targetDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    for (const rawName of names) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      const safeName = sanitizeFileName(name);
      if (!safeName) {
        errors.push({ name, reason: '文件名非法' });
        continue;
      }
      const filePath = path.join(targetDir, safeName + '.md');
      // 红线：只创建不修改 —— 已存在即跳过，绝不覆盖
      try {
        await fs.access(filePath);
        skipped.push({ name, reason: '已存在' });
        continue;
      } catch (e) { /* 不存在 → 创建 */ }
      const lines = [
        '---',
        'publish: true',
        'tags:',
        `- ${name}`,
        '- 场景地点',
        parentName ? `上层区域: '[[${parentName}]]'` : null,
        `创建日期: ${today}`,
        `层级: ${LAYER_IMPORT_CN[layer] || layer}`,
        '---',
        '',
        `# ${name}`,
        '',
      ].filter(l => l !== null);
      try {
        const nl = '\n';
        await fs.writeFile(filePath, lines.join(nl) + nl, 'utf-8');
        created.push({ name, path: filePath });
      } catch (e) {
        errors.push({ name, reason: e.message });
      }
    }
    return { success: true, targetDir, created, skipped, errors };
  } catch (err) {
    return { success: false, error: err.message, created, skipped, errors };
  }
});

// IPC: 获取 Vault 监听状态
ipcMain.handle('get-watcher-status', () => vaultWatcherEnabled);

// IPC: 切换 Vault 监听
ipcMain.handle('set-watcher-status', (event, enabled) => {
  vaultWatcherEnabled = enabled;
  if (enabled) {
    startWatcher(mainWindow, getVaultPath());
  } else {
    stopWatcher();
  }
  return { success: true };
});

// IPC: 获取地图数据（key 支持 worldId/planetId 与旧版纯 planetId）
ipcMain.handle('get-map-data', async (event, planetId) => {
  try {
    const MAP_PATH = path.join(getVaultPath(), '.sitian', 'mapdata.json');
    const raw = await fs.readFile(MAP_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // 兼容旧版：新 key（含 / 前缀）读不到时回退纯 planetId
    const legacyKey = String(planetId).split('/').pop();
    return { success: true, data: data[planetId] ?? data[legacyKey] ?? null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 保存地图数据
ipcMain.handle('save-map-data', async (event, planetId, mapData) => {
  try {
    const MAP_PATH = path.join(getVaultPath(), '.sitian', 'mapdata.json');
    let allData = {};
    try {
      const raw = await fs.readFile(MAP_PATH, 'utf-8');
      allData = JSON.parse(raw);
    } catch (e) {
      // File doesn't exist yet
    }
    allData[planetId] = mapData;
    await fs.writeFile(MAP_PATH, JSON.stringify(allData, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 清除坐标缓存
ipcMain.handle('clear-coordinate-cache', async () => {
  try {
    const GEODATA_CACHE = path.join(getVaultPath(), '.sitian', 'geodata.json');
    const MAP_CACHE = path.join(getVaultPath(), '.sitian', 'mapdata.json');
    
    // 删除坐标缓存
    try {
      await fs.unlink(GEODATA_CACHE);
    } catch (e) {
      // 文件不存在则忽略
    }
    
    // 删除地图缓存
    try {
      await fs.unlink(MAP_CACHE);
    } catch (e) {
      // 文件不存在则忽略
    }
    
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 选择参考图并读取为 base64 dataURL
ipcMain.handle('select-reference-image', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择参考底图（手绘草图 / 大陆轮廓）',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png';
    const mimeMap = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
    };
    const mime = mimeMap[ext] || 'image/png';
    
    // 限制大小（10MB），避免 base64 撑爆 mapdata.json
    const stat = await fs.stat(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      return { success: false, error: '图片超过 10MB 限制，请压缩后再导入' };
    }
    
    const buffer = await fs.readFile(filePath);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return { success: true, dataUrl, fileName: path.basename(filePath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 弹出保存对话框并写入 PNG 文件（导出）
ipcMain.handle('save-export-file', async (event, { dataUrl, defaultName }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出图片',
      defaultPath: path.join(app.getPath('pictures'), defaultName || 'sitian-export.png'),
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(result.filePath, buffer);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 单实例锁：第二个实例尝试启动时，聚焦现有窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
