const { autoUpdater } = require('electron-updater');
const { dialog, BrowserWindow } = require('electron');
const log = require('electron-log');

// 自动更新模块 — 封装 electron-updater 逻辑
// 仓库公开后，客户端可直接从 GitHub Release 拉取更新，无需 token

let mainWindow = null;
let isChecking = false;
let isDownloading = false;

function initUpdater(window) {
  mainWindow = window;

  // 日志级别
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false; // 手动确认后下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

  // 检查到新版本
  autoUpdater.on('update-available', (info) => {
    log.info(`发现新版本: ${info.version}`);
    isChecking = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
      });
    }
  });

  // 无新版本
  autoUpdater.on('update-not-available', (info) => {
    log.info('当前已是最新版本');
    isChecking = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:not-available', {
        version: info.version,
      });
    }
  });

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    log.info(`下载进度: ${progress.percent}%`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  // 下载完成
  autoUpdater.on('update-downloaded', (info) => {
    log.info('更新下载完成');
    isDownloading = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:downloaded', {
        version: info.version,
      });
    }
  });

  // 错误处理
  autoUpdater.on('error', (error) => {
    log.error('更新错误:', error.message);
    isChecking = false;
    isDownloading = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:error', {
        message: error.message,
      });
    }
  });
}

// 检查更新（手动触发）
function checkForUpdates() {
  if (isChecking || isDownloading) return;
  isChecking = true;
  return autoUpdater.checkForUpdates();
}

// 开始下载更新
function downloadUpdate() {
  if (isDownloading) return;
  isDownloading = true;
  return autoUpdater.downloadUpdate();
}

// 退出并安装
function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
};
