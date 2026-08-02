/**
 * ŞifreKasam v2.6.3-beta.2 - Ekle / Düzenle Formu modülü (ES Module)
 *
 * 10. bölüm: kayıt tipine göre alan gösterimi ve şifre üretici
 * açma/kapama davranışı.
 * initVaultForm, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

export function initVaultForm() {

  const kayitTipiSelect = document.getElementById('kayit_tipi');
  if (kayitTipiSelect) {
    const _t = window._;
    const FIELD_CONFIGS = {
      CreditCard: {
        isim: _t('Kart Başlığı'), login: _t('Kart Numarası'), password: _t('CVV / Şifre'),
        comment: _t('Not / Son Kullanma Tarihi'),
        showLogin: true, showPassword: true, showKategori: true,
        commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
      },
      SecureNote: {
        isim: _t('Not Başlığı'), comment: _t('Not İçeriği'),
        showLogin: false, showPassword: false, showKategori: true,
        commentRows: 7, commentPlaceholder: _t('Notunuzu buraya yazın…'), commentRequired: true,
      },
      default: {
        isim: _t('İsim / Başlık'), login: _t('Kullanıcı Adı'), password: _t('Şifre'),
        comment: _t('Not (İsteğe Bağlı)'),
        showLogin: true, showPassword: true, showKategori: true,
        commentRows: 3, commentPlaceholder: _t('Notlar…'), commentRequired: false,
      },
    };

    const el = (id) => document.getElementById(id);
    const urlGroup      = el('website_url_group');
    const loginGroup    = el('login_group');
    const passwordGroup = el('password_group');
    const kategoriGroup = el('kategori_group');
    const pageGenerator = el('pageGenerator');
    const generateBtn   = el('page-generate-btn');
    const strengthCard  = el('vault-strength-card');
    const commentInput  = el('comment');
    const isimLabel     = el('isim_label');
    const loginLabel    = el('login_label');
    const passwordLabel = el('password_label');
    const commentLabel  = el('comment_label');

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
      const config = FIELD_CONFIGS[kayitTipiSelect.value] || FIELD_CONFIGS.default;

      if (urlGroup)      urlGroup.hidden      = kayitTipiSelect.value !== 'Website';
      if (loginGroup)    loginGroup.hidden    = !config.showLogin;
      if (passwordGroup) passwordGroup.hidden = !config.showPassword;
      if (kategoriGroup) kategoriGroup.hidden = !config.showKategori;
      if (strengthCard)  strengthCard.hidden  = !config.showPassword;
      if (pageGenerator) {
        pageGenerator.classList.add('is-collapsed');
        pageGenerator.setAttribute('aria-hidden', 'true');
        generateBtn?.setAttribute('aria-expanded', 'false');
      }

      const genIcon = generateBtn?.querySelector('i');
      if (genIcon) genIcon.className = 'fa-solid fa-wand-magic-sparkles fa-xs';

      if (isimLabel)     isimLabel.textContent    = config.isim;
      if (loginLabel    && config.login)    loginLabel.textContent    = config.login;
      if (passwordLabel && config.password) passwordLabel.textContent = config.password;
      if (commentLabel)  commentLabel.textContent  = config.comment;

      if (commentInput) {
        commentInput.rows        = config.commentRows || 3;
        commentInput.placeholder = config.commentPlaceholder || 'Notlar…';
        commentInput.required    = Boolean(config.commentRequired);
      }

      el('website_url') && (el('website_url').disabled = kayitTipiSelect.value !== 'Website');
      el('login')       && (el('login').disabled       = !config.showLogin);
      el('page-password') && (el('page-password').disabled = !config.showPassword);
    };

    toggleFormFields();
    kayitTipiSelect.addEventListener('change', toggleFormFields);
  }

}