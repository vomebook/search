export function createReaderBookmarks(readerContext) {
  function consumeBookmarkHandoff(entry) {
    if (!entry || entry.id !== readerContext.params.get("bookmark") || entry.url !== readerContext.params.get("bookmark_source"))
      return;
    const opening = new URL(location.href);
    const shareKey = (url) => {
      const key = new URL(url);
      key.searchParams.delete("return");
      key.searchParams.delete("nav");
      return key.href;
    };
    const cleanMatchingUrl = (raw) => {
      if (typeof raw !== "string" || !raw) return null;
      try {
        const url = new URL(raw, location.origin);
        if (
          url.origin !== location.origin ||
          url.pathname !== opening.pathname ||
          shareKey(url) !== shareKey(opening)
        )
          return null;
        url.searchParams.delete("bookmark");
        url.searchParams.delete("bookmark_source");
        return url.href;
      } catch (_) {
        return null;
      }
    };
    const cleanHistory = (owner) => {
      const url = cleanMatchingUrl(owner.location.href);
      if (!url) return;
      const state = owner.history.state;
      const readerUrl = state?.voiceReaderOverlay && cleanMatchingUrl(state.readerUrl);
      owner.history.replaceState(readerUrl ? { ...state, readerUrl } : state, "", url);
    };
    // Clean only this navigation, not a bookmark-ID cache. A new deliberate click
    // can reuse the same bookmark; overlay reload/Back uses the cleaned records.
    try {
      if (
        readerContext.isReaderOverlayFrame() &&
        window.parent.history.state?.voiceReaderOverlay === true &&
        cleanMatchingUrl(window.parent.history.state.readerUrl)
      )
        cleanHistory(window.parent);
    } catch (_) {}
    try {
      const saved = JSON.parse(sessionStorage.getItem("reader-navigation-current") || "null");
      const readerUrl = cleanMatchingUrl(saved?.readerUrl),
        shareUrl = cleanMatchingUrl(saved?.shareUrl);
      if (readerUrl && shareUrl)
        sessionStorage.setItem(
          "reader-navigation-current",
          JSON.stringify({ ...saved, readerUrl, shareUrl })
        );
    } catch (_) {}
    try {
      cleanHistory(window);
    } catch (_) {}
    readerContext.params.delete("bookmark");
    readerContext.params.delete("bookmark_source");
  }

  function excerptFromCaret(doc, root, x, y) {
    let node,
      offset = 0;
    const position = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : null;
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    } else if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
    if (!node || !root.contains(node)) return "";
    if (node.nodeType !== Node.TEXT_NODE) {
      const first = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
      if (!first) return "";
      node = first;
      offset = 0;
    }
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    let excerpt = node.data.slice(offset);
    while (excerpt.length < 220 && walker.nextNode()) excerpt += ` ${walker.currentNode.data}`;
    return excerpt.replace(/\s+/g, " ").trim().slice(0, 160);
  }

  function bookmarkExcerpt() {
    if (["image", "audio", "video"].includes(readerContext.capability.mode)) return "";
    if (["pdf", "pdf-pages"].includes(readerContext.capability.mode)) {
      const shell = readerContext.pageAtMarker(),
        items = shell && shell._bookmarkTextItems;
      if (items && items.length) {
        const rect = shell.getBoundingClientRect(),
          targetY =
            Math.max(0, readerContext.bookmarkRibbon.getBoundingClientRect().bottom - rect.top) /
            Math.max(1, rect.height);
        let nearest = 0,
          distance = Infinity;
        items.forEach((item, index) => {
          const nextDistance = Math.abs(item.y - targetY);
          if (nextDistance < distance) {
            nearest = index;
            distance = nextDistance;
          }
        });
        return items
          .slice(nearest)
          .map((item) => item.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
      }
      // A scanned/unloaded page has no excerpt. Never fall back to other pages' UI text.
      return "";
    }
    const x = Math.round(readerContext.viewport.getBoundingClientRect().width / 2),
      y = Math.round(readerContext.bookmarkRibbon.getBoundingClientRect().bottom + 8);
    const frames = [...document.querySelectorAll("iframe")].filter((frame) => {
      const rect = frame.getBoundingClientRect();
      return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y;
    });
    const frame = frames[frames.length - 1];
    try {
      if (frame && frame.contentDocument && frame.contentDocument.body) {
        const rect = frame.getBoundingClientRect();
        return readerContext.excerptFromCaret(
          frame.contentDocument,
          frame.contentDocument.body,
          x - rect.left,
          y - rect.top
        );
      }
    } catch (_) {}
    const exact = readerContext.excerptFromCaret(document, readerContext.content, x, y);
    if (exact) return exact;
    const sourceText = readerContext.foliateContinuous
        ? [
            ...readerContext.content.querySelectorAll(
              ".foliate-continuous article[data-section]:not(.foliate-section-placeholder)"
            )
          ]
            .map((article) => readerContext.foliateSectionRoot(article).textContent)
            .join(" ")
        : readerContext.content.textContent,
      text = sourceText.replace(/\s+/g, " ").trim(),
      start = Math.floor((text.length * readerContext.readerProgressPercent()) / 100);
    return text.slice(start, start + 160).trim();
  }

  function captureFoliateBookmarkPosition() {
    if (!readerContext.foliateContinuous) return null;
    const marker = readerContext.viewport.getBoundingClientRect().top + 8,
      rows = [...document.querySelectorAll(".foliate-continuous article[data-section]")];
    const article =
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top <= marker && rect.bottom > marker;
      }) ||
      rows.find((row) => row.getBoundingClientRect().top > marker) ||
      rows[rows.length - 1];
    return article
      ? {
          foliateSection: Number(article.dataset.section),
          foliateOffset: marker - article.getBoundingClientRect().top,
          foliateTocIndex: readerContext.navigationState.currentChapterIndex
        }
      : null;
  }

  async function restoreFoliateBookmarkPosition(entry, generation = readerContext.beginReaderNavigation()) {
    try {
      if (
        !readerContext.foliateSectionLoader ||
        !Number.isInteger(entry.foliateSection) ||
        !readerContext.isReaderGenerationCurrent("navigation", generation)
      )
        return false;
      let article = await readerContext.foliateSectionLoader(entry.foliateSection);
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      await readerContext.waitForReader(0, true);
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      if (!article?.isConnected) article = await readerContext.foliateSectionLoader(entry.foliateSection);
      if (!article?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
      const marker = readerContext.viewport.getBoundingClientRect().top + 8;
      const offset = Number(entry.foliateOffset) || 0;
      const start = !offset
        ? readerContext.foliateSectionRoot(article).querySelector("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre") || article
        : article;
      readerContext.foliateScrollAnchors.invalidate();
      readerContext.viewport.scrollTop = Math.max(
        0,
        readerContext.viewport.scrollTop +
          start.getBoundingClientRect().top -
          marker +
          offset
      );
      readerContext.syncFoliateScrollLocation();
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      readerContext.scheduleSave();
      readerContext.setReaderPanelOpen(false, true);
      readerContext.foliateScrollAnchors.remember();
      return true;
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
      return false;
    }
  }

  async function seekFoliateProgress(percent, generation) {
    try {
      const sections = readerContext.epubBook?.sections?.filter((section) => section.linear !== "no") || [];
      if (
        !sections.length ||
        !readerContext.foliateSectionLoader ||
        !readerContext.isReaderGenerationCurrent("navigation", generation)
      )
        return;
      const position = Math.max(0, Math.min(0.999999, Number(percent) / 100)) * sections.length,
        index = Math.min(sections.length - 1, Math.floor(position));
      let article = await readerContext.foliateSectionLoader(index);
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      await readerContext.waitForReader(0, true);
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      if (!article?.isConnected) article = await readerContext.foliateSectionLoader(index);
      if (!article?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      const marker = readerContext.viewport.getBoundingClientRect().top + 8,
        offset = article.getBoundingClientRect().height * (position - index);
      readerContext.foliateScrollAnchors.invalidate();
      readerContext.viewport.scrollTop = Math.max(
        0,
        readerContext.viewport.scrollTop + article.getBoundingClientRect().top - marker + offset
      );
      await readerContext.waitForReader(0, true);
      if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return;
      readerContext.viewport.scrollTop += article.getBoundingClientRect().top - marker + offset + 4;
      readerContext.syncFoliateScrollLocation();
      readerContext.updateTocCurrentMark();
      readerContext.updateProgressTools();
      readerContext.scheduleSave();
      readerContext.foliateScrollAnchors.remember();
    } catch (error) {
      readerContext.reportNavigationError(error, generation);
    }
  }

  async function renderBookmarks() {
    const list = document.querySelector("#bookmarks-list"),
      generation = readerContext.nextReaderGeneration("bookmarks");
    try {
      const entries = readerContext.panelState.showingAllBookmarks
        ? await VoiceOfMLReaderStore.listAllBookmarks()
        : await VoiceOfMLReaderStore.listBookmarks(readerContext.sourceUrl);
      if (!readerContext.isReaderGenerationCurrent("bookmarks", generation)) return;
      list.textContent = "";
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "panel-item";
        row.dataset.bookmarkId = entry.id;
        const open = document.createElement("button");
        open.type = "button";
        open.className = "panel-item-main";
        open.textContent = readerContext.panelState.showingAllBookmarks
          ? `${entry.title || "未命名书籍"} · ${entry.label}`
          : entry.label;
        open.addEventListener("click", () =>
          entry.url !== readerContext.sourceUrl
            ? readerContext.navigateReader(entry.readerUrl, entry)
            : readerContext.restoreFormat(readerContext.capability.mode, entry)
        );
        const excerpt = document.createElement("p");
        excerpt.className = "bookmark-excerpt";
        excerpt.textContent = entry.excerpt || "";
        excerpt.hidden = !entry.excerpt;
        const meta = document.createElement("small");
        meta.textContent = new Date(entry.createdAt).toLocaleString();
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "panel-item-remove";
        remove.textContent = "删除";
        remove.setAttribute("aria-label", `删除书签：${open.textContent}`);
        remove.addEventListener("click", async () => {
          await VoiceOfMLReaderStore.removeBookmark(entry.id);
          const restoreFocus = row.contains(document.activeElement);
          const next = row.nextElementSibling?.querySelector("button") || row.previousElementSibling?.querySelector("button") ||
            readerContext.bookmarksAllButton;
          row.remove();
          if (!list.querySelector(".panel-item")) readerContext.emptyPanel(list, "暂无书签");
          if (restoreFocus) next.focus({ preventScroll: true });
        });
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "panel-item-edit";
        edit.textContent = "编辑";
        edit.setAttribute("aria-label", `编辑书签：${open.textContent}`);
        edit.addEventListener("click", () => readerContext.openBookmarkPopover(edit, entry));
        row.append(open, edit, remove, excerpt, meta);
        list.appendChild(row);
      }
      if (!list.childElementCount) readerContext.emptyPanel(list, "暂无书签");
      readerContext.filterPanel(document.querySelector("#bookmarks-panel"));
    } catch (_) {
      if (readerContext.isReaderGenerationCurrent("bookmarks", generation)) readerContext.emptyPanel(list, "无法读取书签");
    }
  }

  function captureBookmarkSnapshot() {
    if (readerContext.mediaElement) {
      const time = Number.isFinite(readerContext.mediaElement.currentTime) ? readerContext.mediaElement.currentTime : 0;
      return {
        locator: `media:${Math.round(time * 10) / 10}`,
        label: `时间 ${readerContext.formatMediaTime(time)}`,
        excerpt: "",
        progress: readerContext.mediaElement.duration ? Math.round((time / readerContext.mediaElement.duration) * 1000) / 10 : 0,
        mediaTime: time,
        page: 0,
        pageOffset: 0,
        scrollTop: 0,
        htmlScrollTop: 0
      };
    }
    readerContext.syncCurrentPageFromMarker();
    const foliatePosition = readerContext.captureFoliateBookmarkPosition() || readerContext.captureChapterPosition();
    const shell = readerContext.documentState.pageCount ? readerContext.pageAtMarker() : null;
    const pageOffset = shell ? Math.max(0, readerContext.viewport.scrollTop - readerContext.readerPageScrollTop(shell)) : 0;
    const progress = readerContext.readerProgressPercent();
    const htmlScrollTop = readerContext.htmlFrame && readerContext.htmlFrame.contentWindow ? readerContext.htmlFrame.contentWindow.scrollY : 0;
    const scrollTop = readerContext.viewport.scrollTop;
    const pagedDocument = readerContext.documentState.pageCount && !["text", "markdown"].includes(readerContext.capability.mode);
    const locator = Number.isInteger(foliatePosition?.chapterIndex)
      ? `chapter:${foliatePosition.chapterIndex}:${Math.round(foliatePosition.chapterOffset)}`
      : foliatePosition
        ? `foliate:${foliatePosition.foliateSection}:${Math.round(foliatePosition.foliateOffset)}`
        : pagedDocument
          ? `page:${readerContext.documentState.page}:${Math.round(pageOffset)}`
          : `progress:${progress}:${Math.round(readerContext.htmlFrame ? htmlScrollTop : scrollTop)}`;
    return {
      locator,
      label: pagedDocument
        ? `第 ${readerContext.documentState.page} / ${readerContext.documentState.pageCount} 页`
        : `阅读进度 ${progress.toFixed(1)}%`,
      excerpt: readerContext.bookmarkExcerpt(),
      progress,
      page: pagedDocument ? readerContext.documentState.page : 0,
      pageOffset,
      scrollTop,
      htmlScrollTop,
      ...(foliatePosition || {})
    };
  }

  function setBookmarkDialogModal(open) {
    document.documentElement.classList.toggle("bookmark-dialog-open", open);
    if (open) {
      for (let node = readerContext.bookmarkPopover; node && node !== document.body; node = node.parentElement) {
        for (const sibling of node.parentElement.children)
          if (sibling !== node && !readerContext.bookmarkInertSiblings.has(sibling)) {
            readerContext.bookmarkInertSiblings.set(sibling, sibling.inert);
            sibling.inert = true;
          }
      }
    } else {
      for (const [node, inert] of readerContext.bookmarkInertSiblings) node.inert = inert;
      readerContext.bookmarkInertSiblings.clear();
    }
  }

  function openBookmarkPopover(invoker = readerContext.bookmarkRibbon, entry = null) {
    if (!readerContext.bookmarkPopover.hidden) return;
    readerContext.bookmarkInvoker = invoker;
    readerContext.pendingBookmarkSnapshot = entry ? null : readerContext.captureBookmarkSnapshot();
    readerContext.updatePanelState({ editingBookmark: entry ? { ...entry } : null });
    const snapshot = entry || readerContext.pendingBookmarkSnapshot;
    document.querySelector("#bookmark-prompt").textContent = entry
      ? `编辑书签 · ${entry.label}`
      : `在${snapshot.label}添加书签？`;
    readerContext.bookmarkLabelInput.value = snapshot.label || "";
    readerContext.bookmarkExcerptInput.value = snapshot.excerpt || "";
    document.querySelector("#bookmark-add").textContent = entry ? "保存书签" : "添加书签";
    readerContext.bookmarkPopover.hidden = false;
    invoker.setAttribute("aria-expanded", "true");
    invoker.setAttribute("aria-controls", readerContext.bookmarkPopover.id);
    readerContext.bookmarkLabelInput.focus();
    readerContext.setBookmarkDialogModal(true);
  }

  function closeBookmarkPopover() {
    readerContext.pendingBookmarkSnapshot = null;
    readerContext.updatePanelState({ editingBookmark: null });
    readerContext.bookmarkPopover.hidden = true;
    readerContext.setBookmarkDialogModal(false);
    readerContext.bookmarkInvoker?.setAttribute("aria-expanded", "false");
    (readerContext.bookmarkInvoker?.isConnected ? readerContext.bookmarkInvoker : readerContext.bookmarkRibbon).focus({ preventScroll: true });
    readerContext.bookmarkInvoker = null;
  }

  return {
    consumeBookmarkHandoff,
    excerptFromCaret,
    bookmarkExcerpt,
    captureFoliateBookmarkPosition,
    restoreFoliateBookmarkPosition,
    seekFoliateProgress,
    renderBookmarks,
    captureBookmarkSnapshot,
    setBookmarkDialogModal,
    openBookmarkPopover,
    closeBookmarkPopover
  };
}
