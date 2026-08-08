/**
 * ŞifreKasam v2.6.3-beta.3 - Index / Kart Listesi modülü (ES Module)
 *
 * 9. bölüm: kart arama/filtreleme, sayfalama, geçmiş modalı,
 * silme onayı, pin toggle ve tepsi ayarı.
 * initVaultIndex, app.js içindeki DOMContentLoaded sırasında çağrılır.
 */

export function initVaultIndex({
  apiFetch,
  apiJson,
  apiPost,
  showToast,
  showWarningToast,
  TOAST_BASE,
  createStatusNode,
  createIcon,
  createIconButton,
  copyToClipboard,
  kasaModalAc,
  refreshStatsBar,
}) {

  if (document.getElementById('card-container')) {

    const cardContainer = document.getElementById('card-container');
    const searchInput   = document.getElementById('search-input');
    const categoryBtns  = document.querySelectorAll('#category-filter button');
    const filterEmptyState = document.getElementById('filter-empty-state');
    const paginationNav = document.getElementById('card-pagination');
    const paginationSummary = document.getElementById('card-pagination-summary');
    const pagePrevButton = document.getElementById('card-page-prev');
    const pageNextButton = document.getElementById('card-page-next');
    const pageNumbers = document.getElementById('card-page-numbers');
    const pageJumpInput = document.getElementById('card-page-input');
    const pageJumpButton = document.getElementById('card-page-go');
    const CARD_PAGE_SIZE = 50;
    let currentCardPage = 1;
    let currentCardPageCount = 1;
    let cardCache = [];
    const getCards = () => Array.from(document.querySelectorAll('.card-wrapper'));

    const normalizeSearchText = (value) =>
      String(value || '').toLocaleLowerCase(window.LANG || 'tr').trim();

    const createCardCacheItem = (wrapper) => ({
      wrapper,
      searchText: normalizeSearchText(wrapper.textContent),
      type: wrapper.dataset.type || '',
      pinned: wrapper.dataset.pinned === 'true',
    });

    const rebuildCardCache = () => {
      cardCache = getCards().map(createCardCacheItem);
    };

    const updateCachedCard = (wrapper) => {
      const index = cardCache.findIndex(item => item.wrapper === wrapper);
      if (index >= 0) cardCache[index] = createCardCacheItem(wrapper);
    };

    const goToCardPage = (requestedPage) => {
      const normalizedPage = String(requestedPage ?? '').trim();
      const numericPage = Number(normalizedPage);
      const validPage = normalizedPage
        && Number.isInteger(numericPage)
        && numericPage >= 1
        && numericPage <= currentCardPageCount;
      if (!validPage) {
        pageJumpInput?.classList.add('kasa-field-invalid');
        pageJumpInput?.setAttribute('aria-invalid', 'true');
        pageJumpInput?.focus();
        pageJumpInput?.select();
        showWarningToast(
          `${window._('Geçersiz sayfa.')} ${window._('Geçerli sayfa aralığı:')} 1–${currentCardPageCount}.`
        );
        return;
      }

      currentCardPage = numericPage;
      if (pageJumpInput) {
        pageJumpInput.value = '';
        pageJumpInput.classList.remove('kasa-field-invalid');
        pageJumpInput.removeAttribute('aria-invalid');
      }
      filterCards({ preservePage: true, animate: true, scrollToGrid: true });
    };

    const setCardVisible = (wrapper, visible, animate = false) => {
      const wasHidden = wrapper.hidden;
      wrapper.hidden = !visible;

      if (visible && animate && wasHidden) {
        wrapper.classList.remove('filter-reveal');
        void wrapper.offsetWidth;
        wrapper.classList.add('filter-reveal');
      } else if (!visible) {
        wrapper.classList.remove('filter-reveal');
      }
    };

    const createPageControl = (page, label = String(page), isActive = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `card-page-btn${isActive ? ' active' : ''}`;
      button.textContent = label;
      button.setAttribute('aria-label', `${window._('Sayfa')} ${page}`);
      button.setAttribute('aria-current', isActive ? 'page' : 'false');
      button.addEventListener('click', () => goToCardPage(page));
      return button;
    };

    const createPageDots = () => {
      const dots = document.createElement('span');
      dots.className = 'card-page-dots';
      dots.textContent = '…';
      return dots;
    };

    const renderPagination = (matchedCount, pageCount, startIndex, endIndex) => {
      if (!paginationNav || !paginationSummary || !pageNumbers) return;

      const shouldShow = matchedCount > CARD_PAGE_SIZE;
      paginationNav.hidden = !shouldShow;
      currentCardPageCount = pageCount;
      if (pageJumpInput) pageJumpInput.max = String(pageCount);
      if (!shouldShow) return;

      paginationSummary.textContent = `${startIndex + 1}-${endIndex} / ${matchedCount} ${window._('kayıt gösteriliyor')}`;

      if (pagePrevButton) {
        pagePrevButton.disabled = currentCardPage <= 1;
        pagePrevButton.setAttribute('aria-disabled', String(currentCardPage <= 1));
      }
      if (pageNextButton) {
        pageNextButton.disabled = currentCardPage >= pageCount;
        pageNextButton.setAttribute('aria-disabled', String(currentCardPage >= pageCount));
      }

      pageNumbers.replaceChildren();
      const pages = new Set([1, pageCount]);
      for (let page = currentCardPage - 1; page <= currentCardPage + 1; page++) {
        if (page >= 1 && page <= pageCount) pages.add(page);
      }
      const orderedPages = Array.from(pages).sort((a, b) => a - b);
      orderedPages.forEach((page, index) => {
        if (index > 0 && page - orderedPages[index - 1] > 1) {
          pageNumbers.appendChild(createPageDots());
        }
        pageNumbers.appendChild(createPageControl(page, String(page), page === currentCardPage));
      });
    };

    const filterCards = ({ preservePage = false, animate = false, scrollToGrid = false } = {}) => {
      const term = normalizeSearchText(searchInput?.value || '');
      const activeBtn = document.querySelector('#category-filter button.active');
      const category  = activeBtn?.dataset.filter || 'all';
      const matchedCards = cardCache.filter(({ searchText, type, pinned }) => {
        const matchesSearch = !term || searchText.includes(term);
        const matchesCategory =
          category === 'all'       ? true :
          category === 'favorites' ? pinned :
                                     type === category;
        return matchesSearch && matchesCategory;
      });
      const pageCount = Math.max(1, Math.ceil(matchedCards.length / CARD_PAGE_SIZE));
      currentCardPage = preservePage ? Math.min(currentCardPage, pageCount) : 1;
      const startIndex = (currentCardPage - 1) * CARD_PAGE_SIZE;
      const endIndex = Math.min(startIndex + CARD_PAGE_SIZE, matchedCards.length);
      const visibleWrappers = new Set(
        matchedCards.slice(startIndex, endIndex).map(item => item.wrapper)
      );

      let anyCardBecameVisible = false;
      cardCache.forEach(({ wrapper }) => {
        const willShow = visibleWrappers.has(wrapper);
        if (willShow && wrapper.hidden) anyCardBecameVisible = true;
        setCardVisible(wrapper, willShow, animate);
      });

      /* Tekrar görünen kartların buğusu (liquid-glass SVG filter'ı)
         debounce beklemeden anında uygulansın; aksi halde ilk karede
         buğusuz görünüp ~120-200ms sonra buğulanır ("2 kez yükleme"). */
      if (anyCardBecameVisible) {
        window.dispatchEvent(new CustomEvent('kasa:glass-refresh'));
      }

      if (filterEmptyState) {
        const shouldShowEmptyState = cardCache.length > 0 && matchedCards.length === 0;
        filterEmptyState.hidden = !shouldShowEmptyState;
        filterEmptyState.classList.toggle('is-visible', shouldShowEmptyState);
      }

      renderPagination(matchedCards.length, pageCount, startIndex, endIndex);
      window.dispatchEvent(new CustomEvent('kasa:cards-page-changed'));
      if (scrollToGrid) {
        const reduceMotion = document.documentElement.getAttribute('data-kasa-animations') === 'off'
          || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('card-container')?.scrollIntoView({
          behavior: reduceMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };

    const animateCategoryTransition = (activeButton) => {
      activeButton.classList.remove('filter-activating');
      void activeButton.offsetWidth;
      activeButton.classList.add('filter-activating');
      activeButton.addEventListener('animationend', () => {
        activeButton.classList.remove('filter-activating');
      }, { once: true });

      const motionDisabled = document.documentElement.dataset.kasaMotion === 'off'
        || document.documentElement.dataset.kasaAnimations === 'off'
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!cardContainer || motionDisabled) return;
      cardContainer.getAnimations().forEach(animation => animation.cancel());
      cardContainer.animate(
        [
          { opacity: 0.68, transform: 'translateY(5px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 240, easing: 'cubic-bezier(0.16,1,0.3,1)' },
      );
    };

    rebuildCardCache();
    filterCards({ preservePage: false, animate: false });

    let searchTimeout;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => filterCards({ preservePage: false, animate: true }), 120);
    });

    pagePrevButton?.addEventListener('click', () => {
      if (currentCardPage <= 1) return;
      goToCardPage(currentCardPage - 1);
    });

    pageNextButton?.addEventListener('click', () => {
      goToCardPage(currentCardPage + 1);
    });

    const submitPageJump = () => goToCardPage(pageJumpInput?.value);
    pageJumpButton?.addEventListener('click', submitPageJump);
    pageJumpInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitPageJump();
    });
    pageJumpInput?.addEventListener('input', () => {
      pageJumpInput.classList.remove('kasa-field-invalid');
      pageJumpInput.removeAttribute('aria-invalid');
    });

    categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        categoryBtns.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        filterCards({ preservePage: false, animate: false });
        animateCategoryTransition(btn);
      });
    });

    // Geçmiş Modal
    const historyList = document.getElementById('history-list');
    document.querySelectorAll('.history-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const kayitId = btn.dataset.id;
        if (!kayitId) return;

        if (historyList) {
          historyList.replaceChildren(
            createStatusNode(window._('Yükleniyor...'), 'p-3 text-center text-kasa-text-muted', 'fa-solid fa-spinner fa-spin mr-2')
          );
        }
        kasaModalAc('historyModal');

        try {
          const data = await apiJson(`/gecmis/${encodeURIComponent(kayitId)}`);
          if (!historyList) return;
          if (!Array.isArray(data) || !data.length) {
            historyList.replaceChildren(
              createStatusNode(window._('Henüz geçmiş kaydı yok.'))
            );
            return;
          }

          const fragment = document.createDocumentFragment();
          data.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = `history-entry history-delay-${Math.min(index, 8)}`;

            const header = document.createElement('div');
            header.className = 'history-entry-header';
            const time = document.createElement('small');
            time.className = 'history-entry-time';
            time.append(createIcon('fa-regular fa-clock me-1'), document.createTextNode(item.date || ''));
            header.appendChild(time);

            const body = document.createElement('div');
            body.className = 'history-secret-row';

            const input = Object.assign(document.createElement('input'), {
              type: 'password',
              className: 'history-secret-input',
              value: item.password || '',
              readOnly: true,
            });

            const toggleBtn = createIconButton(window._('Göster/Gizle'), 'fa-solid fa-eye');
            toggleBtn.classList.add('history-icon-btn');
            toggleBtn.addEventListener('click', () => {
              const hidden = input.type === 'password';
              input.type = hidden ? 'text' : 'password';
              toggleBtn.querySelector('i').className =
                hidden ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
            });

            const copyBtn = createIconButton(window._('Kopyala'), 'fa-solid fa-copy');
            copyBtn.addEventListener('click', () => copyToClipboard(input.value, copyBtn.querySelector('i')));
            copyBtn.classList.add('history-icon-btn', 'copy-btn-history');

            body.append(input, toggleBtn, copyBtn);
            div.append(header, body);
            fragment.appendChild(div);
          });

          historyList.replaceChildren(fragment);
        } catch {
          if (historyList) {
            historyList.replaceChildren(
              createStatusNode(window._('Yükleme hatası oluştu.'), 'p-3 text-center text-danger')
            );
          }
        }
      });
    });

    // Silme Onayı (SweetAlert2)
    const SWAL_BASE = {
      heightAuto: false, scrollbarPadding: false,
      color: 'var(--text)', buttonsStyling: false,
      customClass: {
        popup: 'kasa-swal-popup', title: 'kasa-swal-title',
        htmlContainer: 'kasa-swal-text', actions: 'kasa-swal-actions',
        confirmButton: 'kasa-btn kasa-btn-danger',
        cancelButton: 'kasa-btn kasa-btn-muted',
      },
      willOpen: (popup, container) => {
        popup.classList.add('kasa-swal-enter');
        container.classList.add('kasa-swal-container');
      },
      didOpen: (popup, container) => {
        void container.offsetHeight;
        popup.classList.add('is-open');
        container.classList.add('is-open');
      },
      willClose: (popup, container, done) => {
        popup.classList.add('is-closing');
        container.classList.add('is-closing');
        setTimeout(done, 150);
      },
    };

    document.querySelectorAll('.delete-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (form.dataset.pending === 'true') return;
        const { isConfirmed } = await Swal.fire({
          ...SWAL_BASE,
          title: window._('Emin misiniz?'),
          text: window._('Bu kayıt tamamen silinecek ve geri alınamaz!'),
          icon: 'warning',
          showCancelButton: true,
          confirmButtonText: window._('Evet, Sil!'),
          cancelButtonText: window._('İptal'),
        });
        if (!isConfirmed) return;
        const wrapper = form.closest('.card-wrapper');
        form.dataset.pending = 'true';
        wrapper?.classList.add('is-removing');
        const removalReady = new Promise(resolve => {
          setTimeout(resolve, wrapper ? 180 : 0);
        });
        try {
          const response = await apiFetch(form.action, {
            method: 'POST',
            headers: { Accept: 'application/json' },
          });
          if (!response?.ok) throw new Error('delete-failed');
          if (wrapper) {
            await removalReady;
            wrapper.remove();
            rebuildCardCache();
            filterCards({ preservePage: true, animate: true });
          }
          refreshStatsBar();
          showToast({
            ...TOAST_BASE,
            text: window._('Kayıt başarıyla silindi.'),
            duration: 2500,
            className: 'kasa-toast kasa-toast-warning',
          });
        } catch {
          wrapper?.classList.remove('is-removing');
          showWarningToast(window._('Silme işlemi başarısız oldu.'));
        } finally {
          delete form.dataset.pending;
        }
      });
    });

    // Pin Toggle
    document.querySelectorAll('.pin-form').forEach(form => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const icon = form.querySelector('.card-star-icon');
        const button = form.querySelector('.card-star-btn');
        const wrapper = form.closest('.card-wrapper');
        if (!icon || !button || !wrapper || form.dataset.pending === 'true') return;

        const originalPinned = wrapper.dataset.pinned === 'true';
        const applyPinnedState = (isPinned, animate = true) => {
          wrapper.dataset.pinned = String(isPinned);
          icon.className = isPinned
            ? 'fa-solid fa-star card-star-icon'
            : 'fa-regular fa-star card-star-icon card-star-unpinned';
          icon.classList.toggle('is-pinned', isPinned);
          button.setAttribute('aria-pressed', String(isPinned));
          button.classList.remove('is-favoriting', 'is-unfavoriting');
          if (animate) {
            void button.offsetWidth;
            button.classList.add(isPinned ? 'is-favoriting' : 'is-unfavoriting');
            window.setTimeout(() => {
              button.classList.remove('is-favoriting', 'is-unfavoriting');
            }, 560);
          }
          updateCachedCard(wrapper);
        };

        const refreshFavoritesFilter = () => {
          const activeButton = document.querySelector('#category-filter button.active');
          if (activeButton?.dataset.filter === 'favorites') {
            filterCards({ preservePage: true, animate: true });
          }
        };

        form.dataset.pending = 'true';
        applyPinnedState(!originalPinned);
        refreshFavoritesFilter();
        try {
          const response = await apiFetch(form.action, { method: 'POST' });
          if (!response?.ok) throw new Error('pin-failed');
          refreshStatsBar();
        } catch {
          applyPinnedState(originalPinned, false);
          refreshFavoritesFilter();
          showWarningToast(window._('İşlem tamamlanamadı.'));
        } finally {
          delete form.dataset.pending;
        }
      });
    });

    // Tepsi Ayarı
    const trayToggle = document.getElementById('setting-minimize-to-tray');
    if (trayToggle) {
      apiJson('/settings/tray')
        .then(data => { trayToggle.checked = data.minimize_to_tray; })
        .catch(() => {});

      trayToggle.addEventListener('change', () =>
        apiPost('/settings/tray', { minimize_to_tray: trayToggle.checked })
      );
    }

    // Ekran Yakalamayı Engelle
    const contentProtectionToggle = document.getElementById('setting-content-protection');
    if (contentProtectionToggle) {
      const isLinux = /Linux/i.test(navigator.userAgent || '')
        || (navigator.platform || '').toLowerCase().includes('linux');
      if (isLinux) {
        contentProtectionToggle.disabled = true;
        const linuxNote = document.getElementById('content-protection-linux-note');
        if (linuxNote) linuxNote.hidden = false;
      }

      apiJson('/settings/content-protection')
        .then(data => { contentProtectionToggle.checked = data.content_protection_enabled; })
        .catch(() => {});

      contentProtectionToggle.addEventListener('change', () =>
        apiPost('/settings/content-protection', { content_protection_enabled: contentProtectionToggle.checked })
      );
    }
  }

}