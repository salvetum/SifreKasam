/* ════════════════════════════════════════════════════════════════
   Liquid Glass Refraction — kube.io SVG displacement-map tekniği
   (https://kube.io/blog/liquid-glass-css-svg/)
   Chromium/Electron'a özel: SVG filter'ları backdrop-filter olarak
   kullanılır (CSS spec'te yok, yalnızca Chromium destekler).

   KAPSAM: iki özel yüzeyde sabit parametreler, diğer tüm
   .glass / .glass-sm yüzeylerde boyut-tabanlı kademeli kırılma:
     .settings-modal-content  →  #kasa-liquid-settings  (blur 22)
     .entry-login-card        →  #kasa-liquid-login     (blur 13)
     .glass / .glass-sm       →  boyuta göre tier:
         büyük yüzeyler (≥150000 px²) : blur 20, saturate 1.4
         orta yüzeyler   (≥40000 px²)  : blur 14, saturate 1.3
         küçük yüzeyler               : blur  9, saturate 1.25
   Aynı boyut + aynı parametrelere sahip yüzeyler TEK SVG filter'ı
   paylaşır (filter sayısı sınırlı kalır).

   Yöntem:
     1. "Lip bezel" yüzey profili (kenarda dışbükey, ortada hafif
        içbükey) → Snell yasası ile kırılma vektörleri.
     2. Vektörler RGB displacement map'e kodlanır (R=x, G=y, 128=nötr).
     3. Map bir <canvas>'ta render edilir, data URL olarak bir <feImage>
        elementine beslenir ve <feDisplacementMap> içinde kullanılır.
     4. Elemente inline backdrop-filter: url(#filter) uygulanır.
        (modals.css'in !important blur'undan kurtulmak için
         style.setProperty(..., 'important').)

   Tek yüzeyi devre dışı bırakmak için o elemente
   data-kasa-refraction="off" ekleyin.

   data-glass-quality ≠ high, data-glass-effects="off" veya
   data-kasa-low-power="on" → hiçbir katman uygulanmaz, blur CSS'e
   geri döner.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MAX_MAP_DIM = 480;
  var svgRoot = null;
  var mapCache = {};
  var resizeObserver = null;

  var SPECIAL = [
    { selector: '.settings-modal-content', id: 'kasa-liquid-settings', blur: 22, saturate: 1.4 },
    { selector: '.entry-login-card', id: 'kasa-liquid-login', blur: 13, saturate: 1.3 }
  ];

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function smootherstep(t) { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); }

  function convex(u) { return Math.pow(1 - Math.pow(1 - u, 4), 0.25); }

  /* Lip profili: kenarda dışbükey (yükselen çerçeve), ortada hafif
     içbükey (Apple "lip bezel" tarzı). */
  function lip(u) {
    var c = convex(u);
    var cc = 1 - c;
    return cc + (c - cc) * smootherstep(u);
  }

  function refractionEnabled() {
    var el = document.documentElement;
    return el.getAttribute('data-glass-quality') === 'high' &&
           el.getAttribute('data-glass-effects') !== 'off' &&
           el.getAttribute('data-kasa-low-power') !== 'on';
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
    if (area >= 150000) return { blur: 20, saturate: 1.4 };
    if (area >= 40000) return { blur: 14, saturate: 1.3 };
    return { blur: 9, saturate: 1.25 };
  }

  function makeFilterId(blur, saturate, w, h) {
    return 'kasa-liquid-' + blur + '-' + saturate + '-' + w + 'x' + h;
  }

  /* Rounded-rect panel için displacement map üretir.
     Her pikselde en yakın kenara uzaklık → lip profili → Snell →
     içe dönük normal ile kırılma vektörü → RGB. */
  function generateDisplacementMap(w, h) {
    var key = w + 'x' + h;
    if (mapCache[key]) return mapCache[key];

    var minDim = Math.min(w, h);
    var bezel = Math.max(12, Math.min(30, Math.round(minDim * 0.06)));
    var thickness = Math.max(10, Math.round(minDim * 0.035));
    var index = 1.5;
    var samples = 128;

    /* Uzaklık-bağımlı kırılma büyüklüğü profilini tek seferde hesapla. */
    var profile = new Float32Array(samples + 1);
    var maxAbs = 0;
    var dh = 1 / samples;
    for (var i = 0; i <= samples; i++) {
      var u = i * dh;
      var du = 0.002;
      var up = Math.min(1, u + du);
      var um = Math.max(0, u - du);
      var slope = ((lip(up) - lip(um)) / (up - um)) * (thickness / bezel);
      var t1 = Math.atan(slope);
      var t2 = Math.asin(Math.min(0.9999, Math.sin(t1) / index));
      var m = thickness * Math.tan(t1 - t2);
      if (!isFinite(m)) m = 0;
      profile[i] = m;
      var a = Math.abs(m);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < 0.01) maxAbs = 1;

    /* GPU/CPU bütçesi: map'i 480px'e sınırla (feImage elemente
       bilinear stretch eder, alan pürüzsüz olduğundan kayıp yok). */
    var scale = Math.min(1, MAX_MAP_DIM / Math.max(w, h));
    var mw = Math.max(2, Math.round(w * scale));
    var mh = Math.max(2, Math.round(h * scale));

    var canvas = document.createElement('canvas');
    canvas.width = mw;
    canvas.height = mh;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var img = ctx.createImageData(mw, mh);
    var data = img.data;
    var invScale = 127 / maxAbs;
    var wm = mw - 1;
    var hm = mh - 1;
    for (var y = 0; y < mh; y++) {
      for (var x = 0; x < mw; x++) {
        var d = x, dirX = 1, dirY = 0;
        var dr = wm - x;
        if (dr < d) { d = dr; dirX = -1; dirY = 0; }
        if (y < d) { d = y; dirX = 0; dirY = 1; }
        var db = hm - y;
        if (db < d) { d = db; dirX = 0; dirY = -1; }

        var uu = d / bezel;
        var m2;
        if (uu <= 0) m2 = profile[0];
        else if (uu >= 1) m2 = 0;
        else {
          var fi = uu * samples;
          var i0 = Math.floor(fi);
          var i1 = i0 + 1 > samples ? samples : i0 + 1;
          var f = fi - i0;
          m2 = profile[i0] * (1 - f) + profile[i1] * f;
        }

        var idx = (y * mw + x) * 4;
        data[idx] = 128 + Math.round(dirX * m2 * invScale);
        data[idx + 1] = 128 + Math.round(dirY * m2 * invScale);
        data[idx + 2] = 128;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    var result = {
      url: canvas.toDataURL('image/png'),
      scale: Math.max(1, Math.round(maxAbs * 100) / 100)
    };
    mapCache[key] = result;
    return result;
  }

  function ensureSvgRoot() {
    if (svgRoot && svgRoot.isConnected) return svgRoot;
    svgRoot = document.createElementNS(SVG_NS, 'svg');
    svgRoot.setAttribute('class', 'kasa-svg-filters');
    svgRoot.setAttribute('width', '0');
    svgRoot.setAttribute('height', '0');
    svgRoot.setAttribute('aria-hidden', 'true');
    svgRoot.setAttribute('focusable', 'false');
    svgRoot.setAttribute('colorInterpolationFilters', 'sRGB');
    (document.body || document.documentElement).appendChild(svgRoot);
    return svgRoot;
  }

  function buildRefractionFilter(filterId, w, h, map, blur, saturate) {
    var root = ensureSvgRoot();
    var existing = root.querySelector('#' + filterId);
    var paramsSig = w + 'x' + h + '|' + map.url + '|' + blur + '|' + saturate;
    if (existing) {
      if (existing.getAttribute('data-kasa-params') === paramsSig) return;
      existing.parentNode.removeChild(existing);
    }

    var defs = document.createElementNS(SVG_NS, 'defs');
    var filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('data-kasa-params', paramsSig);
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width', String(w));
    filter.setAttribute('height', String(h));
    filter.setAttribute('colorInterpolationFilters', 'sRGB');

    var feImage = document.createElementNS(SVG_NS, 'feImage');
    feImage.setAttribute('href', map.url);
    feImage.setAttribute('x', '0');
    feImage.setAttribute('y', '0');
    feImage.setAttribute('width', String(w));
    feImage.setAttribute('height', String(h));
    feImage.setAttribute('preserveAspectRatio', 'none');
    feImage.setAttribute('result', 'disp');

    var blurF = document.createElementNS(SVG_NS, 'feGaussianBlur');
    blurF.setAttribute('in', 'SourceGraphic');
    blurF.setAttribute('stdDeviation', String(blur));
    blurF.setAttribute('result', 'blurred');

    var sat = document.createElementNS(SVG_NS, 'feColorMatrix');
    sat.setAttribute('in', 'blurred');
    sat.setAttribute('type', 'saturate');
    sat.setAttribute('values', String(saturate));
    sat.setAttribute('result', 'saturated');

    var disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
    disp.setAttribute('in', 'saturated');
    disp.setAttribute('in2', 'disp');
    disp.setAttribute('scale', String(map.scale));
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    filter.appendChild(feImage);
    filter.appendChild(blurF);
    filter.appendChild(sat);
    filter.appendChild(disp);
    defs.appendChild(filter);
    root.appendChild(defs);
  }

  function clearFrom(el) {
    if (!el) return;
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
  }

  /* Gizli (display:none) yüzeylerin inline url(#...) ile referans verdiği
     filter tanımını prune listesinde TUT: yüzey tekrar görünür olduğunda
     buğu 120-200ms'lik debounce beklenmeden anında gelir. Aksi halde
     referans ölü filter'a düşer ve kart buğusuz flash yapar. */
  function keepReferencedFilter(el, keepIds) {
    if (!el || !keepIds) return;
    var inline = el.style && el.style.backdropFilter;
    if (!inline) return;
    var m = /url\(#([^)]+)\)/.exec(inline);
    if (m && svgRoot && svgRoot.querySelector('#' + m[1])) {
      keepIds[m[1]] = true;
    }
  }

  function applyTo(el, spec, enabled, keepIds) {
    if (!enabled) {
      clearFrom(el);
      return;
    }
    var rect = visibleRect(el);
    if (!rect) {
      /* Görünmeyen yüzey: inline stili ve filter tanımını koru
         (display:none iken GPU maliyeti yok). */
      keepReferencedFilter(el, keepIds);
      return;
    }
    var w = Math.max(2, Math.round(rect.width));
    var h = Math.max(2, Math.round(rect.height));
    var map = generateDisplacementMap(w, h);
    var params = spec.params || tierParams(rect);
    var filterId = spec.id || makeFilterId(params.blur, params.saturate, w, h);
    buildRefractionFilter(filterId, w, h, map, params.blur, params.saturate);
    keepIds[filterId] = true;
    /* CSS blur'unu ezmek için inline important. */
    el.style.setProperty('backdrop-filter', 'url(#' + filterId + ')', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'url(#' + filterId + ')', 'important');
  }

  function pruneFilters(keepIds) {
    if (!svgRoot || !svgRoot.isConnected) return;
    var filters = svgRoot.querySelectorAll('filter[id^="kasa-liquid"]');
    for (var i = 0; i < filters.length; i++) {
      var f = filters[i];
      if (!keepIds[f.id]) f.parentNode.removeChild(f);
    }
  }

  function refreshAll() {
    var enabled = refractionEnabled();
    var keepIds = {};
    var seen = new Set();
    var i;

    /* Özel yüzeyler: sabit parametreler. */
    for (i = 0; i < SPECIAL.length; i++) {
      var el = document.querySelector(SPECIAL[i].selector);
      if (!el) continue;
      seen.add(el);
      applyTo(el, { id: SPECIAL[i].id, params: { blur: SPECIAL[i].blur, saturate: SPECIAL[i].saturate } }, enabled, keepIds);
    }

    /* Tüm diğer .glass / .glass-sm yüzeyler: boyut-tabanlı tier. */
    var nodes = document.querySelectorAll('.glass, .glass-sm');
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (seen.has(node)) continue;
      seen.add(node);
      applyTo(node, { params: null }, enabled, keepIds);
    }

    pruneFilters(keepIds);
  }

  function init() {
    refreshAll();

    new MutationObserver(refreshAll).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-glass-quality', 'data-glass-effects', 'data-kasa-low-power']
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

    /* Element boyutu değişince displacement map'i yeniden hesapla.
       ResizeObserver, pencere resize + modal açılış animasyonu + font
       değişimi gibi tüm boyut değişimlerini yakalar. Sık sık hesaplama
       yapmamak için 200ms debounce uygulanır. */
    var resizeTimer = null;
    var scheduleResizeRefresh = function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        refreshAll();
      }, 200);
    };

    /* Gözlenen yüzey kümesini DOM ile senkron tut (yeni eklenen cam
       yüzeyler de boyut değişiminde yeniden hesaplansın). */
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
