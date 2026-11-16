// Directory browsing: explicit view and effect ports, owned lifecycle.
(function () {
  /** @param {VoiceOfMLSidebarDirectoryDependencies} deps */
  function create(deps) {
const sidebarRetryCounts = new Map();
/** @param {number} [routeId] */
function renderSidebar(routeId) {
  if (deps.readView().mode === "global") {
    renderRepoList(routeId);
  } else {
    renderBrowser(deps.readView().browserPath || "", routeId);
  }
}

/** @param {number} [routeId] */
async function renderRepoList(routeId) {
  var repos = null;
  if (deps.readView().repos && deps.readView().repos.length > 0) {
    repos = deps.readView().repos;
  } else {
    var initial = await deps.initial(null);
    if (initial && Array.isArray(initial.repos) && initial.repos.length) {
      if (routeId && routeId !== deps.readView().routeId) return;
      deps.renderRepos(initial.repos);
      repos = initial.repos;
    }
    if (deps.readView().apiAvailable) {
      var freshRepos = await deps.fetchRepos();
      if (freshRepos && Array.isArray(freshRepos) && freshRepos.length) repos = freshRepos;
    }
  }
  if (routeId && routeId !== deps.readView().routeId) return;
  if (!repos || !Array.isArray(repos) || repos.length === 0) {
    deps.scroll.activate("global");
    deps.view.message('<div class="sidebar-loading">暂无仓库</div>');
    deps.scroll.restore();
    deps.updateHeader();
    return;
  }
  deps.renderRepos(repos);
}

/** @param {string} path @param {number} [routeId] */
async function renderBrowser(path, routeId) {
  if (routeId && routeId !== deps.readView().routeId) return;
  deps.scroll.activate(deps.scroll.keyFor(deps.readView().repoFull || deps.readView().repo, path));
  const {list, currentRepo} = deps.view.begin(path, () => deps.readView().repoFull || "");
  var data = null;
  var initialData = null;
  /** @type {VoiceOfMLSidebarEntries | null} */
  var displayedData = null;
  deps.refreshAssets(list, currentRepo, path, routeId, () => displayedData);
  if (deps.readView().useLocalMode && deps.readView().dataLoaded) {
    try {
      data = await deps.localContents(currentRepo, path);
      if (routeId && routeId !== deps.readView().routeId) return;
      if (deps.readView().mode !== "repo" || deps.readView().repoFull !== currentRepo || deps.readView().browserPath !== path) return;
    } catch (e) {}
  }
  if (!path) {
    var initial = data ? null : await deps.initial(deps.readView().repo);
    if (initial && (!routeId || routeId === deps.readView().routeId) && deps.readView().mode === "repo" && deps.readView().repo === currentRepo.split("/").pop() && deps.readView().browserPath === path) {
      deps.view.items(list, initial, currentRepo, path);
      displayedData = initial;
      initialData = initial;
      data = initial;
    }
  }
  if (!data && deps.cache.has(deps.readView().repoFull + "|" + (path || ""))) {
    data = deps.cache.get(deps.readView().repoFull + "|" + (path || ""));
  }
  if (!data && path && deps.readView().useLocalMode && !deps.readView().dataLoaded) {
    const local = deps.ensureLocal(false, true)
      .then(ok => ok ? deps.localContents(currentRepo, path) : null).catch(() => null);
    const remote = deps.readView().apiAvailable ? deps.fetchContents(deps.readView().repo, path) : Promise.resolve(null);
    const first = await Promise.race([
      local.then(result => ({ source: "local", result })),
      remote.then(result => ({ source: "api", result }))
    ]);
    data = first.result || await (first.source === "local" ? remote : local);
    if (routeId && routeId !== deps.readView().routeId) return;
    if (deps.readView().mode !== "repo" || deps.readView().repoFull !== currentRepo || deps.readView().browserPath !== path) return;
  }
  if (!data && deps.readView().apiAvailable) {
    try {
      var repo = deps.readView().repo;
      var freshData = await deps.fetchContents(repo, path);
      if (routeId && routeId !== deps.readView().routeId) return;
      if (deps.readView().mode !== "repo" || deps.readView().repo !== repo || deps.readView().browserPath !== path) return;
      if (freshData) data = freshData;
    } catch (e) {}
  }
  if (!data && deps.readView().dataLoaded) {
    try {
      data = await deps.localContents(deps.readView().repoFull, path);
      if (routeId && routeId !== deps.readView().routeId) return;
      if (deps.readView().mode !== "repo" || deps.readView().repoFull !== currentRepo || deps.readView().browserPath !== path) return;
    } catch (e) {}
  }
  if (!data || (!data.folders && !data.files)) {
    if (initialData) return;
    if ((!routeId || routeId === deps.readView().routeId) && deps.readView().mode === "repo" && deps.readView().browserPath === path) {
      var retryKey = deps.readView().repo + "|" + (path || "");
      var tries = sidebarRetryCounts.get(retryKey) || 0;
      if (tries < 2) {
        sidebarRetryCounts.set(retryKey, tries + 1);
        list.innerHTML = '<div class="sidebar-loading">加载失败，正在重试...</div>';
        setTimeout(function() {
          if ((!routeId || routeId === deps.readView().routeId) && deps.readView().mode === "repo" && deps.readView().browserPath === path) renderBrowser(path, routeId || deps.readView().routeId);
        }, 1200);
      } else {
        list.innerHTML = '<div class="sidebar-loading">加载失败</div>';
      }
    }
    return;
  }
  sidebarRetryCounts.delete(deps.readView().repo + "|" + (path || ""));
  deps.view.items(list, data, currentRepo, path);
  displayedData = data;
}
    return { render: renderSidebar, repos: renderRepoList, browse: renderBrowser, resetRetries: () => sidebarRetryCounts.clear() };
  }
  /** @type {typeof globalThis & {VoiceOfMLSidebarDirectory: typeof VoiceOfMLSidebarDirectory}} */
  const globals = globalThis;
  globals.VoiceOfMLSidebarDirectory = {create};
})();
