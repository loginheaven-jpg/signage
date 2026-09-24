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
  onScreen2Media: (callback) => ipcRenderer.on('screen2-media', (e, data) => callback(data)),

  // 라이브 사진 (폰 촬영 → 즉시 송출). 편성표 위 오버레이 레이어로 표출된다.
  onLivePhoto: (callback) => ipcRenderer.on('live-photo', (e, data) => callback(data)),
  onLiveUpdate: (callback) => ipcRenderer.on('live-update', (e, data) => callback(data)),
  onLiveClear: (callback) => ipcRenderer.on('live-clear', () => callback()),
  onLiveReadyRequest: (callback) => ipcRenderer.on('live-ready-request', () => callback()),
  liveDelivery: (message) => ipcRenderer.send('live-delivery', message),
  // 듀얼 모니터에서 라이브가 2번 화면을 점유/해제했음을 주 창에 알림
  onLiveOccupy: (callback) => ipcRenderer.on('live-occupy', (e, data) => callback(data)),
  // 라이브 레이어가 끝났음을 메인 프로세스에 보고 (보조 창 → 주 창 점유 해제)
  liveEnded: () => ipcRenderer.send('live-ended'),
  // 멈춤 상태 보고 — 멈춘 화면에는 라이브 사진도 보내지 않는다
  setPlayerStopped: (v) => ipcRenderer.send('player-stopped', !!v),

  // 현재 재생 중 콘텐츠를 호스트 대시보드에 보고
  reportPlaying: (playing) => ipcRenderer.send('report-playing', playing),

  // 재생 제어 (일시정지/설정/종료)
  onTogglePause: (callback) => ipcRenderer.on('toggle-pause', () => callback()),
  uiTogglePause: () => ipcRenderer.send('ui-toggle-pause'),
  uiOpenSettings: () => ipcRenderer.send('ui-open-settings'),
  uiQuit: () => ipcRenderer.send('ui-quit')
});
