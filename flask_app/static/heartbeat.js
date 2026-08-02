/**
 * ŞifreKasam v2.6.3-beta.2 - Heartbeat / Tasarruf Modu modülü (ES Module)
 *
 * 1. bölüm: heartbeat gönderimi, düşük güç modu ve
 * renderer repaint yönetimi.
 * initHeartbeat, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

export function initHeartbeat({ apiFetch }) {

  const HEARTBEAT_ACTIVE_INTERVAL_MS = 15000;
  const HEARTBEAT_LOW_POWER_INTERVAL_MS = 60000;
  const RENDERER_IDLE_LOW_POWER_MS = 45000;
  const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'];
  let rendererLowPower = null;
  let systemLowPower = document.hidden;
  let idleLowPower = false;
  let heartbeatTimer = null;
  let idleLowPowerTimer = null;
  let rendererResumeTimer = null;
  const powerSaveOverlay = document.querySelector('.power-save-overlay');
  const powerSaveTitle = powerSaveOverlay?.querySelector('[data-power-save-title]');
  const powerSaveSubtitle = powerSaveOverlay?.querySelector('[data-power-save-subtitle]');
  const pageShell = document.getElementById('kasa-page-shell');

  const setPowerSaveOverlay = (active, restoring = false) => {
    if (!powerSaveOverlay) return;
    if (powerSaveTitle) {
      powerSaveTitle.textContent = restoring
        ? window._('Tasarruf modundan çıkılıyor')
        : window._('Tasarruf modu');
    }
    if (powerSaveSubtitle) {
      powerSaveSubtitle.textContent = restoring
        ? window._('Kartlar ve arayüz yeniden hazırlanıyor.')
        : window._('ŞifreKasam arka planda kaynak kullanımını azaltıyor.');
    }
    powerSaveOverlay.classList.toggle('is-active', active);
    powerSaveOverlay.classList.toggle('is-restoring', active && restoring);
    powerSaveOverlay.setAttribute('aria-hidden', String(!active));
  };

  const forceRendererRepaint = () => {
    if (!pageShell) return;
    const repaintTargets = [
      document.getElementById('card-container'),
      document.getElementById('stats-bar'),
      document.querySelector('.sr-root'),
      document.querySelector('.settings-workspace'),
    ].filter(Boolean);

    repaintTargets.forEach(target => target.classList.add('kasa-repaint-hidden'));
    pageShell.classList.remove('kasa-renderer-repaint');
    void pageShell.offsetHeight;
    requestAnimationFrame(() => {
      repaintTargets.forEach(target => target.classList.remove('kasa-repaint-hidden'));
      pageShell.classList.add('kasa-renderer-repaint');
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => pageShell.classList.remove('kasa-renderer-repaint'));
    });
  };

  const stopIdleLowPowerTimer = () => {
    if (!idleLowPowerTimer) return;
    clearTimeout(idleLowPowerTimer);
    idleLowPowerTimer = null;
  };

  const applyRendererLowPower = () => {
    const nextState = systemLowPower || idleLowPower;
    if (rendererLowPower === nextState) return;
    rendererLowPower = nextState;
    document.documentElement.setAttribute('data-kasa-low-power', nextState ? 'on' : 'off');
    window.dispatchEvent(new CustomEvent('kasa:low-power-changed', {
      detail: { enabled: nextState },
    }));
  };

  const scheduleIdleLowPower = () => {
    stopIdleLowPowerTimer();
    if (systemLowPower || document.hidden) return;
    idleLowPowerTimer = window.setTimeout(() => {
      idleLowPower = true;
      applyRendererLowPower();
    }, RENDERER_IDLE_LOW_POWER_MS);
  };

  const resetIdleLowPower = () => {
    if (systemLowPower || document.hidden) return;
    idleLowPower = false;
    applyRendererLowPower();
    scheduleIdleLowPower();
  };

  const setRendererLowPower = (enabled) => {
    systemLowPower = Boolean(enabled);
    if (systemLowPower) {
      stopIdleLowPowerTimer();
      clearTimeout(rendererResumeTimer);
      setPowerSaveOverlay(true, false);
    } else {
      idleLowPower = false;
      scheduleIdleLowPower();
    }
    applyRendererLowPower();
  };

  const resumeRenderer = () => {
    if (document.hidden) return;
    clearTimeout(rendererResumeTimer);
    setPowerSaveOverlay(true, true);
    systemLowPower = false;
    idleLowPower = false;
    applyRendererLowPower();
    scheduleIdleLowPower();
    requestAnimationFrame(() => requestAnimationFrame(forceRendererRepaint));
    rendererResumeTimer = window.setTimeout(() => {
      setPowerSaveOverlay(false, false);
    }, 420);
  };

  const sendHeartbeat = () => apiFetch('/heartbeat', { method: 'POST' });

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const scheduleHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(
      sendHeartbeat,
      rendererLowPower ? HEARTBEAT_LOW_POWER_INTERVAL_MS : HEARTBEAT_ACTIVE_INTERVAL_MS
    );
  };

  window.KASA_SET_LOW_POWER = setRendererLowPower;
  window.KASA_RESUME_RENDERER = resumeRenderer;
  setRendererLowPower(document.hidden);
  sendHeartbeat();
  scheduleHeartbeat();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setRendererLowPower(true);
    else resumeRenderer();
  });
  IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, resetIdleLowPower, { passive: true });
  });
  window.addEventListener('kasa:low-power-changed', scheduleHeartbeat);
  window.addEventListener('pagehide', () => {
    stopHeartbeat();
    stopIdleLowPowerTimer();
    clearTimeout(rendererResumeTimer);
    IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
      window.removeEventListener(eventName, resetIdleLowPower);
    });
    window.removeEventListener('kasa:low-power-changed', scheduleHeartbeat);
  }, { once: true });

}