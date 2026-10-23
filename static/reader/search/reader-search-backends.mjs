export function createReaderSearchBackends(readerContext) {
  function updateSearchState(patch) {
    return readerContext.readerRuntime.update("search", patch);
  }

  function publishSearchResults(generation, results) {
    return readerContext.isReaderGenerationCurrent("search", generation) && readerContext.updateSearchState({ results });
  }

  function clearSearchHighlights(view) {
    for (const mark of view.querySelectorAll("mark.search-match")) mark.replaceWith(mark.textContent);
    view.normalize();
  }

  function chapterSearchModule() {
    if (!readerContext.chapterSearchModulePromise)
      readerContext.chapterSearchModulePromise = import("/search/static/reader/search/reader-chapter-search.mjs").catch(
        (error) => {
          readerContext.chapterSearchModulePromise = null;
          throw error;
        }
      );
    return readerContext.chapterSearchModulePromise;
  }

  async function searchChapterBook(query, generation) {
    if (!readerContext.chapterSearchConfiguration) throw new Error("本书暂无完整全文搜索索引");
    const module = await readerContext.chapterSearchModule();
    if (!readerContext.isReaderGenerationCurrent("search", generation)) return;
    if (readerContext.chapterSearchClient?.failed) {
      readerContext.chapterSearchClient.dispose();
      readerContext.chapterSearchClient = null;
    }
    if (!readerContext.chapterSearchClient)
      readerContext.chapterSearchClient = module.createChapterSearch(readerContext.chapterSearchConfiguration);
    const page = await readerContext.chapterSearchClient.search(query, partial => {
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return;
      readerContext.applyChapterSearchPage(partial);
      readerContext.renderFullSearchResults();
      readerContext.fullSearchStatus.textContent = partial.total
        ? `${partial.total} 个结果（正在搜索… ${partial.scanned} / ${partial.chapters} 章）`
        : `正在搜索正文… ${partial.scanned} / ${partial.chapters} 章`;
    });
    if (readerContext.isReaderGenerationCurrent("search", generation)) readerContext.applyChapterSearchPage(page);
  }

  async function navigateChapterSearchResult(result, generation) {
    const article = await readerContext.chapterManifestLoader?.(result.chapterIndex);
    if (!article || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const module = await readerContext.chapterSearchModule();
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    readerContext.clearFullSearchMarks();
    const textProfile = readerContext.chapterSearchConfiguration?.index.text_profile;
    const mapping = module.chapterTextMap([article._chapterSearchHead, article], textProfile);
    const match = result.snippet.text.slice(
      result.snippet.matchStart,
      result.snippet.matchStart + result.snippet.matchLength
    );
    let start = result.start;
    if (mapping.text.slice(start, start + result.length) !== match) {
      // A browser may repair malformed source HTML differently from HTMLParser.
      // Relocate only by a unique full excerpt; never guess between repeated hits.
      const found = mapping.text.indexOf(result.snippet.text);
      if (found < 0 || mapping.text.indexOf(result.snippet.text, found + 1) >= 0)
        throw new Error("已加载章节，但未能准确定位这处文字");
      start = found + result.snippet.matchStart;
    }
    const parts = mapping.parts(start, start + result.length, article);
    const headText = module.chapterTextMap([article._chapterSearchHead], textProfile).text;
    if (start < headText.length) {
      const heading = document.createElement("p");
      heading.className = "reader-chapter-search-heading";
      heading.textContent = headText;
      article.prepend(heading);
      parts.unshift({ node: heading.firstChild, start, end: Math.min(start + result.length, headText.length) });
    }
    const [mark] = readerContext.highlightTextParts(parts);
    readerContext.foliateScrollAnchors.invalidate();
    (mark || article).scrollIntoView({ block: "center" });
    readerContext.foliateScrollAnchors.remember();
    const tocIndex = readerContext.navigationState.tocEntries.findIndex(
      (entry) => entry.chapterIndex === result.chapterIndex
    );
    if (tocIndex >= 0) {
      readerContext.updateNavigationState({ currentChapterIndex: tocIndex });
      readerContext.updateTocCurrentMark();
    }
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    return true;
  }

  async function fullSearchFoliateMatches(query, generation) {
    if (!readerContext.epubRendition?.search) return [];
    const groups = [], firstPage = [];
    // Cache only visited pages for this query; never retain every match in the book.
    const cachedPages = new Map();
    let total = 0;
    const toResult = (item, label, occurrence) => {
      const excerpt = item.excerpt || { pre: "", match: query, post: "" };
      return {
        location: label || "电子书位置",
        cfi: item.cfi,
        occurrence,
        snippet: {
          text: `${excerpt.pre}${excerpt.match}${excerpt.post}`,
          matchStart: excerpt.pre.length,
          matchLength: excerpt.match.length,
          prefix: "",
          suffix: ""
        }
      };
    };
    readerContext.fullSearchSession.pageLoader = async (requestedOffset, pageGeneration = readerContext.readerRuntime.currentGeneration("search")) => {
      const pageSize = 50;
      const offset = readerContext.fullSearchPageOffset(total, requestedOffset, pageSize);
      if (!offset) return { total, offset, pageSize, results: firstPage.slice() };
      const cached = cachedPages.get(offset);
      if (cached) {
        cachedPages.delete(offset);
        cachedPages.set(offset, cached);
        return cached;
      }
      const results = [];
      let passed = 0;
      for (const group of groups) {
        if (passed + group.count <= offset) { passed += group.count; continue; }
        const sectionOffset = Math.max(0, offset - passed);
        const limit = Math.min(pageSize - results.length, group.count - sectionOffset);
        for await (const batch of readerContext.epubRendition.search({
          query, index: group.index, offset: sectionOffset, limit, lean: true,
          current: () => readerContext.isReaderGenerationCurrent("search", pageGeneration)
        }))
          for (const [index, item] of batch.subitems.entries())
            results.push(toResult(item, group.label, sectionOffset + index));
        passed += group.count;
        if (results.length === pageSize) break;
      }
      const page = { total, offset, pageSize, results };
      if (readerContext.isReaderGenerationCurrent("search", pageGeneration) && JSON.stringify(page).length <= 128 * 1024) {
        cachedPages.set(offset, page);
        if (cachedPages.size > 4) cachedPages.delete(cachedPages.keys().next().value);
      }
      return page;
    };
    for await (const group of readerContext.epubRendition.search({
      query, lean: true, limit: 50,
      current: () => readerContext.isReaderGenerationCurrent("search", generation)
    })) {
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
      if (group.count) groups.push({ index: group.index, count: group.count, label: group.label });
      for (const [index, item] of group.subitems.entries()) {
        if (firstPage.length === 50) break;
        firstPage.push(toResult(item, group.label, index));
      }
      total += group.count;
      readerContext.fullSearchSession.page = { total, offset: 0, pageSize: 50, results: firstPage.slice() };
      readerContext.updateSearchState({ results: readerContext.fullSearchSession.page.results, index: -1 });
      readerContext.renderFullSearchResults();
      readerContext.fullSearchStatus.textContent = `${total} 个结果（正在搜索…）`;
      await readerContext.waitForReader();
      if (!readerContext.isReaderGenerationCurrent("search", generation)) return [];
    }
    readerContext.fullSearchSession.page = { total, offset: 0, pageSize: 50, results: firstPage.slice() };
    return firstPage;
  }

  async function navigateFoliateSearchResult(result, generation) {
    const resolved = await readerContext.epubRendition?.resolveNavigation?.(result.cfi);
    if (!resolved || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const section = readerContext.epubBook?.sections?.[resolved.index],
      sections = readerContext.epubBook?.sections?.filter((item) => item.linear !== "no") || [],
      visibleIndex = section ? sections.indexOf(section) : -1;
    if (visibleIndex < 0 || !readerContext.foliateSectionLoader) return false;
    let node = await readerContext.foliateSectionLoader(visibleIndex);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    await readerContext.waitForReader(0, true);
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    if (!node?.isConnected) node = await readerContext.foliateSectionLoader(visibleIndex);
    if (!node?.isConnected || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    readerContext.clearFullSearchMarks();
    let target;
    if (typeof resolved.anchor === "function" && node._resolveSearchAnchor) {
      const parts = node._resolveSearchAnchor(resolved.anchor);
      if (!parts?.length) return false;
      [target] = readerContext.highlightTextParts(parts);
    } else {
      // Some non-CFI engines expose only a section locator.
      const matches = await readerContext.fullSearchDomMatches(
        readerContext.foliateSectionRoot(node),
        "电子书位置",
        readerContext.searchState.query,
        readerContext.readerRuntime.currentGeneration("search"),
        false,
        result.occurrence || 0,
        generation
      );
      target = matches[0]?.target;
    }
    if (!readerContext.isReaderGenerationCurrent("navigation", generation) || !target) return false;
    const targetRect = target.getBoundingClientRect(),
      viewportRect = readerContext.viewport.getBoundingClientRect();
    readerContext.foliateScrollAnchors.invalidate();
    readerContext.viewport.scrollTop = Math.max(
      0,
      readerContext.viewport.scrollTop +
        targetRect.top -
        viewportRect.top -
        (readerContext.viewport.clientHeight - targetRect.height) / 2
    );
    const tocIndex = readerContext.navigationState.tocEntries.findIndex(
      (entry) => entry.sectionIndex === visibleIndex
    );
    if (tocIndex >= 0) {
      readerContext.updateNavigationState({ currentChapterIndex: tocIndex });
      readerContext.updateTocCurrentMark();
    }
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    readerContext.foliateScrollAnchors.remember();
    return true;
  }

  async function searchReaderText(query, generation) {
    if ((readerContext.capability.mode === "pdf" || readerContext.pdfHybridUrl) && !readerContext.ocrManifestUrl) {
      if (readerContext.pdfHybridUrl) {
        try {
          await readerContext.pdfHybridDocumentPromise;
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          throw new Error("此 PDF 尚无可搜索文字层，需要完成 OCR 后才能搜索正文");
        }
      }
      await readerContext.fullSearchPdfMatches(query, generation);
    }
    else if (["pdf", "pdf-pages"].includes(readerContext.capability.mode)) {
      readerContext.publishSearchResults(generation, await readerContext.searchConcentratedPdf(query, generation));
    }
    else if (readerContext.capability.mode === "foliate")
      readerContext.publishSearchResults(generation, await readerContext.fullSearchFoliateMatches(query, generation));
    else if (readerContext.capability.mode === "epub-chapters") await readerContext.searchChapterBook(query, generation);
    else if (["text", "markdown"].includes(readerContext.capability.mode))
      readerContext.publishSearchResults(
        generation,
        await readerContext.fullSearchDomMatches(readerContext.content, "阅读位置", query, generation, true)
      );
    else if (readerContext.capability.mode === "html")
      readerContext.publishSearchResults(
        generation,
        readerContext.htmlFrame?.contentDocument?.body
          ? await readerContext.fullSearchDomMatches(
              readerContext.htmlFrame.contentDocument.body,
              "HTML 阅读位置",
              query,
              generation,
              true
            )
          : []
      );
    else throw new Error("此格式没有可搜索文本");
  }

  return {
    updateSearchState,
    publishSearchResults,
    clearSearchHighlights,
    chapterSearchModule,
    searchChapterBook,
    navigateChapterSearchResult,
    fullSearchFoliateMatches,
    navigateFoliateSearchResult,
    searchReaderText
  };
}
