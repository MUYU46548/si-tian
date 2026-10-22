const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// 版本号：读取打包进 asar 的 package.json。preload 位于 app.asar/src/preload，
// 上溯 2 级即 app.asar/package.json（electron-builder 构建时写入真实版本号）。
// ⚠️ 曾写 '../../../'（按旧 dist/electron 结构算的 3 级），打包后落到 resources/，
// require 必抛 → 静默回退硬编码 '0.1.3' → 版本升了面板仍显示 0.1.3（2026-09-08 用户实测）。
// 回退：npm_package_version（electron-builder 打包时不注入，仅 dev 生效）→ 中性常量。
// 仍禁止 require('electron').app.getVersion()（contextIsolation preload 中 app 为 undefined，必抛）。
const APP_VERSION = (function () {
  try {
    const pj = require(path.join(__dirname, '../../package.json'));
    if (pj && pj.version) return pj.version;
  } catch (e) { /* 忽略：极端环境防护 */ }
  return process.env.npm_package_version || '0.1.4';
})();

contextBridge.exposeInMainWorld('sitianAPI', {
  // 数据获取
  getGeodata: () => ipcRenderer.invoke('get-geodata'),
  reextractGeodata: () => ipcRenderer.invoke('reextract-geodata'),
  saveGeodata: (data) => ipcRenderer.invoke('save-geodata', data),
  getVaultPath: () => ipcRenderer.invoke('get-vault-path'),
  // 🔴 知识库监听开关（2026-10-14 补暴露）：这两个 channel 在 `main/index.js:710/713`
  //    **注册了很久但 preload 从来没暴露过** → 设置面板里那个「监听 Obsidian 文件变更
  //    自动刷新」勾选框只写进 localStorage，主进程的 `vaultWatcherEnabled` 是硬编码 true，
  //    于是**关了也照跑**（假开关），重启后勾选态也不还原。
  //    与 projectHandler / gitSyncHandler 的暴露方式保持一致（invoke + 返回结构化结果）。
  getWatcherStatus: () => ipcRenderer.invoke('get-watcher-status'),
  setWatcherStatus: (enabled) => ipcRenderer.invoke('set-watcher-status', !!enabled),
  // 库路径可配置（2026-08-16）：选择目录 / 手动设置
  selectVaultPath: () => ipcRenderer.invoke('select-vault-path'),
  setVaultPath: (newPath) => ipcRenderer.invoke('set-vault-path', newPath),
  // 窗口启动模式（批次A7）
  getWindowMode: () => ipcRenderer.invoke('get-window-mode'),
  setWindowMode: (mode) => ipcRenderer.invoke('set-window-mode', mode),

  // 关闭行为（批次A12）：点 × 直接退出应用（默认 false = 最小化到托盘）
  getCloseQuitsApp: () => ipcRenderer.invoke('get-close-quits-app'),
  setCloseQuitsApp: (v) => ipcRenderer.invoke('set-close-quits-app', v),

  // 退出前落盘（数据安全）：主进程在真正 quit 前发 'app-flush-before-quit'，
  // 渲染层写完未落盘的改动后回 'app-flush-done'（主进程另有 2.5s 超时兜底）。
  onFlushBeforeQuit: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, reason) => cb(reason);
    ipcRenderer.on('app-flush-before-quit', h);
    return () => ipcRenderer.removeListener('app-flush-before-quit', h);
  },
  // payload.failed 非空 = 有改动未能落盘 → 主进程会弹原生对话框告知（渲染层控制台用户看不到）
  notifyFlushDone: (payload) => ipcRenderer.send('app-flush-done', payload || { failed: [] }),

  // Ctrl+Q 退出确认（2026-10-09）：主进程收到 Ctrl+Q 后不再直接退，改发 'app-request-quit'
  // 让渲染层判断「有没有未保存的改动」并弹确认框；用户选「退出司天」后才调 confirmQuit()。
  onRequestQuit: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, reason) => cb(reason);
    ipcRenderer.on('app-request-quit', h);
    return () => ipcRenderer.removeListener('app-request-quit', h);
  },
  confirmQuit: () => ipcRenderer.send('app-confirm-quit'),

  // 当前激活的底图键（P0 持久化）
  getCurrentBaseMapKey: () => ipcRenderer.invoke('get-current-basemap-key'),
  setCurrentBaseMapKey: (key) => ipcRenderer.invoke('set-current-basemap-key', key),

  // .sitian/config/*.json 通用读写（P0-2 标签样式预设 / P1-4 标记类型）
  getSitianConfig: (name) => ipcRenderer.invoke('get-sitian-config', name),
  setSitianConfig: (name, data) => ipcRenderer.invoke('set-sitian-config', name, data),

  // 地图数据
  getMapData: (planetId) => ipcRenderer.invoke('get-map-data', planetId),
  saveMapData: (planetId, data) => ipcRenderer.invoke('save-map-data', planetId, data),

  // 数据备份（P1-2）：.sitian/ → .sitian/backups/ 带时间戳
  backupSitianCache: () => ipcRenderer.invoke('backup-sitian-cache'),

  // 批量导入笔记（P2-1，纯创建式：只创建不修改）
  batchImportNotes: (payload) => ipcRenderer.invoke('batch-import-notes', payload),

  // 参考图底图（文件选择 + base64 读取）
  selectReferenceImage: () => ipcRenderer.invoke('select-reference-image'),

  // ===== 剧本地图（S0）=====
  saveScenarios: (data) => ipcRenderer.invoke('save-scenarios', data),
  loadScenarios: () => ipcRenderer.invoke('load-scenarios'),

  // ===== 一键同步到远程仓库（git）=====
  // 「傻瓜式」：状态 / 存地址 / 存令牌 / 测连接 / 立即同步 / 从远程恢复 —— 渲染层看不到任何 git 细节（逻辑在主进程）
  gitSyncStatus: (dir) => ipcRenderer.invoke('git-sync-status', dir),
  gitSyncConfigure: (payload) => ipcRenderer.invoke('git-sync-configure', payload),
  gitSyncCredential: (payload) => ipcRenderer.invoke('git-sync-credential', payload),
  gitSyncForget: (payload) => ipcRenderer.invoke('git-sync-forget', payload),
  gitSyncTest: (payload) => ipcRenderer.invoke('git-sync-test', payload),
  gitSyncNow: (payload) => ipcRenderer.invoke('git-sync-now', payload),
  gitSyncPull: (payload) => ipcRenderer.invoke('git-sync-pull', payload),

  // ===== .sitian 项目文件（Phase 1：独立运行基础）=====
  // 文件格式/校验/快照见 renderer 的 utils/projectSchema.js；主进程只管路径与落盘。
  projectCreate: (payload) => ipcRenderer.invoke('project-create', payload),
  projectOpen: (filePath) => ipcRenderer.invoke('project-open', filePath),
  projectSave: (payload) => ipcRenderer.invoke('project-save', payload),
  projectList: (dir) => ipcRenderer.invoke('project-list', dir),
  /** 上次打开的项目路径（B4）：启动时自动恢复用；文件已不存在时返回 { path: null, missing } */
  projectGetLastPath: () => ipcRenderer.invoke('project-get-last-path'),
  projectPickDir: () => ipcRenderer.invoke('project-pick-dir'),
  projectReveal: (filePath) => ipcRenderer.invoke('project-reveal', filePath),
  projectBackupNow: (filePath) => ipcRenderer.invoke('project-backup-now', filePath),
  projectGitSnapshot: (payload) => ipcRenderer.invoke('project-git-snapshot', payload),
  // 🔴 原始底图来源备份（2026-10-11）：导入 `.map` 时把**原文**留一份到
  //    `<项目>.sitian.backups/basemap-sources/`（原子写 + 轮转 10 份）。
  //    为什么需要：司天此前只备份自己的项目文件，**从不留用户导入的 `.map`** ——
  //    而那份文件是"地形/河流/道路能否重新导入"的唯一凭据（真实丢过一轮，见 handler 头注）。
  saveBaseMapSource: (payload) => ipcRenderer.invoke('basemap-source-save', payload),
  listBaseMapSources: (payload) => ipcRenderer.invoke('basemap-source-list', payload),
  // 只读：把一份留底**读回来**（2026-10-13「从留底恢复」）。
  // 为什么补：留底只有"列清单"没有"读回来"时，UI 上等于不存在 —— 备份读不回来就不算备份。
  readBaseMapSource: (payload) => ipcRenderer.invoke('basemap-source-read', payload),
  /** 只读：主进程侧「当前项目路径」（权威）—— 组件不必为拿路径去引 projectStore */
  projectCurrentPath: () => ipcRenderer.invoke('project-current-path'),

  // 导出文件（保存对话框 + 写入）
  saveExportFile: (options) => ipcRenderer.invoke('save-export-file', options),
  saveTextFile: (options) => ipcRenderer.invoke('save-text-file', options),
  // 逐年切片：一次选目录 + 批量写 N 帧 + frames.json（主进程侧见 handlers/exportFramesHandler.js）
  exportScenarioFrames: (options) => ipcRenderer.invoke('export-scenario-frames', options),

  // 创建 Obsidian 笔记（从 draft 节点创建）
  createObsidianNote: (payload) => ipcRenderer.invoke('create-obsidian-note', payload),

  // 读取 Obsidian 笔记内容
  readObsidianNote: (sourcePath) => ipcRenderer.invoke('read-obsidian-note', sourcePath),

  // 列出知识库笔记清单（只读）：项目态下知识库事件被拦，笔记改名要靠它做断线检测对账
  listVaultNotes: () => ipcRenderer.invoke('list-vault-notes'),

  // ===== 全库只读索引（D1，2026-10-19）=====
  // 与 listVaultNotes 的分工：那个只列“扫描范围内的地图笔记”；这里索引全库 .md。
  vaultIndexBuild: (opts) => ipcRenderer.invoke('vault-index-build', opts || {}),
  vaultIndexStatus: () => ipcRenderer.invoke('vault-index-status'),
  vaultIndexSearch: (query, limit) => ipcRenderer.invoke('vault-index-search', query, limit),
  vaultEntityCandidates: (rules) => ipcRenderer.invoke('vault-entity-candidates', rules || {}),
  vaultClassifyReport: () => ipcRenderer.invoke('vault-classify-report'),
  vaultNoteRead: (relPath) => ipcRenderer.invoke('vault-note-read', relPath),
  vaultNoteResolve: (name) => ipcRenderer.invoke('vault-note-resolve', name),
  vaultNoteSearch: (query, limit) => ipcRenderer.invoke('vault-note-search', query, limit),
  vaultAssetRead: (relPath, fromNote) => ipcRenderer.invoke('vault-asset-read', relPath, fromNote),
  // 全库索引变更（主进程 watcher → 250ms 防抖 → 增量重建）。返回取消订阅函数。
  onVaultIndexUpdated: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, summary) => cb(summary);
    ipcRenderer.on('vault-index-updated', h);
    return () => ipcRenderer.removeListener('vault-index-updated', h);
  },

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

  // P0.4: 渲染进程错误上报（主进程 electron-log 落盘）
  reportError: (payload) => ipcRenderer.invoke('report-error', payload),

  // 平台信息
  platform: process.platform,

  // 应用版本
  version: APP_VERSION,

  // 应用内卸载入口（批次A11）
  uninstallApp: () => ipcRenderer.invoke('uninstall-app'),

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
