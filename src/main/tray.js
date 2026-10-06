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

/**
 * 取当前托盘实例（可能为 null）。
 *
 * 🔴 为什么必须走这个 getter，而不是在 index.js 里直接写 `if (tray)`：
 *    `tray` 是**本模块的私有变量**，`index.js` 的 `require('./tray')` 只解构了
 *    `{ createTray, destroyTray, getIsQuitting, setIsQuitting }` —— 那边写 `tray`
 *    就是一个**未声明标识符**。实测：点 × 关窗时 `main/index.js:107` 的 `if (tray)`
 *    抛 `ReferenceError: tray is not defined`（主进程 uncaughtException，每次点 × 都抛），
 *    **「已最小化到托盘」的气泡提示永远不弹** —— 而托盘是用户唯一能把窗口找回来的入口，
 *    提示失灵 = 用户以为程序把自己关了。2026-10-06 由真机演练（`scripts/tests/drill_quit_flush.py`）抓到。
 */
function getTray() {
  return tray;
}

function getIsQuitting() {
  return isQuitting;
}

function setIsQuitting(value) {
  isQuitting = value;
}

module.exports = { createTray, destroyTray, getTray, getIsQuitting, setIsQuitting };