const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const matter = require('gray-matter');
const { extractGeodata } = require('../../scripts/extract-data');
const { startWatcher, stopWatcher } = require('./vault-watcher');

const VAULT_PATH = 'E:/图书馆/ROSA';
const CACHE_PATH = path.join(VAULT_PATH, '.sitian', 'geodata.json');

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

app.whenReady().then(() => {
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
    const raw = await fs.readFile(CACHE_PATH, 'utf-8');
    return { success: true, data: JSON.parse(raw) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 保存坐标数据（仅 JSON）
ipcMain.handle('save-geodata', async (event, data) => {
  try {
    await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 从 Markdown 重新提取
ipcMain.handle('reextract-geodata', async () => {
  try {
    const data = await extractGeodata(VAULT_PATH);
    await fs.writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC: 获取 Vault 路径
ipcMain.handle('get-vault-path', () => VAULT_PATH);

// IPC: 读取 Obsidian 笔记内容
ipcMain.handle('read-obsidian-note', async (event, sourcePath) => {
  try {
    const fullPath = path.join(VAULT_PATH, sourcePath);
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
