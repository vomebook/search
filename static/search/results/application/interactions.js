// Result and sidebar actions share the host's Reader and download lifecycles.
(function () {
  /** @param {VoiceOfMLResultInteractionDependencies} deps */
  function create(deps) {
    const { elements, selection } = deps;

    /** @param {string} text @param {string} success */
    async function copyLinks(text, success) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        deps.showToast("复制失败");
        return;
      }
      deps.showToast(success);
    }

    function installSelection() {
      if (elements.multiSelectToggle) elements.multiSelectToggle.addEventListener("change", deps.updateSelectionUI);
      elements.resultsList.addEventListener("click", function(e) {
        if (!elements.multiSelectToggle || !elements.multiSelectToggle.checked) return;
        const cb = /** @type {HTMLInputElement | null} */ (/** @type {Element} */ (e.target).closest(".result-checkbox"));
        if (!cb) return;
        e.stopPropagation();
        const idx = parseInt(/** @type {string} */ (cb.dataset.index));
        if (e.shiftKey && selection.lastIndex >= 0) {
          const lo = Math.min(selection.lastIndex, idx);
          const hi = Math.max(selection.lastIndex, idx);
          for (let si = lo; si <= hi; si++) {
            if (!deps.hasRecord(si)) continue;
            if (cb.checked) selection.indices[si] = true;
            else delete selection.indices[si];
          }
        } else if (cb.checked) {
          selection.indices[idx] = true;
        } else {
          delete selection.indices[idx];
        }
        selection.lastIndex = idx;
        deps.updateSelectionUI();
      });
      if (elements.multiCopyLinks) elements.multiCopyLinks.addEventListener("click", function() {
        const links = deps.getSelectedFiles().map(item => deps.getCopyableLink(item.link));
        if (links.length === 0) { deps.showToast("未选中任何文件"); return; }
        return copyLinks(links.join("\n"), "已复制 " + links.length + " 条链接");
      });
      if (elements.multiBatchDownload) elements.multiBatchDownload.addEventListener("click", function() {
        deps.startDownloadBatch(deps.getSelectedFiles());
      });
      if (elements.multiDeselect) elements.multiDeselect.addEventListener("click", function() {
        selection.indices = {};
        selection.lastIndex = -1;
        deps.updateSelectionUI();
      });
      if (elements.multiSelectAll) elements.multiSelectAll.addEventListener("click", function() {
        const records = deps.selectionRecords();
        const allSelected = records.length > 0 && records.every(function(record, index) { return !record || selection.indices[index]; });
        if (allSelected) selection.indices = {};
        else for (let si = 0; si < records.length; si++) if (records[si]) selection.indices[si] = true;
        selection.lastIndex = allSelected ? -1 : deps.resultCount() - 1;
        deps.updateSelectionUI();
      });
    }

    function installDelegation() {
      elements.resultsList.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const path = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.path-folder[role="button"]'));
        if (path && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); event.stopPropagation(); path.click();
        }
      });
      elements.resultsList.addEventListener("click", function(e) {
        const target = /** @type {HTMLElement} */ (e.target);
        const missing = target.closest('[data-window-page]');
        if (missing && deps.retryWindowPage(Number(/** @type {HTMLElement} */ (missing).dataset.windowPage))) return undefined;
        const actionBtn = /** @type {HTMLElement | null} */ (target.closest("[data-action]"));
        if (actionBtn) {
          e.preventDefault();
          const action = actionBtn.dataset.action;
          if (action === "copy") {
            return copyLinks(/** @type {string} */ (actionBtn.dataset.link), "链接已复制");
          }
          if (action === "download") {
            deps.downloadFile(actionBtn.dataset.filename || "file", actionBtn.dataset.link || "", { button: actionBtn });
            return undefined;
          }
          if (action === "read") {
            const record = deps.recordForRow(actionBtn.closest(".result-item"));
            if (record) {
              actionBtn.dataset.readerUrl = deps.freshReaderLink(record);
              // Pointer activation does not focus buttons in every browser.
              actionBtn.focus({ preventScroll: true });
            }
            deps.navigateToReader(actionBtn.dataset.readerUrl);
            return undefined;
          }
        }
        const repoTag = /** @type {HTMLElement | null} */ (target.closest(".result-repo-tag"));
        if (repoTag) {
          deps.navigateRepo(repoTag.dataset.repo);
          return undefined;
        }
        const folderLink = /** @type {HTMLElement | null} */ (target.closest(".path-folder"));
        if (folderLink) {
          const folder = folderLink.dataset.folder;
          const frepo = folderLink.dataset.repo;
          if (frepo && folder !== undefined) {
            // Preserve query filters and open the selected subtree in one history entry.
            const hash = "#/" + encodeURIComponent(frepo);
            const sp = deps.buildSearchURLParams({ displaySizes: true });
            if (folder) {
              sp.set("path", folder);
              sp.append("folder_subtree", folder);
            }
            const qs = sp.toString();
            const nextHash = qs ? hash + "?" + qs : hash;
            if (window.location.hash === nextHash) deps.renderBrowser(folder);
            else window.location.hash = nextHash;
          }
        }
        return undefined;
      });
      elements.sidebarContent.addEventListener("click", function(e) {
        const target = /** @type {HTMLElement} */ (e.target);
        const repoItem = /** @type {HTMLElement | null} */ (target.closest(".repo-list-item"));
        if (repoItem) {
          deps.navigateRepo(repoItem.dataset.repo);
          return;
        }
        const browserItem = /** @type {HTMLElement | null} */ (target.closest(".browser-item"));
        if (!browserItem) return;
        if (target.closest(".browser-action")) {
          e.stopPropagation();
          if (browserItem.dataset.link) {
            deps.downloadFile(browserItem.dataset.filename || "file", browserItem.dataset.link,
              { button: /** @type {HTMLElement} */ (browserItem.querySelector(".browser-action")) });
          }
          return;
        }
        if (browserItem.dataset.type === "folder") {
          deps.navigateRepo(deps.currentRepo(), browserItem.dataset.path);
          return;
        }
        const readerLink = browserItem.dataset.readerUrl;
        if (readerLink) {
          deps.navigateToReader(readerLink);
          return;
        }
        if (browserItem.dataset.link) {
          deps.downloadFile(browserItem.dataset.filename || "file", browserItem.dataset.link);
        }
      });
    }
    return { installSelection, installDelegation };
  }
  globalThis.VoiceOfMLResultInteractions = { create };
})();
