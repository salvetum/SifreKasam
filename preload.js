// ─── PRELOAD ────────────────────────────────────────────────────────────────
// contextIsolation aktif; renderer'a yalnızca sınırlı IPC köprüsü açılır.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kasaIpc', {
  onSecondInstance: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('kasa:second-instance', () => callback());
  },
  // LAN ayari kaydedildiğinde Electron'un anında mutabakat yapması için
  // (5-20 sn'lik poll döngüsünü beklemeden restart tetiklenir).
  notifyLanSaved: () => {
    ipcRenderer.send('kasa:lan-saved');
  },
});
