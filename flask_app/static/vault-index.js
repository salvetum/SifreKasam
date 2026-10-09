/**
 * ŞifreKasam v2.7.0-beta.4 - Index / Kart Listesi modülü (ES Module)
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
  applyAppearance,
  applyGlassQuality,
  getCurrentBackground,
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

    // ── İstatistik filtresi durumu (zayıf / eski / süresi dolmuş) ──
    const statsChips = document.querySelectorAll('#stats-bar .stats-filter-chip');
    let statsFilter = null;
    let vaultStats = { zayif_ids: [], eski_ids: [], expired_ids: [] };
    let statsLoadPromise = null;
    /* /api/stats isteğinin sahibi app.js'teki refreshStatsBar (aynı yanıtla
       istatistik barını da boyar). Burada ikinci bir fetch açmıyoruz. */
    const loadStats = () => (typeof refreshStatsBar === 'function'
      ? refreshStatsBar()
      : apiJson('/api/stats').catch(() => null));

    const normalizeSearchText = (value) =>
      String(value || '').toLocaleLowerCase(window.LANG || 'tr').trim();

    // Arama alanı seçimi: hangi alana göre daraltılacak.
    // `Tümü` = mevcut davranış (kartın görünen tüm metni).
    // Boş metin her zaman "hepsi eşleşir" — alan seçimi tek başına FİLTRE değil,
    // yalnızca yazılan metni daraltır (aksi halde boş arama kutusu kasa boş
    // gösterirdi).
    const SEARCH_FIELD_ALL = 'all';
    const SEARCH_FIELD_STORAGE_KEY = 'kasa-search-field';
    // Alan etiketleri `kayit.normalized.detaylar` anahtarlarıdır (Türkçe).
    // Kart DOM'unda her satırda `title` attribute'u HAM anahtarı taşır
    // (bkz. card-grid.html) — etiket METNİ çevrilmiş olabilir, bu yüzden
    // eşleştirme `title`'dan yapılır.
    const SEARCH_FIELD_KEYS = {
      title: [],
      username: ['Kullanıcı Adı', 'Kullanıcı adı', 'Username'],
      email: ['E-posta', 'Eposta', 'E-Mail', 'Email'],
      note: ['Not'],
      card: ['Kart Numarası', 'Kart Numarasi', 'Kart No', 'Kartno'],
    };
    const SEARCH_FIELD_ORDER = ['all', 'title', 'username', 'email', 'note', 'card'];

    const getActiveSearchField = () => {
      const select = document.getElementById('search-field-select');
      const value = select?.value || '';
      return SEARCH_FIELD_ORDER.includes(value) ? value : SEARCH_FIELD_ALL;
    };

    // Kartın alan-bazlı arama indeksi. Sır SIZINTISI YAPMAZ: değerler yalnız
    // kartta ZATEN görünen metinden (`textContent`) okunur. Şifre/CVV satırı
    // zaten maskeli (`••••••••`), LAN'da gizlenen alanlar (kart no, kart ismi,
    // not) boş string basar → burada da boş kalır. Yeni `data-*` özniteliği
    // DOM'a düz metin sokmak bu garantiyi bozardu; kasıtlı olarak yapılmadı.
    const buildCardFields = (wrapper) => {
      const fields = [];
      wrapper.querySelectorAll('.vault-detail-row').forEach((row) => {
        const labelEl = row.querySelector('.vault-detail-label');
        const valueEl = row.querySelector('.vault-detail-value');
        if (!labelEl || !valueEl) return;
        // title = ham alan adı (çeviri bağımsız); yoksa metne düş.
        const key = (labelEl.getAttribute('title') || labelEl.textContent || '').trim();
        const value = (valueEl.textContent || '').trim();
        if (!key || !value) return;
        fields.push({
          key,
          haystack: normalizeSearchText(`${key} ${value}`),
        });
      });
      return fields;
    };

    // Kartın etiketleri. 🔴 Yeni `data-*` özniteliği YOK: etiket adları
    // kartta zaten düz metin olarak görünüyor (metadata sınıfı, `category`
    // ile aynı), dolayısıyla tek doğruluk kaynağı `textContent` ve filtre
    // değerini DOM'dan türetmek sır yüzeyini genişletmez. Etiketler
    // `normalizeSearchText` ile karşılaştırılır (Türkçe küçük harf uyumlu).
    const buildCardTags = (wrapper) =>
      Array.from(wrapper.querySelectorAll('.vault-card-tag'))
        .map(el => normalizeSearchText(el.textContent))
        .filter(Boolean);

    const createCardCacheItem = (wrapper) => ({
      wrapper,
      id: wrapper.dataset.id || '',
      // `searchText` korunuyor: geriye uyum + "Tümü" modu birebir mevcut
      // davranış. Alan-bazlı modlar `fields`/`titleText` kullanır.
      searchText: normalizeSearchText(wrapper.textContent),
      titleText: normalizeSearchText(
        wrapper.querySelector('.vault-card-title')?.textContent || ''
      ),
      fields: buildCardFields(wrapper),
      tags: buildCardTags(wrapper),
      type: wrapper.dataset.type || '',
      pinned: wrapper.dataset.pinned === 'true',
    });

    // ── Etiket filtresi ────────────────────────────────────────────────
    // Çoklu seçim VE mantığı: seçili etiketlerin HEPSİne sahip kart kalır.
    // Boş küme = filtre yok. Kart sayfası DOM sırasına göre dilimlendiği
    // için (bkz. `CARD_PAGE_SIZE`) etiket filtresi de istemci tarafında
    // `filterCards` içinde uygulanır; sunucu tarafında etiket arama yok.
    const activeTags = new Set();
    const tagFilterBar = document.getElementById('tag-filter-bar');
    const tagFilterChips = document.getElementById('tag-filter-chips');
    const tagFilterClear = document.getElementById('tag-filter-clear');

    const matchesActiveTags = (item) => {
      if (!activeTags.size) return true;
      return Array.from(activeTags).every(tag => item.tags.includes(tag));
    };

    // Kart üzerindeki rozetler, seçili etiketi görsel olarak gösterir
    // (`aria-pressed` birlikte) — aynı filtre iki yerden de değiştirilebilir.
    // 🔴 `renderTagFilterBar` BUNDAN SONRA tanımlanıyor ama onu çağırıyor:
    // `const` arrow function'lar tanım satırına gelene kadar TDZ'de olduğu
    // için (geçici ölü bölge) önceden çağrılırsa `ReferenceError` verir.
    // Bu istisna `rebuildCardCache()` → `initVaultIndex` zincirinde
    // `finishInitialReveal` planlanmadan ÖNCE patlarsa `.vault-card-curtain`
    // hiç kalkmaz ve kartların HİÇBİRİ görünmez. Sıralama bu yüzden şart.
    const syncTagBadges = () => {
      getCards().forEach(wrapper => {
        wrapper.querySelectorAll('.vault-card-tag').forEach(el => {
          const isActive = activeTags.has(normalizeSearchText(el.textContent));
          el.classList.toggle('is-active', isActive);
          el.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      });
    };

    // Çubuk, kart önbelleğinden türetilir: her etiketin kaç kartta
    // geçtiği sayılır ve alfabetik sırayla listelenir. Böylece ayrı bir
    // "/api/tags" ucuna ve şablona veri taşımaya gerek kalmaz.
    const renderTagFilterBar = () => {
      if (!tagFilterBar || !tagFilterChips) return;
      const counts = new Map();
      cardCache.forEach(({ tags }) => {
        new Set(tags).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
      });
      // Seçili ama artık hiçbir kartta bulunmayan etiket kaybolmasın
      // (kayıt silindiyse seçim de düşmeli değil, kullanıcı temizleyebilsin).
      activeTags.forEach(tag => { if (!counts.has(tag)) counts.set(tag, 0); });

      const entries = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0], window.LANG || 'tr'));
      if (!entries.length) {
        tagFilterBar.hidden = true;
        tagFilterChips.replaceChildren();
        return;
      }
      tagFilterBar.hidden = false;
      tagFilterChips.replaceChildren(...entries.map(([tag, count]) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tag-filter-chip';
        const isActive = activeTags.has(tag);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        chip.classList.toggle('is-active', isActive);
        chip.title = `${tag} (${count})`;
        // Etiket metnini `data-*` YAZMADAN taşımak için doğrudan özellik:
        // rozet içindeki sayı `textContent`'e karışıp etiketi bozmasın
        // ("2024" etiketi `replace(/\d+$/,'')` ile boşa düşüyordu) ve DOM'a
        // yeni düz metin özniteliği girmesin (bkz. `buildCardTags` notu).
        chip.tagValue = tag;
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-tag';
        icon.setAttribute('aria-hidden', 'true');
        chip.append(icon, document.createTextNode(` ${tag}`));
        if (count) {
          const badge = document.createElement('span');
          badge.className = 'tag-filter-count';
          badge.textContent = String(count);
          chip.appendChild(badge);
        }
        return chip;
      }));
      if (tagFilterClear) tagFilterClear.hidden = activeTags.size === 0;
      syncTagBadges();
    };

    const toggleTag = (tag) => {
      if (activeTags.has(tag)) activeTags.delete(tag);
      else activeTags.add(tag);
      renderTagFilterBar();
      filterCards({ preservePage: false });
    };

    const clearTags = () => {
      activeTags.clear();
      renderTagFilterBar();
      filterCards({ preservePage: false });
    };

    // "E-posta yazdım ama 'Kart Numarası' modundayım" gibi yanlış-mod
    // sonuçlarını önlemek için: seçili alanın modu, kartın alanları arasında
    // karşılığı varsa ve O ALANDA değer yoksa eşleşme sayılmaz.
    const matchesSearchTerm = (item, term, mode) => {
      if (!term) return true;
      if (mode === SEARCH_FIELD_ALL) return item.searchText.includes(term);
      if (mode === 'title') return item.titleText.includes(term);

      const keys = SEARCH_FIELD_KEYS[mode] || [];
      const hasModeField = item.fields.some((f) => keys.includes(f.key));
      if (!hasModeField) return false;
      return item.fields.some((f) => keys.includes(f.key) && f.haystack.includes(term));
    };

    const rebuildCardCache = () => {
      cardCache = getCards().map(createCardCacheItem);
      // Kart kümesi değişince etiket çubuğu da yeniden kurulur: yeni
      // kayıt eklenince etiketi, kayıt silinince etiketi kaybolur.
      renderTagFilterBar();
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
      cardContainer.classList.add('vault-card-curtain');
      filterCards({ preservePage: true, animate: false, scrollToGrid: true });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cardContainer.classList.remove('vault-card-curtain');
        });
      });
    };

    // ─── Kart görünürlüğü ────────────────────────────────────────────────────
    // `display:none` KULLANILMAZ. Chromium, display:none'dan dönen elemanda
    // backdrop-filter katmanını yeniden kurar ve ilk karede örnekleme yapmadan
    // boyar → kart önce buğusuz, sonra buğulu görünür. (Ölçülen belirti.)
    //
    // Bunun yerine kart render ağacından HİÇ çıkmaz: grid akışından çıkarmak
    // için position:absolute, görünmezlik için visibility:hidden. Katman canlı
    // kalır, yeniden kurulmaz, dolayısıyla flaş olmaz.
    //
    // 🔴 Giriş animasyonu BİLEREK YOK. İki deneme de başarısız oldu:
    //   1) rAF ile gizlemeyi ertelemek → bir kare daha camsız ekran.
    //   2) opaklık+transform animasyonu (`cardFilterReveal`) → animasyon
    //      `both` ile bittiği için kart `transform: translateY(0)` ile
    //      transform'lu kalıyor; transform backdrop örneklemeyi bozduğu için
    //      kart animasyon bittikten SONRA hâlâ yanlış örnekleniyor. Yani
    //      animasyon sorunu 180 ms uzatmakla değil, kalıcı hale getiriyordu.
    const isCardHidden = (wrapper) => wrapper.classList.contains('is-filtered-out');

    const setCardVisible = (wrapper, visible) => {
      wrapper.classList.toggle('is-filtered-out', !visible);
    };

    const reduceMotion = () =>
      document.documentElement.getAttribute('data-kasa-animations') === 'off'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
      if (shouldShow) {
        paginationNav.hidden = false;
        requestAnimationFrame(() => { paginationNav.classList.add('is-visible'); });
      } else {
        paginationNav.classList.remove('is-visible');
        setTimeout(() => { if (matchedCount <= CARD_PAGE_SIZE) paginationNav.hidden = true; }, 240);
      }
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

    // `animate` kasten kullanılmıyor (giriş animasyonu bilerek yok, yukarıya
    // bak). Çağıranların imzasını bozmamak için parametre korunuyor.
    const filterCards = ({ preservePage = false, animate = false, scrollToGrid = false } = {}) => {
      const term = normalizeSearchText(searchInput?.value || '');
      const searchField = getActiveSearchField();
      const activeBtn = document.querySelector('#category-filter button.active');
      const category  = activeBtn?.dataset.filter || 'all';
      const matchedCards = cardCache.filter((item) => {
        const { id, type, pinned } = item;
        const matchesSearch = matchesSearchTerm(item, term, searchField);
        const matchesCategory =
          category === 'all'       ? true :
          category === 'favorites' ? pinned :
                                     type === category;
        const matchesStats = !statsFilter
          ? true
          : statsFilter === 'zayif'   ? vaultStats.zayif_ids.includes(id)
          : statsFilter === 'eski'    ? vaultStats.eski_ids.includes(id)
          : statsFilter === 'expired' ? vaultStats.expired_ids.includes(id)
          : true;
        return matchesSearch && matchesCategory && matchesStats && matchesActiveTags(item);
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
        if (willShow && isCardHidden(wrapper)) anyCardBecameVisible = true;
        setCardVisible(wrapper, willShow);
      });

      if (filterEmptyState) {
        const shouldShowEmptyState = cardCache.length > 0 && matchedCards.length === 0;
        filterEmptyState.hidden = !shouldShowEmptyState;
        filterEmptyState.classList.toggle('is-visible', shouldShowEmptyState);
      }

      renderPagination(matchedCards.length, pageCount, startIndex, endIndex);
      window.dispatchEvent(new CustomEvent('kasa:cards-page-changed'));
      if (scrollToGrid) {
        document.getElementById('card-container')?.scrollIntoView({
          behavior: reduceMotion() ? 'auto' : 'smooth',
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

    // ── İstatistik filtresi (zayıf / eski / süresi dolmuş id'leri) ──
    const markWeakCards = () => {
      const weakSet = new Set((vaultStats.zayif_ids || []).map(String));
      // kartCache zaten {wrapper,id,...} taşıyor → tam DOM sorgusu gereksiz
      cardCache.forEach(({ wrapper }) => {
        const chip = wrapper.querySelector('.card-weak-chip');
        const isWeak = weakSet.has(String(wrapper.dataset.id || ''));
        if (chip) chip.hidden = !isWeak;
        wrapper.classList.toggle('card-is-weak', isWeak);
      });
    };

    const refreshStatChips = () => {
      const counts = {
        zayif: (vaultStats.zayif_ids || []).length,
        eski: (vaultStats.eski_ids || []).length,
        expired: (vaultStats.expired_ids || []).length,
      };
      statsChips.forEach(chip => {
        const filter = chip.dataset.statFilter;
        if (filter === 'zayif' || filter === 'eski' || filter === 'expired') {
          const isZero = counts[filter] === 0;
          chip.classList.toggle('stats-chip-zero', isZero);
          chip.setAttribute('aria-disabled', isZero ? 'true' : 'false');
        }
      });
    };

    const ensureStats = (force = false) => {
      if (statsLoadPromise && !force) return statsLoadPromise;
      statsLoadPromise = loadStats()
        .then(data => {
          if (!data) throw new Error('stats-load-failed');
          vaultStats = {
            zayif_ids: (data && Array.isArray(data.zayif_ids)) ? data.zayif_ids : [],
            eski_ids: (data && Array.isArray(data.eski_ids)) ? data.eski_ids : [],
            expired_ids: (data && Array.isArray(data.expired_ids)) ? data.expired_ids : [],
          };
          markWeakCards();
          refreshStatChips();
        })
        .catch(() => { statsLoadPromise = null; return undefined; });
      return statsLoadPromise;
    };

    const clearStatsFilter = () => {
      statsFilter = null;
      statsChips.forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
      });
    };

    const activateCategory = (filter) => {
// Etiket filtresi olayları. Üç giriş noktası aynı `toggleTag`'e gider:
    // çubuktaki çip, kart üzerindeki rozet ve "temizle" düğmesi. Çip
    // dinleyicisi DELEGATED (çipler her yeniden kurulumda değişiyor), kart
    // rozet dinleyicisi de delegated (kayıtlar yeniden render edilebiliyor).
    tagFilterChips?.addEventListener('click', (event) => {
      const chip = event.target.closest('.tag-filter-chip');
      if (!chip) return;
      if (chip.tagValue) toggleTag(chip.tagValue);
    });
    cardContainer?.addEventListener('click', (event) => {
      const badge = event.target.closest('.vault-card-tag');
      if (!badge) return;
      // Rozet zaten kartın içinde; kartın tıklanabilir alanlarıyla
      // çakışmasın diye olay yayılmıyor ama varsayılan davranışı da
      // engelliyoruz (rozet "düzenle" gibi bir üst öğe değil).
      event.preventDefault();
      event.stopPropagation();
      const tag = normalizeSearchText(badge.textContent);
      if (tag) toggleTag(tag);
    });
    tagFilterClear?.addEventListener('click', clearTags);

    categoryBtns.forEach(btn => {
        const isActive = btn.dataset.filter === filter;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
      });
    };

    statsChips.forEach(chip => {
      chip.addEventListener('click', () => {
        if (chip.getAttribute('aria-disabled') === 'true') return;
        const filter = chip.dataset.statFilter;
        if (filter === 'all' || filter === 'favorites') {
          clearStatsFilter();
          activateCategory(filter);
          filterCards({ preservePage: false, animate: false });
          return;
        }
        const wasActive = chip.classList.contains('active');
        clearStatsFilter();
        activateCategory('all');
        if (!wasActive) {
          statsFilter = filter;
          chip.classList.add('active');
          chip.setAttribute('aria-pressed', 'true');
        }
        ensureStats().then(() => filterCards({ preservePage: false, animate: false }));
      });
    });

    rebuildCardCache();
    filterCards({ preservePage: false, animate: false });
    ensureStats();

    // Sağlık raporundaki "Tümünü İncele" → /?filtre=zayif|eski|expired
    const deepFilter = new URLSearchParams(window.location.search).get('filtre');
    if (deepFilter === 'zayif' || deepFilter === 'eski' || deepFilter === 'expired') {
      const chip = Array.from(statsChips).find(c => c.dataset.statFilter === deepFilter);
      if (chip && chip.getAttribute('aria-disabled') !== 'true') {
        clearStatsFilter();
        activateCategory('all');
        statsFilter = deepFilter;
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        ensureStats().then(() => filterCards({ preservePage: false, animate: false }));
      }
    }

    // /import → kayıt sınırı aşıldıysa yönlendirme ?import_dropped=N ile gelir.
    // Sessizce eksik yükleme olmasın: uyarı göster, parametreyi adresten temizle.
    const importDropped = Number.parseInt(
      new URLSearchParams(window.location.search).get('import_dropped') || '', 10);
    if (Number.isInteger(importDropped) && importDropped > 0) {
      showWarningToast(
        window._('{count} kayıt yüklenmedi: yedek kayıt sınırını aşıyor. Yedeği bölerek tekrar deneyin.')
          .replace('{count}', String(importDropped))
      );
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('import_dropped');
      window.history.replaceState({}, '', cleanUrl.toString());
    }

    // /import başarılıysa ?import_source=<etiket> ile gelir. Kullanıcı hangi
    // biçimin tanındığını görsün: içe aktarma sessizce yanlış eşlenirse (örn.
    // LastPass CSV'si genel CSV sanılır) bu satır olmadan fark edilmez.
    const importSource = new URLSearchParams(window.location.search).get('import_source');
    if (importSource) {
      showSuccessToast(window._('{count} kayıt içe aktarıldı ({source}).')
        .replace('{count}', String(document.querySelectorAll('.card-wrapper').length))
        .replace('{source}', importSource));
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('import_source');
      window.history.replaceState({}, '', cleanUrl.toString());
    }

    // Sıralama seçicisi. Sıralama SUNUCUDA yapılır (`/?sort=`): başlık ve
    // kategori şifreli sütunlar, yani istemci tarafında şifresiz metin
    // bulunmuyor; ayrıca kartlar DOM sırasına göre dilimlendiği için
    // istemci tarafı yeniden sıralama sayfalamayı bozardı.
    // Adres çubuğu URL'si korunur: ileride derin bağlantı eklenirse
    // sıralama onunla birlikte taşınır.
    const sortSelect = document.getElementById('record-sort-select');
    if (sortSelect) {
      sortSelect.addEventListener('change', () => {
        const url = new URL(window.location.href);
        if (sortSelect.value === 'updated') {
          url.searchParams.delete('sort');
        } else {
          url.searchParams.set('sort', sortSelect.value);
        }
        window.location.assign(url.toString());
      });
    }

    // Görünüm seçenekleri düğmesi → modal. Düğme `data-kasa-modal` taşıdığı
    // için açılışı modal sistemi yapar; buradaki tek görev `aria-expanded`
    // senkronu. Sıralama seçicisi de bu modalın içindedir ve sunucu tarafında
    // uygulandığı için seçim değişince `vault-index.js` sayfayı yeniden yükler.
    const viewOptionsBtn = document.getElementById('view-options-btn');
    viewOptionsBtn?.addEventListener('click', () => {
        requestAnimationFrame(() => viewOptionsBtn.setAttribute('aria-expanded', 'true'));
    });
    document.getElementById('viewOptionsModal')?.addEventListener('kasa:modal-closing', () => {
        viewOptionsBtn?.setAttribute('aria-expanded', 'false');
    });

    // DEĞİŞİKLİK 1: tüm kartlar DOM'da + kapak görselleri yüklenene dek
    // giriş animasyonları duraklatılır; sonra topluca oynatılır.
    // card-animated class'ı yalnızca ilk reveal'da verilir (şablonda kalıcı
    // değildir) — böylece filtre/istatistik/pagination geçişlerinde
    // display toggle animasyonu restart edip 'çift render' hissi yaratmaz.
    const finishInitialReveal = () => {
      const startReveal = () => {
        requestAnimationFrame(() => {
          // Curtain (visibility) kaldırma ve card-animated ekleme AYNI frame'de;
          // animasyon ilk karesinden itibaren görünür oynar. Ayrıca card-animated
          // yalnızca reveal'da eklendiği için pause/restart kırılganlığı yoktur.
          cardContainer.classList.remove('vault-card-curtain');
          cardCache.forEach(({ wrapper }) => wrapper.classList.add('card-animated'));
          // En uzun stagger (280ms) + süre (220ms) sonrası class kaldırılır;
          // gizli kartlarda animationend tetiklenmeyeceği için timeout kullanılır.
          setTimeout(() => {
            cardCache.forEach(({ wrapper }) => wrapper.classList.remove('card-animated'));
          }, 650);
        });
      };
      // Özel arkaplan decode gate'i (data-kasa-bg-wait) açıkken body opacity:0'dır;
      // reveal bu sırada başlatılırsa animasyon ya görünmez ya da 650ms'lik temizlik
      // animasyon oynamadan class'ı siler. Gate kalkana dek beklenir; güvenlik ağı
      // 4s (prepaint toleransı 1500ms olduğundan pratikte asla tetiklenmez).
      if (document.documentElement.hasAttribute('data-kasa-bg-wait')) {
        const observer = new MutationObserver(() => {
          if (!document.documentElement.hasAttribute('data-kasa-bg-wait')) {
            observer.disconnect();
            startReveal();
          }
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-kasa-bg-wait'],
        });
        window.setTimeout(() => {
          observer.disconnect();
          startReveal();
        }, 4000);
        return;
      }
      startReveal();
    };
    const cardImgs = Array.from(cardContainer.querySelectorAll('img'));
    const imgPromises = cardImgs.map(img => new Promise(resolve => {
      if (img.complete) return resolve();
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    }));
    Promise.race([
      Promise.allSettled(imgPromises),
      new Promise(resolve => setTimeout(resolve, 1200)),
    ]).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(finishInitialReveal));
    });

    let searchTimeout;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => filterCards({ preservePage: false, animate: true }), 120);
    });

    // Arama alanı seçici (Başlık / Kullanıcı adı / E-posta / Not / Kart no).
    // Alan filtresi TEK BAŞINA filtrelemez: yalnız yazılan metni daraltır, boş
    // metin her şeyi eşleştirir (matchesSearchTerm). Seçim kalıcıdır.
    const searchFieldSelect = document.getElementById('search-field-select');
    if (searchFieldSelect) {
      const storedField = localStorage.getItem(SEARCH_FIELD_STORAGE_KEY);
      if (SEARCH_FIELD_ORDER.includes(storedField)) searchFieldSelect.value = storedField;
      searchFieldSelect.addEventListener('change', () => {
        localStorage.setItem(SEARCH_FIELD_STORAGE_KEY, searchFieldSelect.value);
        filterCards({ preservePage: false, animate: false });
      });
    }

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
        clearStatsFilter();
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
          // ensureStats(true) içindeki refreshStatsBar hem barı boyar hem
          // vaultStats'ı tazeler → eskiden buradaki 2 satır 2 ayrı istek atıyordu
          ensureStats(true);
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

  // ── İlk Açılış Karşılaması (Onboarding) ──
  const onboardingModal = document.getElementById('onboardingModal');
  if (onboardingModal) {
    initOnboarding({
      modal: onboardingModal,
      apiPost,
      applyAppearance,
      applyGlassQuality,
      getCurrentBackground,
      kasaModalAc,
      kasaModalKapat: window.kasaModalKapat,
      startPageLoading: window.KASA_SET_PAGE_LOADING,
    });
  }

}

