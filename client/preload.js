/**
 * Preload 스크립트 — 렌더러 프로세스에 안전하게 IPC 노출
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('signage', {
  // 편성표 업데이트 수신 (자동 재생 모드)
  onUpdatePlaylist: (callback) => ipcRenderer.on('update-playlist', (_, data) => callback(data)),

  // 호스트 연결 상태 수신
  onHostStatus: (callback) => ipcRenderer.on('host-status', (_, data) => callback(data)),

  // 호스트 직접 재생 명령 수신 (수동 제어)
  onPlay: (callback) => ipcRenderer.on('play', (_, data) => callback(data)),

  // 정지 명령 수신
  onStop: (callback) => ipcRenderer.on('stop', () => callback()),

  // 대기 화면 표시 명령 수신
  onStandby: (callback) => ipcRenderer.on('show-standby', (_, data) => callback(data))
});
