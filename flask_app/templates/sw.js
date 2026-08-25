const CACHE = 'kasa-v{{ APP_VERSION }}-assets-v137';
const BG_URL_PREFIX = '/api/background/';
const ASSETS = [
  '{{ url_for("static", filename="tokens.css") }}',
  '{{ url_for("static", filename="base.css") }}',
  '{{ url_for("static", filename="vault-form.css") }}',
  '{{ url_for("static", filename="utilities.css") }}',
  '{{ url_for("static", filename="buttons.css") }}',
  '{{ url_for("static", filename="cards.css") }}',
  '{{ url_for("static", filename="modals.css") }}',
  '{{ url_for("static", filename="theme-states.css") }}',
  '{{ url_for("static", filename="responsive.css") }}',
  '{{ url_for("static", filename="background.css") }}',
  '{{ url_for("static", filename="custom-select.css") }}',
  '{{ url_for("static", filename="settings-modal.css") }}',
  '{{ url_for("static", filename="vault-form-2.css") }}',
  '{{ url_for("static", filename="date-picker.css") }}',
  '{{ url_for("static", filename="theme-overrides.css") }}',
  '{{ url_for("static", filename="misc.css") }}',
  '{{ url_for("static", filename="glass.css") }}',
  '{{ url_for("static", filename="tailwind-lite.css") }}',
  '{{ url_for("static", filename="all.min.css") }}',
  '{{ url_for("static", filename="sweetalert2.min.css") }}',
  '{{ url_for("static", filename="toastify.min.css") }}',
  '{{ url_for("static", filename="app.js") }}',
  '{{ url_for("static", filename="color-math.js") }}',
  '{{ url_for("static", filename="liquid-glass.js") }}',
  '{{ url_for("static", filename="password-generator.js") }}',
  '{{ url_for("static", filename="toast.js") }}',
  '{{ url_for("static", filename="reveal-copy.js") }}',
  '{{ url_for("static", filename="password-strength.js") }}',
  '{{ url_for("static", filename="custom-controls.js") }}',
  '{{ url_for("static", filename="lan-settings.js") }}',
  '{{ url_for("static", filename="modal-system.js") }}',
  '{{ url_for("static", filename="heartbeat.js") }}',
  '{{ url_for("static", filename="appearance-settings.js") }}',
  '{{ url_for("static", filename="vault-index.js") }}',
  '{{ url_for("static", filename="vault-form.js") }}',
  '{{ url_for("static", filename="sweetalert2.all.min.js") }}',
  '{{ url_for("static", filename="toastify.min.js") }}',
  '{{ url_for("static", filename="fonts/sora.woff2") }}',
  '{{ url_for("static", filename="fonts/jetbrains-mono.woff2") }}',
  '{{ url_for("static", filename="icons/icon-192.svg") }}',
  '{{ url_for("static", filename="icons/icon-512.svg") }}',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS).catch(function () {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      // Önceki sürümlerde SW cache'e alınmış arkaplan görsellerini temizle.
      return caches.open(CACHE).then(function (cache) {
        return cache.keys().then(function (reqs) {
          return Promise.all(
            reqs.filter(function (req) {
              return new URL(req.url).pathname.startsWith(BG_URL_PREFIX);
            }).map(function (req) { return cache.delete(req); })
          );
        });
      });
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  // Sadece kendi origin'imizdeki istekleri ele al
  if (url.origin !== location.origin) return;

  // Arkaplan görselleri: SW cache'e almadan doğrudan sunuya yönlendir.
  // Sunucu Cache-Control header'ı ile tarayıcı HTTP cache'ini yönetir.
  // SW cache-first kullanılmaz → silinen/replaced edilen arkaplan görselleri
  // cache'de kalmaz ve depolama birikmez.
  if (req.method === 'GET' && url.pathname.startsWith(BG_URL_PREFIX)) {
    return;
  }

  // API isteklerini cache'leme
  if (req.mode === 'navigate' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/settings/')) {
    e.respondWith(
      fetch(req).catch(function () { return new Response(JSON.stringify({ offline: true }), { status: 503 }); })
    );
    return;
  }

  // CSS/JS dosyaları: geliştirme sırasında eski arayüz kalmasın diye network-first
  if (url.pathname.startsWith('/static/') && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js'))) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (!res || !res.ok) return res;
        return caches.open(CACHE).then(function (cache) {
          cache.put(req, res.clone());
          return res;
        });
      }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // Diğer statik dosyalar: cache-first
  if (url.pathname.startsWith('/static/')) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req).then(function (res) {
          if (!res || !res.ok) return res;
          return caches.open(CACHE).then(function (cache) {
            cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }
  e.respondWith(fetch(req));
});





