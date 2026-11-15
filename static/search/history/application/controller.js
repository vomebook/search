// History owns its menu; the host owns input composition and query submission.
(function () {
  /** @param {VoiceOfMLSearchHistoryDependencies} deps */
  function create(deps) {
    const { elements, store, escapeHTML } = deps;
    /** @param {string} q */
    function addHistoryItem(q) {
      if (!q || !deps.recordHistory()) return;
      const list = store.get();
      const idx = list.indexOf(q);
      if (idx >= 0) list.splice(idx, 1);
      list.unshift(q);
      store.save(list);
    }
    function renderDropdown() {
      const { historyDropdown } = elements();
      if (!historyDropdown) return;
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      const row = active && historyDropdown.contains(active) ? active.closest('.history-item') : null;
      const oldIndex = row ? Array.from(historyDropdown.querySelectorAll('.history-item')).indexOf(row) : -1;
      const list = store.get();
      if (list.length === 0) { hideSearchHistory(!!row); return; }
      let html = "";
      for (let h = 0; h < list.length; h++) {
        const query = /** @type {string} */ (list[h]);
        html += '<div class="history-item" data-query="' + escapeHTML(query) + '">' +
          '<svg class="history-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          '<button type="button" class="history-text" aria-label="搜索：' + escapeHTML(query) + '">' + escapeHTML(query) + '</button>' +
          '<button type="button" class="history-del" aria-label="删除搜索历史：' + escapeHTML(query) + '" data-del="' + escapeHTML(query) + '">&times;</button>' +
          '</div>';
      }
      html += '<div class="history-footer"><button class="history-clear-all">清空历史</button></div>';
      historyDropdown.innerHTML = html;
      historyDropdown.style.display = "";
      if (row) {
        const index = list.indexOf(/** @type {HTMLElement} */ (row).dataset.query || "");
        const selector = index >= 0 && active?.matches('.history-del') ? '.history-del' : '.history-text';
        historyDropdown.querySelectorAll('.history-item')[index >= 0 ? index : Math.min(oldIndex, list.length - 1)]
          ?.querySelector(/** @type {'button'} */ (selector))?.focus({ preventScroll: true });
      }
    }
    function hideSearchHistory(restoreFocus = false) {
      const { searchInput, historyDropdown } = elements();
      // Focus first: its normal focus listener may render history again.
      if (restoreFocus) searchInput.focus({ preventScroll: true });
      historyDropdown.style.display = "none";
    }
    function setupSearchHistory() {
      const { searchInput, searchBox, historyDropdown } = elements();
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let hideTimer;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let pressTimer;
      let pressed = false, hovering = false;
      const scheduleHide = () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!hovering && !searchBox.contains(document.activeElement)) hideSearchHistory();
        }, 150);
      };
      searchInput.addEventListener('focus', renderDropdown);
      searchBox.addEventListener('focusout', scheduleHide);
      historyDropdown.addEventListener('mouseenter', () => { hovering = true; });
      historyDropdown.addEventListener('mouseleave', () => { hovering = false; clearTimeout(pressTimer); scheduleHide(); });
      document.addEventListener('pointerdown', event => {
        if (!searchBox.contains(/** @type {Node | null} */ (event.target))) hideSearchHistory();
      }, { passive: true });
      searchBox.addEventListener('keydown', event => {
        if (event.isComposing || deps.isComposing() || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey ||
            historyDropdown.style.display === 'none') return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); hideSearchHistory(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const buttons = Array.from(historyDropdown.querySelectorAll(/** @type {'button'} */ ('.history-text')));
          if (!buttons.length) return;
          const row = /** @type {Element} */ (event.target).closest('.history-item');
          const index = row ? Array.from(historyDropdown.querySelectorAll('.history-item')).indexOf(row) : -1;
          const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
          event.preventDefault(); event.stopPropagation();
          if (next < 0) searchInput.focus({ preventScroll: true });
          else buttons[Math.min(next, buttons.length - 1)]?.focus({ preventScroll: true });
        }
      });
      /** @param {Event} event */
      const startPress = event => {
        clearTimeout(pressTimer); pressed = false;
        const target = /** @type {Element} */ (event.target);
        if (target.closest('.history-del,.history-clear-all')) return;
        const row = /** @type {HTMLElement | null} */ (target.closest('.history-item'));
        if (row) pressTimer = setTimeout(() => { pressed = true; removeHistoryItem(row.dataset.query || ""); }, 600);
      };
      historyDropdown.addEventListener('mousedown', startPress);
      historyDropdown.addEventListener('touchstart', startPress, { passive: true });
      for (const type of ['mouseup', 'touchend', 'touchmove', 'touchcancel'])
        historyDropdown.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
      historyDropdown.addEventListener('click', event => {
        if (pressed && event.detail !== 0) { pressed = false; return; }
        pressed = false;
        const target = /** @type {Element} */ (event.target);
        const remove = /** @type {HTMLElement | null} */ (target.closest('.history-del'));
        if (remove) { removeHistoryItem(remove.dataset.del || ""); return; }
        if (target.closest('.history-clear-all')) { store.save([]); hideSearchHistory(true); return; }
        const row = /** @type {HTMLElement | null} */ (target.closest('.history-item'));
        if (row) {
          const restoreFocus = historyDropdown.contains(document.activeElement);
          deps.submitSearchQuery(row.dataset.query || "", { restore: true, blur: true });
          hideSearchHistory();
          if (restoreFocus) elements().resultsContainer.focus({ preventScroll: true });
        }
      });
    }
    /** @param {string} q */
    function removeHistoryItem(q) {
      const list = store.get();
      const idx = list.indexOf(q);
      if (idx >= 0) list.splice(idx, 1);
      store.save(list);
      renderDropdown();
    }
    return { addHistoryItem, renderDropdown, hideSearchHistory, setupSearchHistory, removeHistoryItem };
  }
  globalThis.VoiceOfMLSearchHistory = { create };
})();
