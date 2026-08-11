/* ════════════════════════════════════════════════════════════════
   Liquid Glass — GPU-uyumlu kademeli cam buğusu
   Önceki SVG displacement-map (kube.io tekniği) sürümü Chromium'da
   CPU'da raster edildiği için yüksek işlemci tüketimine yol açıyordu;
   artık saf CSS backdrop-filter: blur() kullanılır — Chromium bunu
   GPU compositing'e alabilir.

   KAPSAM: iki özel yüzeyde sabit parametreler, diğer tüm
   .glass / .glass-sm yüzeylerde boyut-tabanlı kademeli kırılma:
     .settings-modal-content  →  #kasa-liquid-settings  (blur 22)
     .entry-login-card        →  #kasa-liquid-login     (blur 13)
     .glass / .glass-sm       →  boyuta göre tier:
         büyük yüzeyler (≥150000 px²) : blur 20, saturate 1.4
         orta yüzeyler   (≥40000 px²)  : blur 14, saturate 1.3
         küçük yüzeyler               : blur  9, saturate 1.25

   Tek yüzeyi devre dışı bırakmak için o elemente
   data-kasa-refraction="off" ekleyin.

   data-glass-quality ≠ high, data-glass-effects="off" veya
   data-kasa-low-power="on" → hiçbir katman uygulanmaz, blur CSS'e
   geri döner.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SPECIAL = [
    { selector: '.settings-modal-content', blur: 22, saturate: 1.4 },
    { selector: '.entry-login-card', blur: 13, saturate: 1.3 }
  ];

  function refractionEnabled() {
    var el = document.documentElement;
    return el.getAttribute('data-glass-quality') === 'high' &&
           el.getAttribute('data-glass-effects') !== 'off' &&
           el.getAttribute('data-kasa-low-power') !== 'on';
  }

  /* Kullanıcının performans panelinden ayarladığı buğu gücü
     (data-glass-blur: 0 – 1.5, varsayılan 1). Tier blur'u bununla
     çarpılır; 0 ise blur sıfıra iner. */
  function blurScale() {
    var raw = parseFloat(document.documentElement.getAttribute('data-glass-blur') || '1');
    return Number.isFinite(raw) ? Math.max(0, Math.min(1.5, raw)) : 1;
  }

  /* Görünür ve uygulanabilir yüzeyler için rect döner; görünmez/
     çok küçük/kapalı modal içindeki yüzeyler için null. */
  function visibleRect(el) {
    if (!el || !el.isConnected) return null;
    if (el.getAttribute && el.getAttribute('data-kasa-refraction') === 'off') return null;
    var rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    var modal = el.closest('.kasa-modal');
    if (modal && !modal.classList.contains('is-visible')) return null;
    return rect;
  }

  function tierParams(rect) {
    var area = rect.width * rect.height;
    var base = 9;
    var saturate = 1.25;
    if (area >= 150000) { base = 20; saturate = 1.4; }
    else if (area >= 40000) { base = 14; saturate = 1.3; }
    return { blur: Math.round(base * blurScale()), saturate: saturate };
  }

  function clearFrom(el) {
    if (!el) return;
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
  }

  /* GPU-uyumlu saf CSS blur. Aynı element üzerinde inline !important
     ile uygulanır; glass.css'teki varsayılan blur'u kademeli tier'a
     göre ezer. */
  function applyTo(el, params, enabled) {
    if (!enabled) {
      clearFrom(el);
      return;
    }
    if (!visibleRect(el)) return;
    var filter = 'blur(' + params.blur + 'px) saturate(' + params.saturate + ')';
    /* Değer zaten aynıysa yazma: inline stil mutasyonu, composited
       backdrop örneklemesini geçersiz kılar ve kartların buğusu
       "2 kez render" gibi yeniden belirir. Kartın görünür olması,
       entegrasyon, resize gibi her refreshAll geçişinde aynı string
       tekrar yazılıyordu; eşitlik kontrolü gereksiz invalidasyonu
       önler. */
    if (el.style.getPropertyValue('backdrop-filter') === filter &&
        el.style.getPropertyValue('-webkit-backdrop-filter') === filter) {
      return;
    }
    el.style.setProperty('backdrop-filter', filter, 'important');
    el.style.setProperty('-webkit-backdrop-filter', filter, 'important');
  }

  function refreshAll() {
    var enabled = refractionEnabled();
    var seen = new Set();
    var i;

    /* Özel yüzeyler: sabit parametreler (kullanıcı buğu gücüyle çarpılır). */
    var scale = blurScale();
    for (i = 0; i < SPECIAL.length; i++) {
      var el = document.querySelector(SPECIAL[i].selector);
      if (!el) continue;
      seen.add(el);
      applyTo(el, {
        blur: Math.round(SPECIAL[i].blur * scale),
        saturate: SPECIAL[i].saturate
      }, enabled);
    }

    /* Tüm diğer .glass / .glass-sm yüzeyler: boyut-tabanlı tier. */
    var nodes = document.querySelectorAll('.glass, .glass-sm');
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (seen.has(node)) continue;
      seen.add(node);
      applyTo(node, tierParams(node.getBoundingClientRect()), enabled);
    }
  }

  function init() {
    refreshAll();

    new MutationObserver(refreshAll).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-glass-quality', 'data-glass-effects', 'data-glass-blur', 'data-kasa-low-power']
    });

    var settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
      new MutationObserver(refreshAll).observe(settingsModal, {
        attributes: true,
        attributeFilter: ['class']
      });
    }

    /* Görünürlük değişimlerinde (filtre/sayfa geçişi, modal aç/kapa)
       anında buğu uygulanması için senkron bir kanal. Gönderen taraf
       (ör. vault-index) kartlar görünür olduğunda bu event'i fırlatır. */
    window.addEventListener('kasa:glass-refresh', refreshAll);

    /* Boyut değişimlerinde tier'ı güncelle. ResizeObserver, pencere
       resize + modal açılış animasyonu + font değişimi gibi tüm boyut
       değişimlerini yakalar. Sık sık hesaplama yapmamak için 200ms
       debounce uygulanır. */
    var resizeTimer = null;
    var scheduleResizeRefresh = function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        refreshAll();
      }, 200);
    };

    var resizeObserver = null;

    function rescanObservedSurfaces() {
      if (typeof ResizeObserver === 'undefined') return;
      if (!resizeObserver) resizeObserver = new ResizeObserver(scheduleResizeRefresh);
      resizeObserver.disconnect();
      var els = document.querySelectorAll('.glass, .glass-sm');
      for (var i = 0; i < els.length; i++) resizeObserver.observe(els[i]);
    }
    rescanObservedSurfaces();

    /* Dinamik eklenen/çıkan cam yüzeyler + hidden/class görünürlük
       değişimleri için (debounced). hidden değişimi childList değil
       attribute olduğundan ayrıca izlenir. */
    var domTimer = null;
    new MutationObserver(function () {
      if (domTimer) return;
      domTimer = setTimeout(function () {
        domTimer = null;
        refreshAll();
        rescanObservedSurfaces();
      }, 120);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
