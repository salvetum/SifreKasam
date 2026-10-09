/**
 * BAĞIMLI AYARLAR — üst ayar kapalıyken bağlı ayarları tutarlı kilitler.
 *
 * Sorun: üst ayarı kapatmak bağlı ayarları etkisiz bırakıyordu ama kullanıcı
 * bunu göremiyordu. Örnek: İnternet Kill-Switch açıkken "Canlı Sızıntı Taraması"
 * anahtarı çalışıyor, kullanıcı açıyor, hiçbir şey olmuyor (tek uyarı metni
 * vardı ve o da sayfa yüklenirken hesaplanıyordu).
 *
 * ── NEDEN İKİ FARKLI YOL ────────────────────────────────────────────────
 * Ayar formu GERÇEK bir HTML formu (`partials/settings-modal.html`), yani
 * gövdeyi tarayıcı kuruyor. HTML kuralı: **`disabled` input'lar gönderilmez.**
 *
 *   - Bağlı SELECT/NUMBER alanlar: gerçek `disabled` kullanılır. Backend'de
 *     hepsi `if 'x' in request.form:` ile yazılıyor (bkz. `save_settings`),
 *     yani eksik gönderim mevcut değeri **korur**.
 *   - Bağlı CHECKBOX (toggle) alanlar: **`disabled` KULLANILMAZ.** Onlar
 *     `_save_flag()` ile yazılıyor ve yerel oturumda `full_form` olduğu için
 *     alan yoksa `'false'` yazılır — yani `disabled` tercihi **sıfırlardı**.
 *     Bunun yerine `aria-disabled` + CSS sınıfı + tıklamayı JS'de engelleme
 *     kullanılır; input forma gönderilmeye devam eder, değer korunur.
 *
 * Devre dışı seçeneklerin değerleri ASLA silinmez, gizlenmez, sıfırlanmaz.
 * Ana ayar yeniden açıldığında her şey olduğu gibi geri gelir.
 */

const REASON_ATTR = 'data-lock-reason';

/** Üst ayar kapalıyken bağlı ayarların kilitlendiği tek tablo. */
const DEPENDENCIES = [
  {
    parent: '#internet-kill-switch-toggle',
    // Kill-switch AÇIK olduğunda dış ağ tamamen kesiliyor.
    parentBlocks: true,
    dependents: [
      { card: '#live-scan-card', reason: 'Bu özellik internet erişimi gerektirir; Kill-Switch açıkken çalışmaz.' },
    ],
  },
  {
    parent: '#auto_lock_enabled',
    parentBlocks: false,
    dependents: [
      { card: '#auto-lock-timeout-row', reason: 'Yalnızca otomatik kilitleme açıkken kullanılır.' },
    ],
  },
  {
    parent: '#clipboard_auto_clear_enabled',
    parentBlocks: false,
    dependents: [
      // 🔴 `SettingsDependencyLockTests` her `card:` seçicisinin `id="..."`
      // olarak bir ayarda bulunmasını şart koşuyor; bu yüzden bileşik
      // seçici (`#a .b`) kullanılamaz — zaman aşımı satırına kendi
      // `id`'si verildi.
      { card: '#clipboard-clear-timeout-row', reason: 'Yalnızca pano temizleme açıkken süre ayarının etkisi vardır.' },
    ],
  },
  {
    parent: '#lan-enabled-toggle',
    parentBlocks: false,
    dependents: [
      { card: '#lan-full-access-card', reason: 'Yalnızca LAN erişimi açıkken kullanılabilir.' },
      { card: '#lan-reveal-card', reason: 'Yalnızca LAN erişimi açıkken kullanılabilir.' },
    ],
  },
  {
    parent: '#glass-effects-toggle',
    parentBlocks: false,
    dependents: [
      { card: '#glass-quality-card', reason: 'Cam efekti kapalıyken kalite ayarının etkisi yok.' },
      { card: '#glass-scales-card', reason: 'Cam efekti kapalıyken bulanıklık ve perde ayarlarının etkisi yok.' },
      { card: '#glass-frost-card', reason: 'Cam efekti kapalıyken buzlu görünüm ayarının etkisi yok.' },
    ],
  },
  {
    parent: '#chroma-accent-toggle',
    parentBlocks: false,
    dependents: [
      { card: '#chroma-speed-card', reason: 'Renk akışı kapalıyken hız ayarının etkisi yok.' },
    ],
  },
  // Koşul tabanlı kural: üst ayar bir TOGGLE değil, başka bir seçim
  // (arka plan türü). `when` predicate'i DOM'dan okur; `refreshSettingsDependencies()`
  // dışarıdan çağrıldığında yeniden değerlendirilir.
  //
  // 2026-10: burası `appearance-settings.js` içinde toggle'a `disabled`
  // verilerek uygulanıyordu. İki sorun vardı: (a) neden hiç anlatılmıyordu
  // (sadece başlığın yanında soluk bir nokta), (b) `animated_backgrounds_enabled`
  // `save_settings` içinde `_save_flag()` ile yazıldığı için `disabled`
  // checkbox gövdeye girmiyor → yerel kayıtta tercih 'false' OLARAK SIFIRLANIYORDU.
  // Artık `aria-disabled` kullanılıyor ve neden yazılıyor.
  {
    parent: null,
    when: () => !!document.querySelector('[data-background-option="custom"].is-active'),
    dependents: [
      { card: '#animated-background-card', reason: 'Özel arka plan etkinken hazır arka planlar kullanılmıyor; hareket onları yumuşatır.' },
    ],
  },
];

