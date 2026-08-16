const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const matter = require('gray-matter');
const { extractGeodata } = require('../../scripts/extract-data');
const { startWatcher, stopWatcher } = require('./vault-watcher');
const { loadConfig, getVaultPath, setVaultPath, DEFAULT_VAULT } = require('./config');

let mainWindow;
let vaultWatcherEnabled = true;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'SiTian — 世界观动态构建系统',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5180');
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 启动 Vault 文件监听
  if (vaultWatcherEnabled) {
    startWatcher(mainWindow);
  }
}

app.whenReady().then(async () => {
  await loadConfig();
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

// IPC: 获取 Vault 路径
ipcMain.handle('get-vault-path', () => getVaultPath());

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

// IPC: 获取 Vault 监听状态
ipcMain.handle('get-watcher-status', () => vaultWatcherEnabled);

// IPC: 切换 Vault 监听
ipcMain.handle('set-watcher-status', (event, enabled) => {
  vaultWatcherEnabled = enabled;
  if (enabled) {
    startWatcher(mainWindow);
  } else {
    stopWatcher();
  }
  return { success: true };
});

// IPC: 获取地图数据
ipcMain.handle('get-map-data', async (event, planetId) => {
  try {
    const MAP_PATH = path.join(getVaultPath(), '.sitian', 'mapdata.json');
    const raw = await fs.readFile(MAP_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return { success: true, data: data[planetId] || null };
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
