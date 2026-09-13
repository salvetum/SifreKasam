/**
 * ŞifreKasam v2.7.0-beta.3 - Canlı tarama oturumu modülü (ES Module)
 *
 * Canlı sızıntı taramasını sayfalar arası tutarlı kılar: oturum durumu
 * sessionStorage'da yaşar; hangi sayfada olunursa olunsun üst yükleme
 * çubuğu (KASA_PROGRESS) tarama ilerlemesiyle güncellenir ve sayfa
 * değiştirilip geri dönüldüğünde tarama durumu korunur.
 *
 * Event'ler:
 *   kasa:scan-update   - detail: {done, total, breached, backgrounded}
 *   kasa:scan-finished - detail: {outcome: 'ok'|'cancelled'|'error', message?}
 *
 * initScanSession, app.js içindeki DOMContentLoaded sırasında
 * initNotifications'tan hemen sonra çağrılır.
 */

const SESSION_KEY = 'kasa-scan-session';
const POLL_INTERVAL_MS = 2000;

export function initScanSession({ apiFetch }) {

  const readSession = () => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      const state = raw ? JSON.parse(raw) : null;
      return state && state.active ? state : null;
    } catch (err) {
      return null;
    }
  };

  const writeSession = (state) => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch (err) { /* yoksay */ }
  };

  const clearSession = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* yoksay */ }
  };

  let pollTimer = null;

  const stopPolling = () => {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  };

  const emit = (name, detail) => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  };

  const setBar = (done, total) => {
    if (!window.KASA_PROGRESS) return;
    if (total > 0) {
      window.KASA_PROGRESS.set(Math.round((done / total) * 100));
    } else {
      window.KASA_PROGRESS.start();
    }
  };

  const poll = () => {
    apiFetch('/api/breach/scan')
      .then(res => (res && res.ok) ? res.json() : null)
      .then(data => {
        if (!data) return;
        if (data.running) {
          const session = readSession();
          if (!session) return;
          writeSession({
            ...session,
            done: data.done || 0,
            total: data.total || 0,
            breached: data.breached || 0,
          });
          setBar(data.done || 0, data.total || 0);
          emit('kasa:scan-update', {
            done: data.done || 0,
            total: data.total || 0,
            breached: data.breached || 0,
            backgrounded: session.backgrounded,
          });
          return;
        }
        stopPolling();
        clearSession();
        if (window.KASA_PROGRESS) window.KASA_PROGRESS.done();
        const outcome = data.error ? 'error' : data.cancelled ? 'cancelled' : 'ok';
        emit('kasa:scan-finished', {
          outcome,
          message: data.error ? data.error : undefined,
        });
      })
      .catch(() => {
        // Ağ geçişi sırasında sessizce devam et; bir sonraki turda dene.
      });
  };

  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    poll();
  };

  // ─── KÜRESEL API ───────────────────────────────────────────────────────────
  window.KASA_SCAN = {
    start({ backgrounded, total }) {
      writeSession({ active: true, backgrounded: !!backgrounded, done: 0, total: total || 0, breached: 0 });
      if (window.KASA_PROGRESS) window.KASA_PROGRESS.start();
      startPolling();
    },
    snapshot() {
      return readSession();
    },
    isActive() {
      return !!readSession();
    },
    clear() {
      stopPolling();
      clearSession();
      if (window.KASA_PROGRESS) window.KASA_PROGRESS.done();
    },
  };

  // ─── HER SAYFADA OTURUM GERİ YÜKLEME ────────────────────────────────────────
  const restore = () => {
    const session = readSession();
    if (!session) return;
    if (window.KASA_PROGRESS) window.KASA_PROGRESS.start();
    setBar(session.done, session.total);
    startPolling();
  };

  restore();
  window.addEventListener('pageshow', () => { if (readSession()) restore(); });
}