function setReason(card, reason) {
  const holder = card.querySelector('[data-lock-note]');
  if (holder) {
    holder.textContent = '';
    if (reason) {
      // Gerçek `<i>` elemanı — CSS `content` + sabit font-family KULLANILMAZ
      // (yerel Font Awesome 7; sabit yazılırsa ikon boş görünür).
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-lock';
      icon.setAttribute('aria-hidden', 'true');
      holder.appendChild(icon);
      holder.appendChild(document.createTextNode(reason));
    }
    holder.hidden = !reason;
    holder.setAttribute('aria-hidden', String(!reason));
  }
  // Başlık yanına kilit rozeti — neden her zaman görünür olsun diye
  // (tooltip tek başına dokunmatik/klavye kullanıcısına ulaşmıyor).
  const title = card.querySelector('.settings-card-copy h4, .settings-timeout-row label');
  if (title) {
    let badge = card.querySelector('.settings-lock-badge');
    if (reason && !badge) {
      badge = document.createElement('span');
      badge.className = 'settings-lock-badge';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-lock';
      icon.setAttribute('aria-hidden', 'true');
      badge.appendChild(icon);
      const text = document.createElement('span');
      text.textContent = window._ ? window._('Kilitli') : 'Kilitli';
      badge.appendChild(text);
      title.appendChild(badge);
    }
    if (!reason && badge) badge.remove();
    badge?.setAttribute('aria-hidden', String(!reason));
  }
  // `title` yalnızca fare için; satır içi metin zaten görünür durumda.
  const head = card.querySelector('.settings-card-head') || card;
  if (head) {
    if (reason) head.setAttribute('title', reason);
    else head.removeAttribute('title');
  }
}

/**
 * Bir bağımlı kartı kilitler / açar.
 * @param {HTMLElement} card
 * @param {string|null} reason  null → kilidi kaldır
 */
function applyLock(card, reason) {
  const locked = Boolean(reason);
  card.classList.toggle('is-locked', locked);
  setReason(card, locked ? reason : null);

  card.querySelectorAll('input, select, textarea, button').forEach((field) => {
    if (field.type === 'checkbox' || field.type === 'radio') {
      // Toggle: `disabled` DEĞİL (değer koruma tuzağı, dosya başı yorum).
      field.setAttribute('aria-disabled', String(locked));
    } else {
      // Select / number / button: gerçek `disabled` — backend koşullu yazıyor.
      field.disabled = locked;
      field.setAttribute('aria-disabled', String(locked));
      if (locked) field.tabIndex = -1;
      else if (!field.dataset.customSelectReady) field.tabIndex = 0;
      field.kasaSyncCustomSelect?.();
    }
  });
}

/**
 * Toggle'a tıklanınca değeri DEĞİŞTİRMEZ, eski haline döndürür.
 * `change` olayı ancak `checked` gerçekten değiştiyse engellenir; böylece
 * klavye ile gelen Space de yakalanır, programatik `checked = x` atamaları
 * (sunucudan gelen durum) ise engellenmez.
 */
function guardToggle(toggle, isLocked) {
  if (!toggle.__kasaLockGuarded) {
    toggle.addEventListener('click', (event) => {
      if (toggle.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    toggle.addEventListener('change', () => {
      if (toggle.getAttribute('aria-disabled') !== 'true') return;
      const card = toggle.closest('[data-lockable]') || toggle.closest('.settings-card');
      // Sunucudan gelen durum da bu yoldan geçer; yalnız KULLANICI değişikliği
      // geri alınır. `_initial` bayrağı ilk render'ı korur.
      if (toggle.__kasaLockState === undefined) return;
      toggle.checked = toggle.__kasaLockState;
    });
    toggle.__kasaLockGuarded = true;
  }
  toggle.__kasaLockState = toggle.checked;
  toggle.dataset.lockWanted = String(isLocked);
}

let syncRules = null;

/** Dışarıdan (koşul değiştiğinde) yeniden eşitler. */
export function refreshSettingsDependencies() {
  if (syncRules) syncRules();
}

export function initSettingsDependencies() {
  const rules = DEPENDENCIES
    .map((rule) => {
      const parent = rule.parent ? document.querySelector(rule.parent) : null;
      if (rule.parent && !parent) return null;
      const cards = rule.dependents
        .map((dep) => {
          const card = document.querySelector(dep.card);
          return card ? { card, reason: dep.reason } : null;
        })
        .filter(Boolean);
      return cards.length ? { parent, cards, blocks: rule.parentBlocks, when: rule.when } : null;
    })
    .filter(Boolean);

  if (!rules.length) return;

  const sync = () => {
    rules.forEach(({ parent, cards, blocks, when }) => {
      const isLocked = when ? Boolean(when()) : (blocks ? parent.checked : !parent.checked);
      if (parent) guardToggle(parent, isLocked);
      cards.forEach(({ card, reason }) => applyLock(card, isLocked ? reason : null));
    });
  };
  syncRules = sync;

  rules.forEach(({ parent }) => {
    if (!parent) return;
    parent.addEventListener('change', sync);
    parent.addEventListener('click', () => setTimeout(sync, 0));
  });

  sync();
  // Cam/chroma kartlarının görünürlüğü `appearance-settings.js` tarafından
  // da yönetiliyor; iki modül aynı kartlara dokunduğu için bir tur daha
  // eşitlemek gerekiyor.
  window.setTimeout(sync, 0);
  document.addEventListener('kasa:appearance-synced', sync);
}

export { DEPENDENCIES };
