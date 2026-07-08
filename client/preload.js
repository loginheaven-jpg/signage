/**
 * Preload 스크립트 — 렌더러 프로세스에 안전하게 IPC 노출
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signage', {
  onPlay: (callback) => ipcRenderer.on('play', (_, data) => callback(data)),
  onStop: (callback) => ipcRenderer.on('stop', () => callback()),
  onStandby: (callback) => ipcRenderer.on('show-standby', (_, data) => callback(data))
});