/* Onboarding sihirbazı: boş kasada ilk açılışta tema / vurgu rengi /
   cam efektleri + dil seçimi sunar; canlı önizlemeyle uygular. */
function initOnboarding({
  modal,
  apiPost,
  applyAppearance,
  applyGlassQuality,
  getCurrentBackground,
  kasaModalAc,
  kasaModalKapat,
  startPageLoading,
}) {
  const root = document.documentElement;
  const shouldShow = modal.dataset.kasaOnboarding === 'true';
  const bodyHandlersBound = modal.dataset.kasaOnbBound === 'true';
  if (shouldShow && !bodyHandlersBound) {
    modal.dataset.kasaOnbBound = 'true';

    const panels = modal.querySelectorAll('[data-onb-step]');
    const dots = modal.querySelectorAll('[data-onb-step-dot]');
    const prevBtn = modal.querySelector('[data-onb-nav="prev"]');
    const nextBtn = modal.querySelector('[data-onb-nav="next"]');
    const finishBtn = modal.querySelector('[data-onb-finish]');
    const skipBtn = modal.querySelector('[data-onb-skip]');
    const langSelect = modal.querySelector('[data-onb-lang]');
    const themeSegs = modal.querySelectorAll('[data-onb-theme]');
    const accentSegs = modal.querySelectorAll('[data-onb-accent]');
    const glassToggle = modal.querySelector('[data-onb-glass-toggle]');
    const qualitySegs = modal.querySelectorAll('[data-onb-quality]');
    const glassStateLabel = modal.querySelector('[data-onb-glass-state]');

    const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const VALID_THEME_MODES = ['light', 'dark', 'system'];
    const QUALITY_LABELS = { low: 'Düşük', normal: 'Normal', high: 'Yüksek' };
    const ACCENT_COLORS = ['#7c6ff7', '#38bdf8', '#22c55e', '#f59e0b', '#f43f5e', '#14b8a6', '#6366f1', '#84cc16'];
    let currentStep = 1;
    let completionPosted = false;

    const resolveEffectiveTheme = (mode) => {
      if (mode === 'system') return systemThemeQuery.matches ? 'dark' : 'light';
      return mode === 'light' ? 'light' : 'dark';
    };

    const applyThemeMode = (mode) => {
      if (!VALID_THEME_MODES.includes(mode)) mode = 'dark';
      const effective = resolveEffectiveTheme(mode);
      root.setAttribute('data-bs-theme', effective);
      localStorage.setItem('kasa-theme', effective);
      localStorage.setItem('kasa-theme-mode', mode);
      themeSegs.forEach(seg => {
        const isActive = seg.dataset.onbTheme === mode;
        seg.classList.toggle('is-active', isActive);
        seg.setAttribute('aria-pressed', String(isActive));
      });
      apiPost('/settings/theme-mode', { theme_mode: mode });
    };

    const applyAccent = (accent) => {
      const normalizedAccent = ACCENT_COLORS.includes(accent.toLowerCase())
        ? accent.toLowerCase()
        : accent;
      accentSegs.forEach(seg => {
        const isActive = seg.dataset.onbAccent.toLowerCase() === normalizedAccent.toLowerCase();
        seg.classList.toggle('is-active', isActive);
        seg.setAttribute('aria-pressed', String(isActive));
      });
      applyAppearance(normalizedAccent, getCurrentBackground());
      apiPost('/settings/appearance', { accent_color: normalizedAccent });
    };

    const normalizeGlassQuality = (quality) => {
      const q = String(quality || '');
      return ['low', 'normal', 'high'].includes(q) ? q : 'normal';
    };

    const syncGlassUI = () => {
      const effectsOn = root.getAttribute('data-glass-effects') !== 'off';
      const quality = normalizeGlassQuality(root.getAttribute('data-glass-quality'));
      if (glassToggle) glassToggle.checked = effectsOn;
      qualitySegs.forEach(seg => {
        const isActive = seg.dataset.onbQuality === quality;
        seg.classList.toggle('is-active', isActive);
        seg.setAttribute('aria-pressed', String(isActive));
      });
      if (glassStateLabel) {
        glassStateLabel.textContent = effectsOn
          ? window._(QUALITY_LABELS[quality] || 'Normal')
          : window._('Kapalı');
      }
    };

    const applyGlassEffects = (enabled) => {
      const value = enabled ? 'on' : 'off';
      root.setAttribute('data-glass-effects', value);
      localStorage.setItem('kasa-glass-effects', value);
      syncGlassUI();
      apiPost('/settings/glass-effects', { enabled });
    };

    const applyQuality = (quality) => {
      const normalizedQuality = applyGlassQuality(quality);
      syncGlassUI();
      if (glassStateLabel) glassStateLabel.textContent = window._(QUALITY_LABELS[normalizedQuality] || 'Normal');
      apiPost('/settings/appearance', { glass_quality: normalizedQuality });
    };

    const goToStep = (target) => {
      const next = Math.min(3, Math.max(1, Number(target) || 1));
      const direction = next > currentStep ? 'fwd' : (next < currentStep ? 'back' : null);
      currentStep = next;
      let activePanel = null;
      panels.forEach(panel => {
        const panelStep = Number(panel.dataset.onbStep);
        const isActive = panelStep === currentStep;
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
        panel.classList.remove('onb-panel-anim', 'onb-panel-fwd', 'onb-panel-back');
        if (isActive) activePanel = panel;
      });
      if (direction && activePanel) {
        void activePanel.offsetWidth;
        activePanel.classList.add('onb-panel-anim', direction === 'fwd' ? 'onb-panel-fwd' : 'onb-panel-back');
      }
      dots.forEach(dot => {
        const dotStep = Number(dot.dataset.onbStepDot);
        dot.classList.toggle('is-active', dotStep === currentStep);
        dot.classList.toggle('is-done', dotStep < currentStep);
      });
      prevBtn.hidden = currentStep === 1;
      nextBtn.hidden = currentStep === 3;
      finishBtn.hidden = currentStep !== 3;
    };

    const postCompletion = () => {
      if (completionPosted) return;
      completionPosted = true;
      apiPost('/settings/onboarding', { done: true }).catch(() => {
        completionPosted = false;
      });
    };

    // ── Gezinme ──
    nextBtn?.addEventListener('click', () => goToStep(currentStep + 1));
    prevBtn?.addEventListener('click', () => goToStep(currentStep - 1));
    finishBtn?.addEventListener('click', () => {
      postCompletion();
      if (kasaModalKapat) kasaModalKapat('onboardingModal');
    });
    skipBtn?.addEventListener('click', () => {
      postCompletion();
      if (kasaModalKapat) kasaModalKapat('onboardingModal');
    });
    // X / overlay / Esc ile kapanınca da tamamlanmış say
    modal.addEventListener('kasa:modal-closing', postCompletion);

    // ── Dil ──
    if (langSelect) {
      langSelect.addEventListener('change', () => {
        const lang = langSelect.value;
        startPageLoading?.(true, {
          title: window._('Dil değiştiriliyor…'),
          subtitle: window._('Arayüz seçilen dilde yeniden yükleniyor.'),
        });
        apiPost('/settings/language', { language: lang }).then((response) => {
          if (!response || !response.ok) throw new Error('language-save-failed');
          localStorage.setItem('kasa-lang', lang);
          window.location.reload();
        }).catch(() => {
          startPageLoading?.(false);
          langSelect.value = window.LANG || 'tr';
          window.KASA_SHOW_WARNING_TOAST?.(window._('Dil değiştirilemedi.'));
        });
      });
    }

    // ── Tema ──
    themeSegs.forEach(seg => seg.addEventListener('click', () => applyThemeMode(seg.dataset.onbTheme)));

    // ── Vurgu rengi ──
    accentSegs.forEach(seg => seg.addEventListener('click', () => applyAccent(seg.dataset.onbAccent)));

    // ── Cam efekleri / kalite ──
    glassToggle?.addEventListener('change', () => applyGlassEffects(glassToggle.checked));
    qualitySegs.forEach(seg => seg.addEventListener('click', () => applyQuality(seg.dataset.onbQuality)));

    // ── Başlangıç durumu + açılış ──
    const initialMode = localStorage.getItem('kasa-theme-mode') || 'dark';
    applyThemeMode(VALID_THEME_MODES.includes(initialMode) ? initialMode : 'dark');
    const initialAccent = (window.KASA_APPEARANCE && window.KASA_APPEARANCE.accent)
      || localStorage.getItem('kasa-accent') || '#7c6ff7';
    accentSegs.forEach(seg => {
      const isActive = seg.dataset.onbAccent.toLowerCase() === initialAccent.toLowerCase();
      seg.classList.toggle('is-active', isActive);
      seg.setAttribute('aria-pressed', String(isActive));
    });
    syncGlassUI();
    goToStep(1);

    const openWhenReady = (startedAt) => {
      // is-page-loading hiç kalkmazsa (örn. gezinme iptali / hata) sonsuz
      // rAF döngüsüne takılmamak için 5 sn'lik üst sınır uygula.
      if (document.body.classList.contains('is-page-loading')
          && Date.now() - startedAt < 5000) {
        window.requestAnimationFrame(() => openWhenReady(startedAt));
        return;
      }
      window.setTimeout(() => kasaModalAc('onboardingModal'), 260);
    };
    openWhenReady(Date.now());
  }
}