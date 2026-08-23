// ─── ÇALIŞMA ANI DURUMU ──────────────────────────────────────────────────────
// main process modülleri arasında paylaşılan mutable durum. Modüller arası
// döngüsel require'ı önlemek için tek nesne üzerinde tutulur; her modül bu
// objeyi import edip alanları okur/yazar.

module.exports = {
  PORT: 0,
  flaskProcess: null,
  mainWindow: null,
  tray: null,
  isQuiting: false,
  lanRuntimeEnabled: false,
  resetSavedLanOnNextStart: true,
  isRestartingFlask: false,
  lanReconciliationTimer: null,
  lastLanRestartAttempt: 0,
  rendererLowPowerRequested: false,
  backendPageRecoveryAttempts: 0,
};
