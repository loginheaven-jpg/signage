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
  onApproved: (callback) => ipcRenderer.on('approved', (e, data) => callback(data)),

  // 듀얼 모니터: 주 창(screen1)이 보조 창(screen2)에 표출할 미디어를 전달
  setScreen2Media: (media) => ipcRenderer.send('screen2-media', media),
  onScreen2Media: (callback) => ipcRenderer.on('screen2-media', (e, data) => callback(data))
});
