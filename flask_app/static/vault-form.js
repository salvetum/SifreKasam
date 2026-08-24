/**
 * ŞifreKasam v2.7.0-beta.3 - Ekle / Düzenle Formu modülü (ES Module)
 *
 * 10. bölüm: kayıt tipine göre alan gösterimi, şifre üretici
 * açma/kapama davranışı ve form geçiş animasyonu.
 * initVaultForm, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

export function initVaultForm() {

  const kayitTipiSelect = document.getElementById('kayit_tipi');
  if (kayitTipiSelect) {
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
    const expiryCalendar  = el('expiry-calendar-wrapper');
    const expiryCalendarField = expiryCalendar ? expiryCalendar.closest('.vault-field') : null;
    const expirySidebarSection = el('vault-section-expiry') ? el('vault-section-expiry').closest('.vault-form-panel') : null;
    const loginInput      = el('login');
    const passwordInput   = el('page-password');
    const notesTitle      = el('vault-section-notes');
    const notesDesc       = notesTitle ? notesTitle.nextElementSibling : null;

    const origMaxLength   = passwordInput ? passwordInput.maxLength : -1;
    const origInputMode   = passwordInput ? passwordInput.getAttribute('inputmode') : null;
    const origPattern     = passwordInput ? passwordInput.getAttribute('pattern') : null;
    const origPlaceholder = passwordInput ? passwordInput.placeholder : '';

    function animateToggle(el, show) {
      if (!el) return;

      clearTimeout(el._atShow);
      clearTimeout(el._atHide);

      if (show) {
        if (!el.hidden) return;
        el.hidden = false;
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.22s ease';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            el.style.opacity = '1';
          });
        });
        el._atShow = setTimeout(function () {
          el.style.opacity = '';
          el.style.transition = '';
        }, 280);
      } else {
        if (el.hidden) return;
        el.style.opacity = '1';
        el.style.transition = 'opacity 0.16s ease';
        requestAnimationFrame(function () {
          el.style.opacity = '0';
        });
        el._atHide = setTimeout(function () {
          el.hidden = true;
          el.style.opacity = '';
          el.style.transition = '';
        }, 200);
      }
    }

    generateBtn?.addEventListener('click', () => {
      const isVisible = pageGenerator && !pageGenerator.classList.contains('is-collapsed');
      if (pageGenerator) {
        pageGenerator.classList.toggle('is-collapsed', Boolean(isVisible));
        pageGenerator.setAttribute('aria-hidden', String(Boolean(isVisible)));
        generateBtn.setAttribute('aria-expanded', String(!isVisible));
      }
      const icon = generateBtn.querySelector('i');
      if (icon) icon.className = isVisible
        ? 'fa-solid fa-wand-magic-sparkles fa-xs'
        : 'fa-solid fa-xmark fa-xs';
    });

    const toggleFormFields = () => {
      try {
      const config = FIELD_CONFIGS[kayitTipiSelect.value] || FIELD_CONFIGS.default;
      const isCard = kayitTipiSelect.value === 'CreditCard';

      if (urlGroup)      animateToggle(urlGroup, kayitTipiSelect.value === 'Website');
      if (loginGroup)    animateToggle(loginGroup, config.showLogin);
      if (emailGroup)    animateToggle(emailGroup, config.showEmail);
      if (passwordGroup) animateToggle(passwordGroup, config.showPassword);
      if (kategoriGroup) animateToggle(kategoriGroup, config.showKategori);
      if (accessSection) animateToggle(accessSection, config.showAccess);

      if (strengthCard) animateToggle(strengthCard, config.showPassword && !isCard);
      if (cardHolderGroup) animateToggle(cardHolderGroup, isCard);
      if (cardTripleRow) cardTripleRow.classList.toggle('is-active', isCard);
      if (expiryAyField) animateToggle(expiryAyField, isCard);
      if (expiryYilField) animateToggle(expiryYilField, isCard);
      if (expirySidebarSection) animateToggle(expirySidebarSection, !isCard);
      else if (expiryCalendarField) animateToggle(expiryCalendarField, !isCard);

      if (isCard && typeof window.KASA_CLOSE_EXPIRY_POPUP === 'function') {
        window.KASA_CLOSE_EXPIRY_POPUP();
      }
      if (isCard && typeof window.KASA_SYNC_CARD_EXPIRY === 'function') {
        window.KASA_SYNC_CARD_EXPIRY();
      }

      if (loginInput) {
        if (isCard) {
          loginInput.placeholder = '4532 0151 1234 5678';
        } else {
          loginInput.placeholder = 'kullanici_adi';
        }
      }

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

      if (pageGenerator) {
        pageGenerator.classList.add('is-collapsed');
        pageGenerator.setAttribute('aria-hidden', 'true');
        generateBtn?.setAttribute('aria-expanded', 'false');
      }

      const genIcon = generateBtn?.querySelector('i');
      if (genIcon) genIcon.className = 'fa-solid fa-wand-magic-sparkles fa-xs';

      if (generateBtn) generateBtn.style.display = isCard ? 'none' : '';

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

      el('website_url') && (el('website_url').disabled = kayitTipiSelect.value !== 'Website');
      el('login')       && (el('login').disabled       = !config.showLogin);
      el('email')       && (el('email').disabled       = !config.showEmail);
      el('page-password') && (el('page-password').disabled = !config.showPassword);
      } catch(err) { console.error('[vault-form] toggleFormFields ERROR:', err && err.message || err); }
    };

    toggleFormFields();
    kayitTipiSelect.addEventListener('change', toggleFormFields);

    const wrapper = kayitTipiSelect.closest('.kasa-custom-select');
    if (wrapper) {
      wrapper.addEventListener('click', (e) => {
        const option = e.target.closest('.kasa-custom-select-option');
        if (!option || option.disabled) return;
        const value = option.dataset.value;
        if (!value) return;
        if (kayitTipiSelect.value !== value) {
          kayitTipiSelect.value = value;
          kayitTipiSelect.dispatchEvent(new Event('input', { bubbles: true }));
          kayitTipiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
  }

}
