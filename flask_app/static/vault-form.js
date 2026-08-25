/**
 * ŞifreKasam v2.7.0-beta.3 - Ekle / Düzenle Formu modülü — v6
 *
 * MİMARİ (blank-swap): Tip değişiminde alanlar TEK TEK animasyonlanmaz.
 * Üç cam panel hızla söner (110 ms) → içerik tamamen görünmezken tüm form
 * durumu ANINDA uygulanır (hidden/label/disabled/generator…) → paneller
 * yeni haliyle süzülerek girer (190 ms).
 *
 * Neden: cam girdilerin boyutunu/opaklığını yerinde animasyonlamak her
 * karede yeniden örnekleme yapar; biriken yarışlar da "yapışkan alan"
 * sınıfını doğurdu. Bu mimaride geçiş sırasında hiçbir cam resize olmaz
 * ve motor o kadar küçük ki yarış doğacak yüzey yok.
 *
 * Sorumluluklar: tip→alan eşlemesi (FIELD_CONFIGS), üretici paneli,
 * kopyala düğmesi, gönderim kilidi. Takvim → form-calendar.js,
 * şifre sağlığı → password-strength.js.
 */

import { copyToClipboard } from './reveal-copy.js';

const TYPE_ORDER = ['Website', 'Application', 'CreditCard', 'SecureNote', 'Other'];
const EASE_SWIFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_EXIT = 'cubic-bezier(0.4, 0, 0.2, 1)';

