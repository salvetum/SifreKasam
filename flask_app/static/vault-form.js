/**
 * ŞifreKasam v2.7.0-beta.3 - Ekle / Düzenle Formu modülü (ES Module)
 *
 * 10. bölüm: kayıt tipine göre alan gösterimi, şifre üretici
 * açma/kapama davranışı ve form geçiş animasyonu.
 * initVaultForm, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

import { copyToClipboard } from './reveal-copy.js';

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

    // ── Alan varlık motoru v3: Web Animations API, fill'siz ────────────
    // fill:'forwards' KULLANILMAZ: haritadan düşen bir çıkış animasyonu
    // opaklığı sonsuza dek 0'da kilitleyebiliyordu. Dolgu olmadan hiçbir
    // animasyon değer sabileyemez; gizleme kararı _kasaWantHidden
    // bayrağıyla verilir. Cam güvenliği: yalnız opacity animasyonu.
    const FIELD_SWIFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const FIELD_EXIT = 'cubic-bezier(0.4, 0, 0.2, 1)';
    const formMotionOff = () => document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // A1 yukseklik katmani yardimcilari
    const COLLAPSE_MS = 300;
    const ensureClip = (el) => {
      if (el._kasaClip && el.firstElementChild === el._kasaClip) return el._kasaClip;
      const clip = document.createElement('div');
      clip.className = 'kasa-field-clip';
      while (el.firstChild) clip.appendChild(el.firstChild);
      el.appendChild(clip);
      el.classList.add('kasa-collapsible');
      el._kasaClip = clip;
      return clip;
    };
    const setExpanded = (el, expanded) => el.classList.toggle('is-expanded', expanded);

    // Bolum yutma: bolum tamamen gizlenirken icindeki alanlara tek tek
    // animasyon yapmak cakisma kaynagidir; aninda hedef duruma cekilir,
    // bolum kendi cokusuyle tasiyor.
    const setPresenceInstant = (el, show) => {
      if (!el) return;
      if (el._kasaAnim) { el._kasaAnim.cancel(); el._kasaAnim = null; }
      clearTimeout(el._kasaCollapseT);
      el._kasaWantHidden = !show;
      if (el.dataset.collapse === 'height') {
        ensureClip(el);
        el.hidden = !show;
        setExpanded(el, show);
        if (!show) el._kasaEverAnimated = false;
      } else {
        el.hidden = !show;
        el.style.opacity = '';
      }
    };

    const animateToggle = (el, show) => {
      if (!el) return;

      // ── HEIGHT kolonu v5: İKİ FAZLI ──────────────────────────────
      // Cam inputlar GÖRÜNÜRKEN boyut değiştirmek her karede yeniden
      // örnekleme yapar → smear + bitişte snap. Bu yüzden:
      //   GİZLE: içerik 110ms'de söner → boş kabuk 100ms lineer çöker
      //   AÇ:    boş kabuk 100ms'de açılır → içerik 150ms'de belirir
      // Toplam ~210-250ms; cam asla görünürken resize olmaz.
      if (el.dataset.collapse === 'height') {
        const clip = ensureClip(el);
        if (el._kasaAnim) { el._kasaAnim.cancel(); el._kasaAnim = null; }
        clearTimeout(el._kasaCollapseT);

        const sizePhase = () => {
          el.classList.add('kasa-size-anim');
          return new Promise(res => setTimeout(res, 120));
        };
        const endSizePhase = () => {
          // steady state: gecis yok, class temiz
          el.classList.remove('kasa-size-anim');
        };

        if (show) {
          el._kasaWantHidden = false;
          const wasHidden = el.hidden;
          el.hidden = false;
          setExpanded(el, false);           // 0fr baslangic
          if (formMotionOff() || !wasHidden) {
            setExpanded(el, true);
            el._kasaEverAnimated = true;
            return;
          }
          void el.offsetHeight;             // 0fr'i kilitle
          setExpanded(el, true);            // KABUK acilir (110ms lineer)
          sizePhase().then(() => {
            endSizePhase();
            if (!el._kasaWantHidden && !el.hidden) {
              el._kasaAnim = clip.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: 150, easing: FIELD_SWIFT }
              );
            }
          });
          return;
        }

        if (el.hidden) return;
        el._kasaWantHidden = true;
        if (formMotionOff()) {
          el.hidden = true;
          setExpanded(el, false);
          return;
        }
        // FAZ 1: icerik hizla söner (cam gorunurken sadece opaklik)
        el._kasaAnim = clip.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: 110, easing: FIELD_EXIT }
        );
        el._kasaAnim.finished.catch(() => {}).then(() => {
          if (!el._kasaWantHidden) return;
          // FAZ 2: bos kabuk coker (cam artik gorunmez)
          sizePhase().then(() => {
            if (!el._kasaWantHidden) { endSizePhase(); return; }
            el.hidden = true;
            setExpanded(el, false);
            endSizePhase();
            if (el._kasaAnim) { el._kasaAnim.cancel(); el._kasaAnim = null; }
          });
        });
        return;
      }


      // ── OPACITY kolonu (row-two üyeleri vb.) ──
      if (el._kasaAnim) {
        el._kasaAnim.cancel();
        el._kasaAnim = null;
      }

      if (show) {
        const wasHidden = el.hidden;
        el.hidden = false;
        if (formMotionOff()) return;
        const from = wasHidden ? 0 : +(+getComputedStyle(el).opacity).toFixed(2);
        el._kasaAnim = el.animate(
          [{ opacity: from }, { opacity: 1 }],
          { duration: wasHidden ? 180 : 140, easing: FIELD_SWIFT }
        );
        return;
      }

      if (el.hidden) return;
      if (formMotionOff()) {
        el.hidden = true;
        return;
      }
      el._kasaWantHidden = true;
      const exitAnim = el.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 130, easing: FIELD_EXIT }
      );
      el._kasaAnim = exitAnim;
      exitAnim.finished.then(() => {
        if (el._kasaWantHidden && el._kasaAnim === exitAnim) {
          el.hidden = true;
        }
      }).catch(() => {});
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

    // Üreticinin solundaki kopyala düğmesi: şifreye tıklanabilir kopyalama.
    const passwordCopyBtn = el('page-copy-btn');
    const passwordLine = passwordGroup ? passwordGroup.querySelector('.vault-password-line') : null;
    const formEl = document.getElementById('ekle-form');
    if (passwordCopyBtn) {
    // A2: gönderim kilidi + spinner (ekle.html inline'dan taşındı)
    const saveBtnEl = document.getElementById('save-btn');
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

      passwordCopyBtn.addEventListener('click', async () => {
        const value = passwordInput ? passwordInput.value : '';
        if (!value) return;
        await copyToClipboard(value, passwordCopyBtn.querySelector('i'));
      });
    }

    const toggleFormFields = () => {
      try {
      const config = FIELD_CONFIGS[kayitTipiSelect.value] || FIELD_CONFIGS.default;
      const isCard = kayitTipiSelect.value === 'CreditCard';

      // Bölüm yutma: access bölümü tamamen gizlenecekse içindeki alanlara
      // tek tek animasyon yapma — instant hedef duruma çek, bölüm kendi
      // çöküşüyle taşısın. Bölüm geri açılırken de alanlar animasyonsuz
      // doğru durumda hazır olur, açılış temiz olur.
      const swallowAccess = config.showAccess === false;
      const accessField = (el, desired) => {
        if (!el) return;
        if (swallowAccess) setPresenceInstant(el, false);
        else animateToggle(el, desired);
      };

      if (urlGroup)      animateToggle(urlGroup, kayitTipiSelect.value === 'Website');
      if (kategoriGroup) animateToggle(kategoriGroup, config.showKategori);
      if (cardHolderGroup) animateToggle(cardHolderGroup, isCard);
      if (cardTripleRow) cardTripleRow.classList.toggle('is-active', isCard);

      accessField(loginGroup, config.showLogin);
      accessField(emailGroup, config.showEmail);
      accessField(passwordGroup, config.showPassword);
      if (strengthCard) {
        if (swallowAccess) setPresenceInstant(strengthCard, false);
        else animateToggle(strengthCard, config.showPassword && !isCard);
      }
      if (accessSection) animateToggle(accessSection, config.showAccess);

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
