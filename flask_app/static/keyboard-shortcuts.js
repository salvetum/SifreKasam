/**
 * ŞifreKasam v2.7.0-beta.4 - Uygulama geneli klavye kısayolları (ES Module)
 *
 * Tasarım kararı: kısayollar **tek bir tabloda** tanımlı ve hem bağlama
 * hem yardım listesi aynı tablodan beslenir. Yardım listesi ayrı bir yerde
 * elle yazılırsa zamanla kayar (sık görülen hata: kısayol çalışıyor ama
 * listede görünmüyor, ya da tam tersi).
 *
 * 🔴 Yazarken kısayol devreye girmez. `isTypingContext()` bunu ayrıştırır:
 * bir `input`/`textarea`/`contenteditable` içindeyken **çıplak harf**
 * kısayolları (bugün tek olan `?`) sessizce geçersizdir. `Ctrl/Cmd` kombinasyonları
 * ise yazarken de çalışır — arama kutusuna odaklanmak tam olarak yazarken
 * işe yarar.
 *
 * 🔴 `mod` = Windows'ta `Ctrl`, macOS'ta `Cmd`. `event.metaKey` tek başına
 * denetlenmez: bazı klavye düzenlerinde Cmd, harf modunda `metaKey` ile
 * birlikte `ctrlKey` de basılı gelir ve yanlış eşleşme üretir.
 */

const TYPING_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

const isTypingContext = (element) => {
  if (!element) return false;
  if (element.isContentEditable) return true;
  return !!element.closest?.(TYPING_SELECTOR);
};

/** `event` → kanonik kısayol dizesi (`mod+shift+n` gibi). */
export function shortcutFromEvent(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  let key = (event.key || '').toLowerCase();
  if (key === ' ') key = 'space';
  // `?` Türkçe klavyede `Shift+/` üretir; `event.key` zaten '?' gelir ama
  // yardım listesinde okunabilir bir karşılık istiyoruz.
  parts.push(key);
  return parts.join('+');
}

/**
 * Kısayol tablosu. `id` bağlama, `keys` yardım listesi ve testler tarafından
 * kullanılır; `target` uygulama yüzeyinin id'sidir (`modal`, `navigate` ya da
 * `function` adı — hepsi `resolveAction` içinde karşılanır).
 *
 * 🔴 `lock` burada YOK: Ctrl/Cmd+L'in sahibi `partials/scripts/lock-shortcut.html`
 * (yedekli `fetch` yolu içeriyor). Burada ikinci bir sahibi olsaydı aynı tuşa
 * iki dinleyici takılır ve kilitleme iki kez POST edilirdi.
 */
export const SHORTCUTS = [
  { id: 'search', keys: 'mod+k', labelKey: 'Aramaya odaklan', bare: false, target: 'search' },
  { id: 'add', keys: 'mod+shift+n', labelKey: 'Yeni kayıt ekle', bare: false, target: 'navigate:/ekle' },
  { id: 'generator', keys: 'mod+j', labelKey: 'Parola üreticisi', bare: false, target: 'modal:passwordGeneratorModal' },
  { id: 'import', keys: 'mod+shift+i', labelKey: 'İçe aktar', bare: false, target: 'modal:importModal' },
  { id: 'export', keys: 'mod+e', labelKey: 'Dışa aktar', bare: false, target: 'modal:exportModal' },
  { id: 'settings', keys: 'mod+,', labelKey: 'Ayarlar', bare: false, target: 'modal:settingsModal' },
  { id: 'lock', keys: 'mod+l', labelKey: 'Kasayı kilitle', bare: false, target: 'none' },
  { id: 'help', keys: 'shift+?', labelKey: 'Kısayol listesi', bare: true, target: 'modal:keyboardShortcutsModal' },
];

/**
 * Etkin tablo. Sunucu (`app.py:KEYBOARD_SHORTCUTS`) tarafından basılan tablo
 * varsa **o** kullanılır; `SHORTCUTS` yalnız sunucu tablosu bulunamazsa
 * (modül tek başına yüklenen bir test/sayfa) devreye girer. Sunucu tablosu
 * `keys`/`target`/`bare` alanlarını **kopyalamaz**, yalnız etiketleri taşır:
 * 🔴 `keys` ölçek, `bare` davranıştır — ikisi de tek yerde (JS) tanımlı
 * kalmalı, yoksa "listede Ctrl+K yazıyor ama çalışmıyor" durumu oluşur.
 */
const activeTable = () => (Array.isArray(window.KASA_SHORTCUTS) && window.KASA_SHORTCUTS.length)
  ? window.KASA_SHORTCUTS
  : SHORTCUTS;

const triggerButton = (modalId) => {
  // Önce butona basmak hedef modalın kendi açılış mantığını (import dosya
  // sıfırlama, sekme seçimi vb.) da çalıştırır; düşerse doğrudan çağırırız.
  const button = document.querySelector(`[data-kasa-modal="${modalId}"]`);
  if (button) { button.click(); return true; }
  if (typeof window.kasaModalAc === 'function') { window.kasaModalAc(modalId); return true; }
  return false;
};

const resolveAction = (target) => {
  if (!target || target === 'none') return true;
  if (target.startsWith('modal:')) return triggerButton(target.slice(6));
  if (target.startsWith('navigate:')) { window.location.assign(target.slice(9)); return true; }
  if (target === 'search') {
    const input = document.getElementById('search-input');
    if (!input) return false;
    input.focus();
    input.select?.();
    return true;
  }
  return false;
};

export function initKeyboardShortcuts() {
  /* Kısayollar yalnız kasa sayfasında anlamlıdır (arama/kayıt/içe aktarma
     yoksa hedef zaten yok). Yardım modalının bulunduğu sayfayı varlık
     kanıtı sayıyoruz — `app.js` login ekranında da yüklendiği için bu
     koşulsuz bağlanırsa 8 ölü kısayol dinleyicisi kaydedilirdi. */
  if (!document.getElementById('keyboardShortcutsModal')) return null;

  const table = activeTable();
  const bindings = new Map();
  table.forEach((shortcut) => {
    if (shortcut.target === 'none') return; // sahibi başka dosyada
    bindings.set(shortcut.keys, shortcut);
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const shortcut = bindings.get(shortcutFromEvent(event));
    if (!shortcut) return;
    if (shortcut.bare && isTypingContext(event.target)) return;
    if (!resolveAction(shortcut.target)) return;
    event.preventDefault();
  });

  return { table, bindings };
}