export function initVaultForm() {
  const kayitTipiSelect = document.getElementById('kayit_tipi');
  if (!kayitTipiSelect) return;

  const _t = window._;
  const FIELD_CONFIGS = {
    CreditCard: {
      isim: _t('Kart Başlığı'), login: _t('Kart Numarası'), password: _t('CVV'),
      comment: _t('Not'), sectionTitle: _t('Notlar'),
      sectionDesc: _t('Ek açıklamalar ve hatırlatıcı bilgiler.'),
      showLogin: true, showEmail: false, showPassword: true, showKategori: true,
      showAccess: true,
      commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
    },
    SecureNote: {
      isim: _t('Not Başlığı'), login: _t('Kullanıcı Adı'), email: _t('E-posta'), password: _t('Şifre'),
      comment: _t('Not İçeriği'),
      sectionTitle: _t('Not'),
      sectionDesc: _t('Gizli notlarınızı burada saklayın.'),
      showLogin: false, showEmail: false, showPassword: false, showKategori: true,
      showAccess: false,
      commentRows: 7, commentPlaceholder: _t('Notunuzu buraya yazın…'), commentRequired: true,
    },
    default: {
      isim: _t('İsim / Başlık'), login: _t('Kullanıcı Adı'), email: _t('E-posta'), password: _t('Şifre'),
      comment: _t('Not (İsteğe Bağlı)'), sectionTitle: _t('Notlar'),
      sectionDesc: _t('Ek açıklamalar ve hatırlatıcı bilgiler.'),
      showLogin: true, showEmail: true, showPassword: true, showKategori: true,
      showAccess: true,
      commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
    },
  };

  const el = (id) => document.getElementById(id);
  const urlGroup        = el('website_url_group');
  const loginGroup      = el('login_group');
  const emailGroup      = el('email_group');
  const passwordGroup   = el('password_group');
  const kategoriGroup   = el('kategori_group');
  const accessSection   = el('login_password_row');
  const mainPanel       = el('vault-form-main') || document.querySelector('.vault-form-main');
  const notesPanel      = el('vault-form-notes') || document.querySelector('.vault-form-notes');
  const pageGenerator   = el('pageGenerator');
  const generateBtn     = el('page-generate-btn');
  const strengthCard    = el('vault-strength-card');
  const commentInput    = el('comment');
  const isimLabel       = el('isim_label');
  const loginLabel      = el('login_label');
  const emailLabel      = el('email_label');
  const passwordLabel   = el('password_label');
  const commentLabel    = el('comment_label');
  const cardHolderGroup = el('card_holder_group');
  const cardTripleRow   = el('card_triple_row');
  const expiryAyField   = el('expiry_ay_field');
  const expiryYilField  = el('expiry_yil_field');
  const expiryCalendarField = (el('expiry-calendar-wrapper') || {}).closest ? el('expiry-calendar-wrapper').closest('.vault-field') : null;
  const expirySidebarSection = el('vault-section-expiry') ? el('vault-section-expiry').closest('.vault-form-panel') : null;
  const loginInput      = el('login');
  const passwordInput   = el('page-password');
  const notesTitle      = el('vault-section-notes');
  const notesDesc       = notesTitle ? notesTitle.nextElementSibling : null;
  const passwordLine    = passwordGroup ? passwordGroup.querySelector('.vault-password-line') : null;
  const formEl          = document.getElementById('ekle-form');

  const origMaxLength   = passwordInput ? passwordInput.maxLength : -1;
  const origInputMode   = passwordInput ? passwordInput.getAttribute('inputmode') : null;
  const origPattern     = passwordInput ? passwordInput.getAttribute('pattern') : null;
  const origPlaceholder = passwordInput ? passwordInput.placeholder : '';

  const motionOff = () => document.documentElement.getAttribute('data-kasa-animations') === 'off'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ────────────────────────────────────────────────────────────────
  // v6 ÇEKİRDEK: blank-swap
  // ────────────────────────────────────────────────────────────────
  let currentType = kayitTipiSelect.value;
  let lastRequestedType = currentType; // hizli dalgalarda da dogru nop icin
  let swapToken = 0;

  const setVis = (elm, show) => { if (elm) elm.hidden = !show; };

  const applyTypeState = (type, config, isCard) => {
    setVis(urlGroup, type === 'Website');
    setVis(kategoriGroup, Boolean(config.showKategori));
    setVis(cardHolderGroup, isCard);
    if (cardTripleRow) cardTripleRow.classList.toggle('is-active', isCard);

    setVis(loginGroup, Boolean(config.showLogin));
    setVis(emailGroup, Boolean(config.showEmail));
    setVis(passwordGroup, Boolean(config.showPassword));
    setVis(strengthCard, Boolean(config.showPassword) && !isCard);
    setVis(accessSection, Boolean(config.showAccess));

    setVis(expiryAyField, isCard);
    setVis(expiryYilField, isCard);
    if (expirySidebarSection) setVis(expirySidebarSection, !isCard);
    else if (expiryCalendarField) setVis(expiryCalendarField, !isCard);

    if (isCard && typeof window.KASA_CLOSE_EXPIRY_POPUP === 'function') {
      window.KASA_CLOSE_EXPIRY_POPUP();
    }
    if (isCard && typeof window.KASA_SYNC_CARD_EXPIRY === 'function') {
      window.KASA_SYNC_CARD_EXPIRY();
    }

    if (loginInput) loginInput.placeholder = isCard ? '4532 0151 1234 5678' : 'kullanici_adi';

    if (passwordInput) {
      if (isCard) {
        passwordInput.maxLength = 3;
        passwordInput.setAttribute('inputmode', 'numeric');
        passwordInput.setAttribute('pattern', '[0-9]*');
        passwordInput.placeholder = '000';
      } else {
        if (origMaxLength >= 0) passwordInput.maxLength = origMaxLength;
        else passwordInput.removeAttribute('maxlength');
        if (origInputMode !== null) passwordInput.setAttribute('inputmode', origInputMode);
        else passwordInput.removeAttribute('inputmode');
        if (origPattern !== null) passwordInput.setAttribute('pattern', origPattern);
        else passwordInput.removeAttribute('pattern');
        passwordInput.placeholder = origPlaceholder;
      }
    }

    if (pageGenerator && !pageGenerator.classList.contains('is-collapsed')) {
      pageGenerator.classList.add('is-collapsed');
      pageGenerator.setAttribute('aria-hidden', 'true');
      generateBtn?.setAttribute('aria-expanded', 'false');
      const genIcon = generateBtn?.querySelector('i');
      if (genIcon) genIcon.className = 'fa-solid fa-wand-magic-sparkles fa-xs';
    }
    if (passwordLine) passwordLine.classList.toggle('has-no-generator', isCard);

    if (isimLabel)     isimLabel.textContent    = config.isim;
    if (loginLabel    && config.login)    loginLabel.textContent    = config.login;
    if (emailLabel    && config.email)    emailLabel.textContent    = config.email;
    if (passwordLabel && config.password) passwordLabel.textContent = config.password;
    if (commentLabel)  commentLabel.textContent  = config.comment;
    if (notesTitle && config.sectionTitle) notesTitle.textContent = config.sectionTitle;
    if (notesDesc && config.sectionDesc) notesDesc.textContent = config.sectionDesc;

    if (commentInput) {
      commentInput.rows        = config.commentRows || 3;
      commentInput.placeholder = config.commentPlaceholder || 'Notlar…';
      commentInput.required    = Boolean(config.commentRequired);
    }

    if (el('website_url'))   el('website_url').disabled   = type !== 'Website';
    if (el('login'))         el('login').disabled         = !config.showLogin;
    if (el('email'))         el('email').disabled         = !config.showEmail;
    if (el('page-password')) el('page-password').disabled = !config.showPassword;
  };

  let liveAnims = [];
  const onTypeChange = async () => {
    const type = kayitTipiSelect.value;
    // AYNI tip tekrar seçilirse hiçbir şey yapma (custom select her tıkta
    // change dispatch edebiliyor → tam döngü = kullanıcıya çift render).
    // Kıyas SON İSTENEN tipe göre: bayat currentType hızlı dalgada
    // son geçişleri yanlışlıkla düşürüyordu.
    if (type === lastRequestedType) return;
    const prevRequested = lastRequestedType;
    lastRequestedType = type;

    const config = FIELD_CONFIGS[type] || FIELD_CONFIGS.default;
    const isCard = type === 'CreditCard';
    const my = ++swapToken;

    const goingDown = TYPE_ORDER.indexOf(type) >= TYPE_ORDER.indexOf(prevRequested);
    const targets = [mainPanel, accessSection, notesPanel].filter(Boolean);

    // Önceki döngüden kalan TÜM canlı animasyonlar iptal (çift hareket yok)
    liveAnims.forEach(a => a.cancel());
    liveAnims = [];

    // 1) ÇIKIŞ: paneller hızca söner
    let outAnims = [];
    if (!motionOff() && targets.length) {
      outAnims = targets.map(p => p.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: `translateY(${goingDown ? -5 : 5}px)` },
        ],
        { duration: 80, easing: EASE_EXIT, fill: 'forwards' }
      ));
      liveAnims.push(...outAnims);
      await Promise.allSettled(outAnims.map(a => a.finished)).catch(() => {});
    }

    // Çıkış sırasında yeni değişiklik geldiyse bu döngüyü terk et
    if (my !== swapToken) { outAnims.forEach(a => a.cancel()); return; }

    // 2) Durum ANINDA uygulanır (ekran boşken)
    outAnims.forEach(a => a.cancel());
    currentType = type;
    applyTypeState(type, config, isCard);

    // 3) GİRİŞ: paneller yeni haliyle süzülür
    if (!motionOff() && targets.length) {
      void document.body.offsetHeight;
      const dirY = goingDown ? 14 : -14;
      const inAnims = targets.map((p, i) => p.animate(
        [
          { opacity: 0, transform: `translateY(${dirY}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 170, delay: Math.min(i, 3) * 22, easing: EASE_SWIFT }
      ));
      liveAnims.push(...inAnims);
    }
  };

  // İlk durum animasyonsuz uygulanır, sonra change dinleyicisi bağlanır.
  applyTypeState(currentType, FIELD_CONFIGS[currentType] || FIELD_CONFIGS.default, currentType === 'CreditCard');
  kayitTipiSelect.addEventListener('change', () => { onTypeChange(); });

  // ÇİFT ANİMASYON FIX: yükleme girişi (vaultPanelIn) bittikten sonra
  // CSS girişlerini kapat — display:none geçişlerinde Chromium bu
  // animasyonları yeniden oynatıp WAAI girişiyle üst üste bindiriyordu.
  const bootSide = document.querySelector('.vault-form-side');
  const markBooted = () => document.body.classList.add('form-booted');
  if (bootSide) {
    bootSide.addEventListener('animationend', markBooted, { once: true });
    setTimeout(markBooted, 1200); // güvenlik ağı
  } else {
    markBooted();
  }

  // ─── Üretici paneli ───
  generateBtn?.addEventListener('click', () => {
    const isVisible = pageGenerator && !pageGenerator.classList.contains('is-collapsed');
    if (pageGenerator) {
      pageGenerator.classList.toggle('is-collapsed', Boolean(isVisible));
      pageGenerator.setAttribute('aria-hidden', String(Boolean(isVisible)));
      generateBtn.setAttribute('aria-expanded', String(!isVisible));
    }
    const icon = generateBtn?.querySelector('i');
    if (icon) icon.className = isVisible
      ? 'fa-solid fa-wand-magic-sparkles fa-xs'
      : 'fa-solid fa-xmark fa-xs';
  });

  // ─── Kopyala düğmesi ───
  const passwordCopyBtn = el('page-copy-btn');
  if (passwordCopyBtn) {
    passwordCopyBtn.addEventListener('click', async () => {
      const value = passwordInput ? passwordInput.value : '';
      if (!value) return;
      await copyToClipboard(value, passwordCopyBtn.querySelector('i'));
    });
  }

  // ─── Gönderim kilidi + spinner ───
  const saveBtnEl = el('save-btn');
  formEl?.addEventListener('submit', function (e) {
    if (this.dataset.submitted) { e.preventDefault(); return; }
    this.dataset.submitted = 'true';
    if (saveBtnEl) {
      const spinner = document.createElement('i');
      spinner.className = 'fa-solid fa-spinner fa-spin mr-2';
      saveBtnEl.replaceChildren(spinner, document.createTextNode(window._('Kaydediliyor…')));
      saveBtnEl.disabled = true;
      saveBtnEl.classList.add('is-submitting');
    }
  });
}
