/**
 * ŞifreKasam v2.7.0-beta.3 - Özel Form Kontrolleri modülü (ES Module)
 *
 * 2b. bölüm: data-custom-select sarmalayıcıları, data-number-stepper ve
 * ilgili açık dropdown / scroll / resize davranışları.
 * initCustomControls, app.js içindeki DOMContentLoaded sırasında çağrılır;
 * modal sistemi için customSelectStates / closeCustomSelect döndürür.
 */

export function initCustomControls({ createIcon }) {

  const customSelectStates = [];

  const syncCustomSelectDirection = (state) => {
    if (!state?.openRequested) return;
    const triggerRect = state.trigger.getBoundingClientRect();
    /* Gerçek clip/scroll konteyneri sınır olarak kullanılır: menü bu alanın
       içinde kalır, konteynerin overflow'u değiştirilmez (overflow değişimi
       Chromium'da scroll'u sıfırlar). overflow'u görünür olan sarmalayıcılar
       (örn. vault-form-panel) sınır sayılmaz — menü panelin dışına taşabilir,
       sınır viewport olur. */
    const getBoundaryHost = (el) => {
      let node = el.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll|hidden)/.test(style.overflowX + ' ' + style.overflowY)) return node;
        node = node.parentElement;
      }
      return null;
    };
    const scrollHost = getBoundaryHost(state.wrapper);
    const boundaryRect = scrollHost?.getBoundingClientRect();
    const boundaryTop = boundaryRect?.top ?? 0;
    const boundaryBottom = boundaryRect?.bottom ?? window.innerHeight;
    const naturalHeight = state.menu.scrollHeight;
    const menuHeight = Math.min(naturalHeight, window.innerHeight * 0.38);
    const spaceAbove = triggerRect.top - boundaryTop;
    const spaceBelow = boundaryBottom - triggerRect.bottom;
    state.wrapper.classList.toggle(
      'opens-upward',
      spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow,
    );
    const availableSpace = (state.wrapper.classList.contains('opens-upward') ? spaceAbove : spaceBelow) - 10;
    const neededCap = Math.max(72, Math.min(menuHeight, availableSpace));
    if (neededCap >= naturalHeight) {
      if (state.menu.style.maxHeight) state.menu.style.maxHeight = '';
    } else if (state.menu.style.maxHeight !== neededCap + 'px') {
      state.menu.style.maxHeight = neededCap + 'px';
    }
  };

  const closeCustomSelect = (state, restoreFocus = false) => {
    if (!state || (!state.openRequested && !state.wrapper.classList.contains('is-open'))) return;
    state.openRequested = false;
    state.wrapper.classList.remove('is-open');
    state.trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(state.closeTimer);
    state.closeTimer = setTimeout(() => {
      if (!state.wrapper.classList.contains('is-open')) {
        state.menu.hidden = true;
        state.menu.style.maxHeight = '';
        state.wrapper.classList.remove('opens-upward');
        state.host?.classList.remove('has-open-select');
        state.layerHosts.forEach((layerHost) => {
          if (!layerHost.querySelector('.kasa-custom-select.is-open')) {
            layerHost.classList.remove('has-open-select-layer');
          }
        });
      }
    }, 140);
    if (restoreFocus) state.trigger.focus({ preventScroll: true });
  };

  const closeCustomSelects = (exceptState = null) => {
    customSelectStates.forEach(state => {
      if (state !== exceptState) closeCustomSelect(state);
    });
  };

  document.querySelectorAll('select[data-custom-select]').forEach((select, index) => {
    if (select.dataset.customSelectReady === 'true') return;
    select.dataset.customSelectReady = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'kasa-custom-select';
    ['settings-inline-select', 'settings-language-select'].forEach(className => {
      if (select.classList.contains(className)) wrapper.classList.add(className);
    });

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'kasa-custom-select-trigger';
    trigger.id = `${select.id || `custom-select-${index}`}-trigger`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const labelledBy = select.getAttribute('aria-labelledby');
    const label = select.getAttribute('aria-label');
    if (labelledBy) trigger.setAttribute('aria-labelledby', labelledBy);
    else if (label) trigger.setAttribute('aria-label', label);

    const valueNode = document.createElement('span');
    valueNode.className = 'kasa-custom-select-value';
    const chevron = createIcon('fa-solid fa-chevron-down');
    chevron.setAttribute('aria-hidden', 'true');
    trigger.append(valueNode, chevron);

    const menu = document.createElement('div');
    menu.className = 'kasa-custom-select-menu';
    menu.id = `${trigger.id}-menu`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', trigger.id);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);

    const optionButtons = Array.from(select.options).map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'kasa-custom-select-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.disabled = option.disabled;

      const optionText = document.createElement('span');
      optionText.textContent = option.textContent.trim();
      const optionIcon = option.dataset.icon
        ? createIcon(`fa-solid ${option.dataset.icon}`)
        : null;
      if (optionIcon) {
        optionIcon.setAttribute('aria-hidden', 'true');
        optionIcon.classList.add('kasa-custom-select-option-icon');
        button.classList.add('has-icon');
      }
      const check = createIcon('fa-solid fa-check');
      check.setAttribute('aria-hidden', 'true');
      if (optionIcon) button.append(optionIcon, optionText, check);
      else button.append(optionText, check);
      menu.appendChild(button);
      return button;
    });

    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    select.classList.add('kasa-custom-select-source');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const state = {
      select,
      wrapper,
      trigger,
      menu,
      optionButtons,
      closeTimer: 0,
      openRequested: false,
      host: wrapper.closest('.glass-sm, .settings-card, .vault-field'),
      layerHosts: [
        wrapper.closest('.vault-form-panel'),
        wrapper.closest('.settings-panel'),
        wrapper.closest('.settings-body'),
        wrapper.closest('.settings-modal-content'),
      ].filter((layerHost, layerIndex, layerHosts) => (
        layerHost && layerHosts.indexOf(layerHost) === layerIndex
      )),
    };
    customSelectStates.push(state);

    const syncCustomSelect = () => {
      const selectedOption = select.selectedOptions[0] || select.options[0];
      valueNode.textContent = '';
      if (selectedOption?.dataset.icon) {
        const icon = createIcon(`fa-solid ${selectedOption.dataset.icon}`);
        icon.setAttribute('aria-hidden', 'true');
        icon.classList.add('kasa-custom-select-value-icon');
        valueNode.append(icon, document.createTextNode(' '));
      }
      valueNode.append(document.createTextNode(selectedOption?.textContent.trim() || ''));
      trigger.disabled = select.disabled;
      wrapper.classList.toggle('is-disabled', select.disabled);
      optionButtons.forEach((button, optionIndex) => {
        const selected = select.options[optionIndex]?.selected === true;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-selected', String(selected));
      });
      if (select.disabled) closeCustomSelect(state);
    };

    const openCustomSelect = (focusSelected = false) => {
      if (select.disabled) return;
      if (wrapper.classList.contains('is-open')) {
        closeCustomSelect(state);
        return;
      }
      closeCustomSelects(state);
      clearTimeout(state.closeTimer);
      state.openRequested = true;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      state.host?.classList.add('has-open-select');
      state.layerHosts.forEach(layerHost => layerHost.classList.add('has-open-select-layer'));
      requestAnimationFrame(() => {
        if (!state.openRequested) return;
        syncCustomSelectDirection(state);
        wrapper.classList.add('is-open');
        if (focusSelected) {
          (optionButtons.find(button => button.classList.contains('is-selected'))
            || optionButtons.find(button => !button.disabled))?.focus({ preventScroll: true });
        }
      });
    };

    trigger.addEventListener('click', () => openCustomSelect(false));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openCustomSelect(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeCustomSelect(state);
      }
    });

    optionButtons.forEach((button, optionIndex) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        select.value = select.options[optionIndex].value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeCustomSelect(state, true);
      });
      button.addEventListener('keydown', event => {
        const enabledOptions = optionButtons.filter(optionButton => !optionButton.disabled);
        const currentIndex = enabledOptions.indexOf(button);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % enabledOptions.length;
        else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + enabledOptions.length) % enabledOptions.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = enabledOptions.length - 1;
        else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeCustomSelect(state, true);
          return;
        } else {
          return;
        }
        event.preventDefault();
        enabledOptions[nextIndex]?.focus({ preventScroll: true });
      });
    });

    select.addEventListener('change', syncCustomSelect);
    wrapper.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!wrapper.contains(document.activeElement)) closeCustomSelect(state);
      }, 0);
    });
    select.kasaSyncCustomSelect = syncCustomSelect;
    new MutationObserver(syncCustomSelect).observe(select, {
      attributes: true,
      attributeFilter: ['disabled'],
    });
    syncCustomSelect();
  });

  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.kasa-custom-select')) {
      closeCustomSelects();
    }
  });

  const syncOpenCustomSelects = () => {
    customSelectStates.forEach(syncCustomSelectDirection);
  };
  window.addEventListener('resize', syncOpenCustomSelects, { passive: true });
  document.addEventListener('scroll', syncOpenCustomSelects, { passive: true, capture: true });

  document.querySelectorAll('.kasa-modal').forEach(modal => {
    modal.addEventListener('kasa:modal-closing', () => closeCustomSelects());
  });

  document.querySelectorAll('[data-number-stepper]').forEach(stepper => {
    const input = stepper.querySelector('input[type="number"]');
    if (!input) return;

    const clampInput = () => {
      const min = Number(input.min);
      const max = Number(input.max);
      const fallback = Number.isFinite(min) ? min : 0;
      const value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback;
      input.value = String(Math.min(Number.isFinite(max) ? max : value, Math.max(fallback, value)));
    };

    stepper.querySelectorAll('[data-step-direction]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.stepDirection === 'up') input.stepUp();
        else input.stepDown();
        clampInput();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    input.addEventListener('change', clampInput);
  });

  return { customSelectStates, closeCustomSelect, closeCustomSelects };

}