// src/main/config.js — 应用配置（VAULT_PATH 可配置化，2026-08-16）
const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;

const DEFAULT_VAULT = 'E:/图书馆/ROSA';

let vaultPath = DEFAULT_VAULT;

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
      vaultPath = cfg.vaultPath;
    }
  } catch (e) {
    // 无配置 → 使用默认路径（兼容旧版硬编码）
  }
  return vaultPath;
}

function getVaultPath() {
  return vaultPath;
}

/**
 * 保存新库路径（写入 userData/config.json）
 */
async function setVaultPath(newPath) {
  vaultPath = newPath;
  await fs.writeFile(getConfigPath(), JSON.stringify({ vaultPath }, null, 2), 'utf-8');
  return vaultPath;
}

module.exports = { loadConfig, getVaultPath, setVaultPath, DEFAULT_VAULT };
