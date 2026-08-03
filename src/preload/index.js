const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitianAPI', {
  // 数据获取
  getGeodata: () => ipcRenderer.invoke('get-geodata'),
  reextractGeodata: () => ipcRenderer.invoke('reextract-geodata'),
  saveGeodata: (data) => ipcRenderer.invoke('save-geodata', data),
  getVaultPath: () => ipcRenderer.invoke('get-vault-path'),

  // Obsidian 笔记读取
  readObsidianNote: (sourcePath) => ipcRenderer.invoke('read-obsidian-note', sourcePath),

  // 在文件管理器中显示
  revealInExplorer: (fullPath) => ipcRenderer.invoke('reveal-in-explorer', fullPath),

  // 打开外部 URL（如 obsidian:// 协议）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Vault 监听
  getWatcherStatus: () => ipcRenderer.invoke('get-watcher-status'),
  setWatcherStatus: (enabled) => ipcRenderer.invoke('set-watcher-status', enabled),
  onNodeUpdated: (callback) => ipcRenderer.on('vault:node-updated', (event, data) => callback(data)),
  onNodeRemoved: (callback) => ipcRenderer.on('vault:node-removed', (event, data) => callback(data)),

  // 平台信息
  platform: process.platform,
});
