// src/main/config.js — 应用配置（VAULT_PATH 可配置化，2026-08-16）
const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;

const DEFAULT_VAULT = ''; // 留空：首次启动由用户通过设置面板指定知识库路径

// 窗口启动模式（批次A7）：maximized=默认最大化 | fullscreen=全屏 | default=1600×900
const WINDOW_MODES = ['maximized', 'fullscreen', 'default'];
const DEFAULT_WINDOW_MODE = 'maximized';

let config = { vaultPath: DEFAULT_VAULT, windowMode: DEFAULT_WINDOW_MODE };

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/**
 * 加载配置（app ready 后调用）
 */
async function loadConfig() {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.vaultPath && typeof cfg.vaultPath === 'string') {
      config.vaultPath = cfg.vaultPath;
    }
    if (WINDOW_MODES.includes(cfg.windowMode)) {
      config.windowMode = cfg.windowMode;
    }
  } catch (e) {
    // 无配置 → 使用默认值（兼容旧版硬编码）
  }
  return config.vaultPath;
}

async function writeConfig() {
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function getVaultPath() {
  return config.vaultPath;
}

/**
 * 保存新库路径（写入 userData/config.json，保留其他配置键）
 */
async function setVaultPath(newPath) {
  config.vaultPath = newPath;
  await writeConfig();
  return config.vaultPath;
}

function getWindowMode() {
  return config.windowMode;
}

async function setWindowMode(mode) {
  config.windowMode = WINDOW_MODES.includes(mode) ? mode : DEFAULT_WINDOW_MODE;
  await writeConfig();
  return config.windowMode;
}

module.exports = {
  loadConfig, getVaultPath, setVaultPath, DEFAULT_VAULT,
  getWindowMode, setWindowMode,
};
