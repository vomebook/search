/// <reference path="../../../typings/reader-search-backends-strict.d.ts" />

/** @param {{name?: string, message?: string, code?: string} | null} failure */
function pdfSearchUnavailable(failure) {
  const message = failure?.message || "";
  return failure?.name === "TimeoutError" || failure?.code === "READER_BODY_INTERRUPTED" ||
    /^(?:HTTP (?:40[348]|410|429|5\d\d)\b|本书集中全文尚未生成$|PDF 全文搜索组件加载失败|全文搜索已取消或加载超时)/.test(message) ||
    /^(?:Failed to fetch|error loading dynamically imported module|importing a module script failed|NetworkError|Load failed)/i.test(message);
}

/** @param {ReaderSearchBackends.Context} readerContext */
export function createReaderSearchBackends(readerContext) {
  /** @param {ReaderSearchBackends.SearchPatch} patch */
  function updateSearchState(patch) {
    return readerContext.readerRuntime.update("search", patch);
  }

  /** @param {number} generation @param {ReaderSearchBackends.Result[]} results */
  function publishSearchResults(generation, results) {
    return readerContext.isReaderGenerationCurrent("search", generation) && readerContext.updateSearchState({ results });
  }

  /** @param {HTMLElement} view */
  function clearSearchHighlights(view) {
    for (const mark of view.querySelectorAll("mark.search-match")) mark.replaceWith(/** @type {string} */ (mark.textContent));
    view.normalize();
  }

  function chapterSearchModule() {
    if (!readerContext.chapterSearchModulePromise)
      readerContext.chapterSearchModulePromise = import("/search/static/reader/search/reader-chapter-search.mjs").catch(
        (error) => {
          readerContext.chapterSearchModulePromise = null;
          // An older Reader document may outlive its lazy module URL. Do not
          // substitute a different build's module into this document.
          const message = error instanceof Error ? error.message : String(error);
          if (/failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(message))
            throw new Error("全文搜索组件不可用。联网后请刷新阅读页，恢复阅读进度后重试。", { cause: error });
          throw error;
        }
      );
    return readerContext.chapterSearchModulePromise;
  }

  /** @param {string} query @param {number} generation */
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

  /** @param {ReaderSearchBackends.ChapterResult} result @param {number} generation */
  async function navigateChapterSearchResult(result, generation) {
    const article = await readerContext.chapterManifestLoader?.(result.chapterIndex);
    if (!article || !readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    const module = await readerContext.chapterSearchModule();
    if (!readerContext.isReaderGenerationCurrent("navigation", generation)) return false;
    readerContext.clearFullSearchMarks();
    const textProfile = readerContext.chapterSearchConfiguration?.index.text_profile;
    const mapping = module.chapterTextMap([article._chapterSearchHead ?? null, article], textProfile);
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
    const headText = module.chapterTextMap([article._chapterSearchHead ?? null], textProfile).text;
    if (start < headText.length) {
      const heading = document.createElement("p");
      heading.className = "reader-chapter-search-heading";
      heading.textContent = headText;
      article.prepend(heading);
      parts.unshift({ node: /** @type {Text} */ (heading.firstChild), start, end: Math.min(start + result.length, headText.length) });
    }
    const [mark] = readerContext.highlightTextParts(parts);
    readerContext.chapterScrollAnchors.invalidate();
    (mark || article).scrollIntoView({ block: "center" });
    readerContext.chapterScrollAnchors.remember();
    const tocIndex = readerContext.navigationState.tocEntries.findIndex(
      (entry) => typeof entry === "object" && entry !== null && "chapterIndex" in entry && entry.chapterIndex === result.chapterIndex
    );
    if (tocIndex >= 0) {
      readerContext.updateNavigationState({ currentChapterIndex: tocIndex });
      readerContext.updateTocCurrentMark();
    }
    readerContext.updateProgressTools();
    readerContext.scheduleSave();
    return true;
  }

  /** @param {string} query @param {number} generation */
  async function searchReaderText(query, generation) {
    if (readerContext.capability.mode === "pdf" || readerContext.capability.mode === "pdf-pages") {
      if (readerContext.capability.mode === "pdf" && !readerContext.ocrManifestUrl) {
        await readerContext.fullSearchPdfMatches(query, generation);
        return;
      }
      // Keep the OCR query contract outside the fallback so invalid input is
      // never reinterpreted as a failure of the external index.
      if (!query || query.length > 2048) throw new Error("请输入 1–2048 个字符");
      const pdf = readerContext.capability.mode === "pdf" ? readerContext.pdfDocument : null;
      let results;
      try {
        results = await readerContext.searchConcentratedPdf(query, generation);
      } catch (error) {
        if (!readerContext.isReaderGenerationCurrent("search", generation)) return;
        const failure = /** @type {{name?: string, message?: string, code?: string} | null} */ (error);
        if (failure?.name === "AbortError") throw error;
        readerContext.fullSearchController.resetBackendResults();
        // Only availability failures switch backends. Surface invalid manifests,
        // hashes, or shapes rather than silently treating them as unavailable.
        if (!pdfSearchUnavailable(failure) || !pdf || pdf !== readerContext.pdfDocument || pdf._pdfInfo?.readerPageCountPending) throw error;
        try {
          await readerContext.fullSearchPdfMatches(query, generation);
        } catch (nativeError) {
          // Without confirmed native text, keep the actionable OCR error and
          // let the user retry. Do not mark an OCR book as unsearchable.
          if (/** @type {{code?: string} | null} */ (nativeError)?.code === "READER_TEXT_UNCONFIRMED") throw error;
          throw nativeError;
        }
        return;
      }
      readerContext.publishSearchResults(generation, results);
    }
    else if (readerContext.capability.mode === "epub-chapters") await readerContext.searchChapterBook(query, generation);
    else if (readerContext.capability.mode === "text" || readerContext.capability.mode === "markdown")
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
    searchReaderText
  };
}
