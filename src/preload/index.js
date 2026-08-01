const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('canjuguanAPI', {
  // 数据获取
  getGeodata: () => ipcRenderer.invoke('get-geodata'),
  reextractGeodata: () => ipcRenderer.invoke('reextract-geodata'),
  saveGeodata: (data) => ipcRenderer.invoke('save-geodata', data),
  getVaultPath: () => ipcRenderer.invoke('get-vault-path'),

  // 平台信息
  platform: process.platform,
});
