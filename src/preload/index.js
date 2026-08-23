const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sitianAPI', {
  // 数据获取
  getGeodata: () => ipcRenderer.invoke('get-geodata'),
  reextractGeodata: () => ipcRenderer.invoke('reextract-geodata'),
  saveGeodata: (data) => ipcRenderer.invoke('save-geodata', data),
  getVaultPath: () => ipcRenderer.invoke('get-vault-path'),
  // 库路径可配置（2026-08-16）：选择目录 / 手动设置
  selectVaultPath: () => ipcRenderer.invoke('select-vault-path'),
  setVaultPath: (newPath) => ipcRenderer.invoke('set-vault-path', newPath),
  // 窗口启动模式（批次A7）
  getWindowMode: () => ipcRenderer.invoke('get-window-mode'),
  setWindowMode: (mode) => ipcRenderer.invoke('set-window-mode', mode),

  // 地图数据
  getMapData: (planetId) => ipcRenderer.invoke('get-map-data', planetId),
  saveMapData: (planetId, data) => ipcRenderer.invoke('save-map-data', planetId, data),

  // 数据备份（P1-2）：.sitian/ → .sitian/backups/ 带时间戳
  backupSitianCache: () => ipcRenderer.invoke('backup-sitian-cache'),

  // 批量导入笔记（P2-1，纯创建式：只创建不修改）
  batchImportNotes: (payload) => ipcRenderer.invoke('batch-import-notes', payload),

  // 参考图底图（文件选择 + base64 读取）
  selectReferenceImage: () => ipcRenderer.invoke('select-reference-image'),

  // 导出文件（保存对话框 + 写入）
  saveExportFile: (options) => ipcRenderer.invoke('save-export-file', options),

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
  // 系统托盘菜单 → 渲染进程事件
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('sitian:open-settings', handler);
    return () => ipcRenderer.removeListener('sitian:open-settings', handler);
  },
  onOpenAbout: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('sitian:open-about', handler);
    return () => ipcRenderer.removeListener('sitian:open-about', handler);
  },

  // 清除坐标缓存
  clearCoordinateCache: () => ipcRenderer.invoke('clear-coordinate-cache'),

  // 平台信息
  platform: process.platform,

  // 应用版本
  version: process.env.npm_package_version || require('../../package.json').version,

  // 自动更新
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateCheckManual: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('update:check-manual', handler);
    return () => ipcRenderer.removeListener('update:check-manual', handler);
  },
  onUpdateAvailable: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateNotAvailable: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update:not-available', handler);
    return () => ipcRenderer.removeListener('update:not-available', handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },
  onUpdateError: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler);
  },
});
