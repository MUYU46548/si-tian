const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { extractGeodata } = require('../../scripts/extract-data');

const VAULT_PATH = 'E:/图书馆/ROSA';
const CACHE_PATH = path.join(VAULT_PATH, '.sitian', 'geodata.json');

let mainWindow;

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

  // 开发环境加载 Vite dev server，生产环境加载构建产物
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
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
