const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signage', {
  // 설정
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // 이벤트 수신
  onConnectionStatus: (callback) => ipcRenderer.on('connection-status', (e, data) => callback(data)),
  onScheduleUpdate: (callback) => ipcRenderer.on('schedule-update', (e, data) => callback(data)),
  onPlayCommand: (callback) => ipcRenderer.on('play-command', (e, data) => callback(data)),
  onStopCommand: (callback) => ipcRenderer.on('stop-command', (e) => callback()),
  onApproved: (callback) => ipcRenderer.on('approved', (e, data) => callback(data))
});
