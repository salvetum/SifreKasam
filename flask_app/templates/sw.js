// ─── SERVICE WORKER ────────────────────────────────────────────────────────────
// Amaç: uygulama arayüzünü (HTML değil, yalnız /static/) yerel diskten anında
// sunmak. HTML asla cache'lenmez (her sayfada CSRF tokenı + CSP nonce var).
//
// ─── STRATEJİ: stale-while-revalidate ─────────────────────────────────────────
// Ölçüm (2026-10): GET /login?entry=loading sunucuda 14 ms sürüyor; asıl maliyet
// 21 adet render-blocking <link rel=stylesheet> (~617 KB). Önceki sürüm
// /static/*.css|*.js için NETWORK-FIRST kullanıyordu → HER açılışta 21 istek
// ağdan (SW üzerinden) geliyordu. loading.html → /login belge değişimi sırasında
// yeni belge ilk boyasını yapana kadar pencere boş zemin gösteriyordu
// (kullanıcı "yükleme bitti, ekran gri oldu, sonra login geldi" diye
// raporladı).
//
// Yeni strateji: cache'ten ANINDA dön, ağı arka planda tazele. İlk kurulumda
// (cache boş) ağdan beklenir — bu tek seferlik maliyettir.
//
// ─── CACHE ANAHTARI: URL'NİN TAMAMI (?v= DAHİL) ───────────────────────────────
// Sorgu dizesi `?v=` bir SÜRÜM İMZASIDIR, kasten atılmaz: base.html'de
// `app.js?v=9.50` değiştiğinde o URL yeni bir cache anahtarıdır ve eski sürüm
// kullanıcıya servis edilmez. (Anahtarı yola indirgemek daha "temiz" görünür
// ama `?v=`'yi etkisizleştirir; assets-vNNN'i unutmak sessiz bayat dosya
// demektir.) Anahtar yalnızca CACHE ADIYLA (`assets-vNNN`) topluca geçersiz
// kılınır.
//
// Bu yüzden install precache SADECE sürümsüz isteklenen dosyaları içerir
// (üçüncü taraf kütüphaneler, yazı tipleri, ikonlar). Sürümlü CSS/JS ilk
// kullanımda ağdan çekilip cache'a yazılır; o andan sonra anında gelir.

const CACHE = 'kasa-v{{ APP_VERSION }}-assets-v209';
const BG_URL_PREFIX = '/api/background/';

const PRECACHE = [
  '{{ url_for("static", filename="all.min.css") }}',
  '{{ url_for("static", filename="sweetalert2.min.css") }}',
  '{{ url_for("static", filename="toastify.min.css") }}',
  '{{ url_for("static", filename="sweetalert2.all.min.js") }}',
  '{{ url_for("static", filename="toastify.min.js") }}',
  '{{ url_for("static", filename="fonts/sora.woff2") }}',
  '{{ url_for("static", filename="fonts/jetbrains-mono.woff2") }}',
  '{{ url_for("static", filename="icons/icon-192.svg") }}',
  '{{ url_for("static", filename="icons/icon-512.svg") }}',
];

/** Cache anahtarı: istek URL'si olduğu gibi (sorgu dizesi dahil). */
function cacheKeyFor(url) {
  return new Request(url);
}

function offlineFallback() {
  return new Response(JSON.stringify({ offline: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Cache'ten anında dön, ağı arka planda tazele. */
function staleWhileRevalidate(request) {
  const key = cacheKeyFor(request.url);
  return caches.open(CACHE).then(function (cache) {
    return cache.match(key, { ignoreVary: true }).then(function (cached) {
      const revalidate = fetch(request)
        .then(function (res) {
          if (res && res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(function () {
          return cached || offlineFallback();
        });
      // Cache'te varsa boyamayı bekleme; tazeleme arka planda sürer.
      if (cached) return cached;
      return revalidate;
    });
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE).catch(function () { });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); })
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
  const req = e.request;
  const url = new URL(req.url);

  // Sadece kendi origin'imizdeki istekleri ele al
  if (url.origin !== location.origin) return;

  // Arkaplan görselleri: SW cache'e almadan doğrudan sunuya yönlendir.
  // Sunucu Cache-Control header'ı ile tarayıcı HTTP cache'ini yönetir.
  if (req.method === 'GET' && url.pathname.startsWith(BG_URL_PREFIX)) {
    return;
  }

  // HTML gezinmeleri + API + ayarlar: ASLA cache'lenmez. Sayfa gövdesinde
  // oturum/CSRF belirteçleri ve nonce'lu CSP var; bir cache hatası tüm
  // kimlik doğrulamayı bozardu.
  if (req.mode === 'navigate'
      || url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/settings/')) {
    e.respondWith(fetch(req).catch(offlineFallback));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  e.respondWith(fetch(req));
});