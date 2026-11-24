// Directory browsing: explicit view and effect ports, owned lifecycle.
(function () {
  /** @param {VoiceOfMLSidebarDirectoryDependencies} deps */
  function create(deps) {
/** @type {Map<string, number>} */
const sidebarRetryCounts = new Map();

/** @param {number | undefined} routeId @param {number} activeRouteId */
function matchesRoute(routeId, activeRouteId) {
  return !routeId || routeId === activeRouteId;
}

/** @param {string} path @param {number | undefined} routeId */
function readBrowserRoute(path, routeId) {
  const view = deps.readView();
  return matchesRoute(routeId, view.routeId) && view.mode === "repo" && view.browserPath === path ? view : null;
}

/** @param {string | null} repo @param {string} path */
function browserKey(repo, path) {
  return repo + "|" + (path || "");
}

/** @param {number} [routeId] */
function renderSidebar(routeId) {
  const view = deps.readView();
  if (view.mode === "global") {
    renderRepoList(routeId);
  } else {
    renderBrowser(view.browserPath || "", routeId);
  }
}

/** @param {number} [routeId] */
async function renderRepoList(routeId) {
  let {repos} = deps.readView();
  if (!repos?.length) {
    const initial = await deps.initial(null);
    if (initial && Array.isArray(initial.repos) && initial.repos.length) {
      if (!matchesRoute(routeId, deps.readView().routeId)) return;
      deps.renderRepos(initial.repos);
      repos = initial.repos;
    }
    if (deps.readView().apiAvailable) {
      const freshRepos = await deps.fetchRepos();
      if (Array.isArray(freshRepos) && freshRepos.length) repos = freshRepos;
    }
  }
  if (!matchesRoute(routeId, deps.readView().routeId)) return;
  if (!Array.isArray(repos) || repos.length === 0) {
    deps.scroll.activate("global");
    deps.view.message('<div class="sidebar-loading">暂无仓库</div>');
    deps.scroll.restore();
    deps.updateHeader();
    return;
  }
  deps.renderRepos(repos);
}

/** @param {HTMLElement} list @param {string} path @param {number | undefined} routeId */
function retryBrowser(list, path, routeId) {
  const view = readBrowserRoute(path, routeId);
  if (!view) return;
  const key = browserKey(view.repo, path);
  const tries = sidebarRetryCounts.get(key) || 0;
  if (tries >= 2) {
    list.innerHTML = '<div class="sidebar-loading">加载失败</div>';
    return;
  }
  sidebarRetryCounts.set(key, tries + 1);
  list.innerHTML = '<div class="sidebar-loading">加载失败，正在重试...</div>';
  setTimeout(() => {
    const active = readBrowserRoute(path, routeId);
    if (active) renderBrowser(path, routeId || active.routeId);
  }, 1200);
}

/** @param {string} path @param {number} [routeId] */
async function renderBrowser(path, routeId) {
  const view = deps.readView();
  if (!matchesRoute(routeId, view.routeId)) return;
  deps.scroll.activate(deps.scroll.keyFor(view.repoFull || view.repo, path));
  const {list, currentRepo} = deps.view.begin(path, () => deps.readView().repoFull || "");
  const isCurrentLocal = () => readBrowserRoute(path, routeId)?.repoFull === currentRepo;
  let data;
  /** @type {VoiceOfMLSidebarEntries | null} */
  let displayedData = null;
  deps.refreshAssets(list, currentRepo, path, routeId, () => displayedData);
  const {useLocalMode, dataLoaded} = deps.readView();
  if (useLocalMode && dataLoaded) {
    try {
      data = await deps.localContents(currentRepo, path);
      if (!isCurrentLocal()) return;
    } catch (e) {}
  }
  if (!data && !path) {
    const initial = await deps.initial(deps.readView().repo);
    if (initial && readBrowserRoute(path, routeId)?.repo === currentRepo.split("/").pop()) {
      deps.view.items(list, initial, currentRepo, path);
      data = displayedData = initial;
    }
  }
  if (!data) {
    // The local cache can fill while the initial listing is pending.
    const active = deps.readView();
    data = deps.cache.get(browserKey(active.repoFull, path));
    if (!data && path && active.useLocalMode && !active.dataLoaded) {
      const local = deps.ensureLocal(false, true)
        .then(ok => ok ? deps.localContents(currentRepo, path) : null).catch(() => null);
      const {apiAvailable, repo} = deps.readView();
      const remote = apiAvailable ? deps.fetchContents(repo, path) : Promise.resolve(null);
      const first = await Promise.race([
        local.then(result => ({ result, fallback: remote })),
        remote.then(result => ({ result, fallback: local }))
      ]);
      data = first.result || await first.fallback;
      if (!isCurrentLocal()) return;
    }
  }
  if (!data) {
    const {apiAvailable, repo} = deps.readView();
    if (apiAvailable) {
      try {
        data = await deps.fetchContents(repo, path);
        if (readBrowserRoute(path, routeId)?.repo !== repo) return;
      } catch (e) {}
    }
  }
  if (!data) {
    const {dataLoaded, repoFull} = deps.readView();
    if (dataLoaded) {
      try {
        data = await deps.localContents(repoFull, path);
        if (!isCurrentLocal()) return;
      } catch (e) {}
    }
  }
  if (!data || (!data.folders && !data.files)) {
    if (!displayedData) retryBrowser(list, path, routeId);
    return;
  }
  sidebarRetryCounts.delete(browserKey(deps.readView().repo, path));
  // The accepted initial root listing was already mounted above.
  if (data !== displayedData) {
    deps.view.items(list, data, currentRepo, path);
    displayedData = data;
  }
}
    return { render: renderSidebar, repos: renderRepoList, browse: renderBrowser, resetRetries: () => sidebarRetryCounts.clear() };
  }
  /** @type {typeof globalThis & {VoiceOfMLSidebarDirectory: typeof VoiceOfMLSidebarDirectory}} */
  const globals = globalThis;
  globals.VoiceOfMLSidebarDirectory = {create};
})();
