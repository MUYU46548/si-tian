// src/main/tray.js — 系统托盘（最小化到托盘 + 托盘菜单）
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let isQuitting = false;

function createTray(mainWindow) {
  if (tray) return tray;

  // 使用图标作为托盘图标。Windows 托盘推荐多分辨率 .ico（含 16/32/48/256），缩放更清晰；
  // 其他平台无 .ico 时用 32px png。resolve 路径在打包后指向 app.asar 内的 build/（需 files 含 build/**/*）。
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../../build/icon.ico')
    : path.join(__dirname, '../../build/icon-32.png');
  let icon = nativeImage.createFromPath(iconPath);
  // 兜底：.ico 缺失时用 32px png（极端环境防护）
  if (icon.isEmpty() && process.platform === 'win32') {
    icon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon-32.png'));
  }
  const trayIcon = icon;

  tray = new Tray(trayIcon);
  tray.setToolTip('SiTian — 世界观动态构建系统');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏',
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => {
        mainWindow.show();
        mainWindow.webContents.send('sitian:open-settings');
      },
    },
    {
      label: '关于',
      click: () => {
        mainWindow.show();
        mainWindow.webContents.send('sitian:open-about');
      },
    },
    { type: 'separator' },
    {
      label: '检查更新',
      click: () => {
        mainWindow.show();
        mainWindow.webContents.send('update:check-manual');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 双击托盘图标恢复窗口
  tray.on('double-click', () => {
    mainWindow.show();
  });

  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function getIsQuitting() {
  return isQuitting;
}

module.exports = { createTray, destroyTray, getIsQuitting };