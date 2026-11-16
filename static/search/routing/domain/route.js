// Pages hash routes: scalar parameters use the last occurrence; lists retain order.
(function () {
  /** @param {string} hash */
  function parse(hash) {
    hash = hash.replace(/^#/, "");
    const qIdx = hash.indexOf("?");
    const path = qIdx >= 0 ? hash.substring(0, qIdx) : hash;
    const queryString = qIdx >= 0 ? hash.substring(qIdx + 1) : "";
    const parts = path.split("/").filter(Boolean);
    /** @type {VoiceOfMLRouteParams} */
    const params = {};
    new URLSearchParams(queryString).forEach((value, key) => {
      if (["repo", "folder_self", "folder_subtree", "folder"].includes(key)) {
        if (!params[key]) params[key] = [];
        /** @type {string[]} */ (params[key]).push(value);
      } else params[key] = value;
    });
    return { mode: parts.length === 0 ? "global" : "repo", repo: parts[0] || null, params };
  }

  /** @param {VoiceOfMLRouteState} state @param {(value: number) => string | null} formatSize @param {VoiceOfMLRouteOptions} [options] */
  function buildParams(state, formatSize, { includeQuery = true, displaySizes = false } = {}) {
    const sp = new URLSearchParams();
    if (includeQuery && state.query) sp.set("q", state.query);
    if (state.filterExtensions.length > 0) sp.set("ext", state.filterExtensions.join(","));
    if (state.sort !== "relevance") sp.set("sort", state.sort);
    const sizeValue = displaySizes ? formatSize : String;
    if (state.filterMinSize !== null) sp.set("min_size", String(sizeValue(state.filterMinSize)));
    if (state.filterMaxSize !== null) sp.set("max_size", String(sizeValue(state.filterMaxSize)));
    if (!state.searchFolders) sp.set("search_folders", "false");
    if (!state.exact) sp.set("exact", "0");
    if (!state.useLocalMode) sp.set("local", "0");
    if (!state.recordHistory) sp.set("history", "0");
    if (!state.useMirrorLinks) sp.set("mirror", "0");
    if (!state.leftSidebarOpen) sp.set("sidebar", "0");
    if (state.rightSidebarOpen) sp.set("filters", "1");
    if (state.wide) sp.set("wide", "1");
    return sp;
  }

  /** @param {string} mode @param {string | null | undefined} repo @param {URLSearchParams} params */
  function url(mode, repo, params) {
    const path = mode === "global" ? "#/" : "#/" + repo;
    const query = params.toString();
    return query ? path + "?" + query : path;
  }

  /** @param {VoiceOfMLRouteParams} params @param {string} mode @param {boolean} initialized */
  function project(params, mode, initialized) {
    const query = /** @type {string} */ (params.q ?? "");
    /** @param {string} key @returns {string[]} */
    const list = key => {
      const value = params[key];
      return value === undefined ? [] : (Array.isArray(value) ? value : [value]);
    };
    const selfs = mode === "global" ? [] : list("folder_self").filter(path => typeof path === "string");
    const subtrees = mode === "global" ? [] : list("folder_subtree").filter(path => typeof path === "string");
    const ext = /** @type {string | undefined} */ (params.ext);
    return {
      query: Array.from(query).slice(0, 256).join(""), queryTruncated: Array.from(query).length > 256,
      filterRepos: list("repo").map(repo => repo.includes("/") ? repo : "VoiceOfML/" + repo),
      filterExtensions: ext === undefined && !initialized ? null : (ext ? ext.split(",").filter(Boolean) : []),
      browserPath: /** @type {string} */ (params.path || ""),
      filterFolderSelfs: selfs, filterFolderSubtrees: subtrees,
      sort: params.sort === "name" || params.sort === "size" ? params.sort : "relevance",
      searchFolders: params.search_folders !== "false", exact: params.exact !== "0",
      useLocalMode: params.local !== "0", recordHistory: params.history !== "0", useMirrorLinks: params.mirror !== "0",
      leftSidebarOpen: params.sidebar !== "0", rightSidebarOpen: params.filters === "1", wide: params.wide === "1",
    };
  }
  globalThis.VoiceOfMLRoute = { parse, buildParams, url, project };
})();
