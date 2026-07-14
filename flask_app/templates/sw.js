const CACHE = 'kasa-v{{ APP_VERSION }}-assets-v39';
const ASSETS = [
  '{{ url_for("static", filename="style.css") }}',
  '{{ url_for("static", filename="tailwind-lite.css") }}',
  '{{ url_for("static", filename="all.min.css") }}',
  '{{ url_for("static", filename="sweetalert2.min.css") }}',
  '{{ url_for("static", filename="toastify.min.css") }}',
  '{{ url_for("static", filename="bootstrap.min.css") }}',
  '{{ url_for("static", filename="app.js") }}',
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
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  // Sadece kendi origin'imizdeki istekleri ele al
  if (url.origin !== location.origin) return;

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





