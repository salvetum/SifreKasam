// ─── PRELOAD ────────────────────────────────────────────────────────────────
// contextIsolation aktif; renderer'a yalnızca sınırlı IPC köprüsü açılır.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kasaIpc', {
  onSecondInstance: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('kasa:second-instance', () => callback());
  },
});
