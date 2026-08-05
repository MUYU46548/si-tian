const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitianAPI', {
  // 数据获取
  getGeodata: () => ipcRenderer.invoke('get-geodata'),
  reextractGeodata: () => ipcRenderer.invoke('reextract-geodata'),
  saveGeodata: (data) => ipcRenderer.invoke('save-geodata', data),
  getVaultPath: () => ipcRenderer.invoke('get-vault-path'),

  // 地图数据
  getMapData: (planetId) => ipcRenderer.invoke('get-map-data', planetId),
  saveMapData: (planetId, data) => ipcRenderer.invoke('save-map-data', planetId, data),

  // Obsidian 笔记读取
  readObsidianNote: (sourcePath) => ipcRenderer.invoke('read-obsidian-note', sourcePath),

  // 在文件管理器中显示
  revealInExplorer: (fullPath) => ipcRenderer.invoke('reveal-in-explorer', fullPath),

  // 打开外部 URL（如 obsidian:// 协议）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Vault 监听 — 返回清理函数，调用后移除监听器
  onNodeUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('vault:node-updated', handler);
    return () => ipcRenderer.removeListener('vault:node-updated', handler);
  },
  onNodeRemoved: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('vault:node-removed', handler);
    return () => ipcRenderer.removeListener('vault:node-removed', handler);
  },

  // 平台信息
  platform: process.platform,
});
