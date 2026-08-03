/* ════════════════════════════════════════════════════════════════
   Liquid Glass Refraction — kube.io SVG displacement-map tekniği
   (https://kube.io/blog/liquid-glass-css-svg/)
   Chromium/Electron'a özel: SVG filter'ları backdrop-filter olarak
   kullanılır (CSS spec'te yok, yalnızca Chromium destekler).

   SINIRLI KAPSAM: yalnızca 2 büyük/öne çıkan yüzeyde gerçek kırılma:
     .settings-modal-content  →  #kasa-liquid-settings
     .entry-login-card        →  #kasa-liquid-login
   Diğer tüm .glass/.glass-sm yüzeylerde yalnızca KATMAN 1 (ucuz)
   çalışır; bu script onlara dokunmaz.

   Yöntem:
     1. "Lip bezel" yüzey profili (kenarda dışbükey, ortada hafif
        içbükey) → Snell yasası ile kırılma vektörleri.
     2. Vektörler RGB displacement map'e kodlanır (R=x, G=y, 128=nötr).
     3. Map bir <canvas>'ta render edilir, data URL olarak bir <feImage>
        elementine beslenir ve <feDisplacementMap> içinde kullanılır.
     4. Elemente inline backdrop-filter: url(#filter) uygulanır.
        (modals.css'in !important blur'undan kurtulmak için
         style.setProperty(..., 'important').)

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

  var TARGETS = [
    { selector: '.settings-modal-content', filterId: 'kasa-liquid-settings', blur: 22, saturate: 1.4 },
    { selector: '.entry-login-card', filterId: 'kasa-liquid-login', blur: 13, saturate: 1.3 }
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

  function elementVisible(el) {
    if (!el || !el.isConnected) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    var modal = el.closest('.kasa-modal');
    if (modal && !modal.classList.contains('is-visible')) return false;
    return true;
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

  function buildRefractionFilter(target, w, h, map) {
    var root = ensureSvgRoot();
    var existing = root.querySelector('#' + target.filterId);
    if (existing) existing.parentNode.removeChild(existing);

    var defs = document.createElementNS(SVG_NS, 'defs');
    var filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', target.filterId);
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
    blurF.setAttribute('stdDeviation', String(target.blur));
    blurF.setAttribute('result', 'blurred');

    var sat = document.createElementNS(SVG_NS, 'feColorMatrix');
    sat.setAttribute('in', 'blurred');
    sat.setAttribute('type', 'saturate');
    sat.setAttribute('values', String(target.saturate));
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

  function removeFilter(target) {
    if (!svgRoot || !svgRoot.isConnected) return;
    var f = svgRoot.querySelector('#' + target.filterId);
    if (f) f.parentNode.removeChild(f);
  }

  function applyTo(el, target) {
    if (!el) return;
    if (!refractionEnabled() || !elementVisible(el)) {
      clearFrom(el);
      removeFilter(target);
      return;
    }
    var rect = el.getBoundingClientRect();
    var w = Math.max(2, Math.round(rect.width));
    var h = Math.max(2, Math.round(rect.height));
    var map = generateDisplacementMap(w, h);
    buildRefractionFilter(target, w, h, map);
    /* modals.css'in !important blur'unu ezmek için inline important. */
    el.style.setProperty('backdrop-filter', 'url(#' + target.filterId + ')', 'important');
    el.style.setProperty('-webkit-backdrop-filter', 'url(#' + target.filterId + ')', 'important');
  }

  function clearFrom(el) {
    if (!el) return;
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
  }

  function refreshAll() {
    for (var i = 0; i < TARGETS.length; i++) {
      applyTo(document.querySelector(TARGETS[i].selector), TARGETS[i]);
    }
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

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) return;
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        refreshAll();
      }, 250);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
