/* ════════════════════════════════════════════════════════════════
   Liquid Glass — GPU-uyumlu kademeli cam buğusu
   Önceki SVG displacement-map (kube.io tekniği) sürümü Chromium'da
   CPU'da raster edildiği için yüksek işlemci tüketimine yol açıyordu;
   artık saf CSS backdrop-filter: blur() kullanılır — Chromium bunu
   GPU compositing'e alabilir.

   KAPSAM: iki özel yüzeyde sabit parametreler, diğer tüm
   .glass yüzeylerde boyut-tabanlı kademeli kırılma:
     .settings-modal-content  →  #kasa-liquid-settings  (blur 22)
     .glass                   →  boyuta göre tier:
         büyük yüzeyler (≥150000 px²) : blur 20, saturate 1.4
         orta yüzeyler   (≥40000 px²)  : blur 14, saturate 1.3
         küçük yüzeyler               : blur  9, saturate 1.25

   data-glass-quality ≠ high, data-glass-effects="off" veya
   data-kasa-low-power="on" → hiçbir katman uygulanmaz, blur CSS'e
   geri döner.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SPECIAL = [
    { selector: '.settings-modal-content', blur: 22, saturate: 1.4 }
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

    /* Tüm diğer .glass yüzeyler: boyut-tabanlı tier.
       Vault kartları (.vault-card-shell) hariç: kartlar kalıcı
       CSS --glass-vivid-blur ile GPU tarafından boyanır; JS tier
       override'i çift render (glass flash) yaratır. */
    var nodes = document.querySelectorAll('.glass:not(.vault-card-shell)');
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (seen.has(node)) continue;
      seen.add(node);
      applyTo(node, tierParams(node.getBoundingClientRect()), enabled);
    }
  }

  function init() {
    refreshAll();

    /* ── TETİK YOLU (c): kök nitelikleri ──────────────────────────
       data-glass-quality / data-glass-effects / data-glass-blur /
       data-kasa-low-power / data-bs-theme (tema geçişi) değişimi.
       data-bs-theme daha önce bu listede yoktu; tema değişimi cam
       yüzeyleri doğrudan etkilediği için eklendi. */
    new MutationObserver(refreshAll).observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-glass-quality', 'data-glass-effects', 'data-glass-blur',
        'data-kasa-low-power', 'data-bs-theme'
      ]
    });

    var settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
      new MutationObserver(refreshAll).observe(settingsModal, {
        attributes: true,
        attributeFilter: ['class']
      });
    }

    /* ── TETİK YOLU (a): uygulama olayları ────────────────────────
       kasa:glass-refresh : vault-index.js cam kart görünürlüğü,
                            blur/veil ölçek değişimi (app.js:1367)
       kasa:cards-page-changed : filtre/sayfalama/derin filtre sonrası
                            kart sayfası değişti (vault-index.js:224,
                            lock.html:112) — bu olay daha önce HİÇBİR
                            dinleyiciye sahip değildi, gövde gözlemcisi
                            dolaylı olarak karşılıyordu. */
    window.addEventListener('kasa:glass-refresh', refreshAll);
    window.addEventListener('kasa:cards-page-changed', refreshAll);

    /* ── TETİK YOLU (b): modal açılışı / kapanışı ─────────────────
       Eski gövde gözlemcisi `class` değişimini izleyerek bunu
       dolaylı olarak yakalıyordu. Artık modal sistemi olayları
       doğrudan dinleniyor: kasaModalAc her açılışta
       `kasa:modal-opened`, kasaModalKapat her kapanışta
       `kasa:modal-closing` fırlatır (modal-system.js).
       Ölçüm, açılış animasyonunun (rAF) ve kapanış gecikmesinin
       (190ms) SONUNDA alınır. */
    window.addEventListener('kasa:modal-opened', function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { refreshAll(); });
      });
    });
    window.addEventListener('kasa:modal-closing', function () {
      setTimeout(refreshAll, 220);
    });

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

    /* ResizeObserver.observe() aynı hedef için idempotenttir; bu yüzden
       artık disconnect() + yeniden observe() zinciri YOK. Önceden her
       DOM mutasyonunda tüm cam yüzeyleri gözlemden çıkarılıp geri
       bağlanıyordu (O(n) unobserve/observe churn). */
    function observeSurface(el) {
      if (typeof ResizeObserver === 'undefined' || !el) return;
      if (!resizeObserver) resizeObserver = new ResizeObserver(scheduleResizeRefresh);
      resizeObserver.observe(el);
    }
    function rescanObservedSurfaces() {
      if (typeof ResizeObserver === 'undefined') return;
      var els = document.querySelectorAll('.glass:not(.vault-card-shell)');
      for (var i = 0; i < els.length; i++) observeSurface(els[i]);
    }
    rescanObservedSurfaces();

    /* ── TETİK YOLU (d): yeni DOM + gizlilik değişimleri ──────────
       childList : yeni eklenen/çıkan düğümler (yeni cam yüzeyleri)
       hidden    : kart ve menü görünürlüğü (wrapper.hidden = …)
       `class` BİLEREK İZLENMİYOR: 60+ kartta filtre/sayfalama her
       adımda yüzlerce class değişimi üretiyordu ve vault kartları
       zaten .vault-card-shell olarak dışlanıyor. Cam etkileyen class
       değişimlerinin tamamı yukarıdaki olay/nitelik yollarıyla
       kapsanıyor:
         · modal is-visible/is-open  → kasa:modal-opened/closing
         · dropdown menü is-open     → aşağıdaki portal gözlemcisi
         · .glass-grain/.kasa-frost  → data-kasa-low-power / quality
         · swal2-shown               → vücut ölçümü değiştirmez
       Gizli kalan cam yüzey: portal kökü (bildirim menüsü + tooltip). */
    var portalRoot = document.getElementById('kasa-portal-root');
    if (portalRoot) {
      new MutationObserver(function () {
        requestAnimationFrame(refreshAll);
      }).observe(portalRoot, {
        attributes: true,
        attributeFilter: ['class', 'hidden']
      });
    }

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
      attributeFilter: ['hidden']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
