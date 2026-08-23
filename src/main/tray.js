// src/main/tray.js — 系统托盘（最小化到托盘 + 托盘菜单）
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let isQuitting = false;

function createTray(mainWindow) {
  if (tray) return tray;

  // 使用 16px 图标作为托盘图标（Windows 任务栏托盘标准尺寸）
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '../../build/icon-16.png')
    : path.join(__dirname, '../../build/icon-32.png');
  const icon = nativeImage.createFromPath(iconPath);

  // Windows 需要缩小图标以适配托盘
  const trayIcon = process.platform === 'win32'
    ? icon.resize({ width: 16, height: 16 })
    : icon;

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