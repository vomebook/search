// Initial payloads describe the actual first page of the unfiltered default view.
(function () {
  /** @param {SearchBootstrapView} view */
  function eligible(view) {
    return (view.page || 1) === 1 && !view.query && view.sort === "relevance"
      && view.searchFolders && view.exact
      && view.repoFilters === 0 && view.extensionFilters === 0
      && view.folderSelfFilters === 0 && view.folderSubtreeFilters === 0
      && view.minSize === null && view.maxSize === null;
  }
  /** @param {SearchBootstrapView} view @param {string} base */
  function url(view, base) {
    if (view.mode === "repo" && view.repo) return base + "/repos/" + encodeURIComponent(view.repo) + ".json";
    return base + "/global.json";
  }
  /** @param {SearchInitialPayload | null} data @param {SearchBootstrapView} view */
  function accepts(data, view) {
    const total = data?.total;
    return !!data && Array.isArray(data.results) && data.page === 1 && data.page_size === view.pageSize
      && typeof total === "number" && Number.isSafeInteger(total) && total >= 0
      && data.results.length === Math.min(total, view.pageSize)
      && (view.mode !== "repo" || data.repo === view.repoFull)
      && (view.mode !== "global" || data.mode === "global");
  }
  globalThis.VoiceOfMLInitialPayload = { eligible, url, accepts };
})();
