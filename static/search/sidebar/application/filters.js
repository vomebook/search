// Sidebar feature: owns its rendering lifecycle; the host supplies a bounded view and effects.
(function () {
  /** @param {VoiceOfMLFilterDependencies} deps */
  function create(deps) {
    let filterRenderToken = 0, filterRenderDone = 0;
/** @param {number} [routeId] */
async function renderFilters(routeId) {
  const token = ++filterRenderToken;
  var extensionPromise = renderExtensionFilter(routeId);
  if (deps.readView().mode === "global") {
    deps.elements.repoSection.style.display = "";
    await renderRepoFilter(routeId);
    // A suspended global render must not overwrite a newer folder view.
    if (token !== filterRenderToken || (routeId && routeId !== deps.readView().routeId) ||
        deps.readView().mode !== "global") return;
  } else {
    deps.elements.repoSection.style.display = "none";
  }
  if (deps.readView().mode === "repo") {
    var folderRepo = deps.readView().repo;
    var folderRepoFull = deps.readView().repoFull || "";
    deps.elements.folderSection.style.display = "";
    deps.tree.updateControls(true);
    deps.elements.folderTree.innerHTML = '<div style="font-size:12px;color:var(--on-surface-variant);opacity:0.6">加载中...</div>';
    var folderTree = deps.cache.get(folderRepoFull) || null;
    var initialFolderTree = null;
    if (!folderTree || !folderTree.length) {
      try {
        var initialSidebar = await deps.initial(folderRepo);
        if (initialSidebar && Array.isArray(initialSidebar.folders)) {
          initialFolderTree = initialSidebar.folders.map(function(folder) {
            return { name: folder.name, path: folder.path || folder.name, count: folder.count || 0, children: [], hasChildren: false, hasDirectFiles: true };
          });
        }
      } catch (e) {}
    }
    if (!folderTree || !folderTree.length) {
      if (deps.readView().apiAvailable) {
        try {
          const tree = await deps.fetchFolders(folderRepo, folderRepoFull);
          if (routeId && routeId !== deps.readView().routeId) return;
          if (deps.readView().mode !== "repo" || deps.readView().repo !== folderRepo || deps.readView().repoFull !== folderRepoFull) return;
          if (tree) {
            deps.cache.set(folderRepoFull, tree);
            folderTree = tree;
          }
        } catch (e) {}
      }
    }
    if ((!folderTree || !folderTree.length) && deps.readView().dataLoaded) {
      try {
        const localTree = await deps.localFolders(folderRepoFull);
        folderTree = localTree && localTree.tree || [];
        if (folderTree.length) deps.cache.set(folderRepoFull, folderTree);
      } catch (e) {}
    }
    if ((!folderTree || !folderTree.length) && initialFolderTree && initialFolderTree.length) {
      folderTree = initialFolderTree;
    }
    if (routeId && routeId !== deps.readView().routeId) return;
    if (deps.readView().mode !== "repo" || deps.readView().repo !== folderRepo || deps.readView().repoFull !== folderRepoFull) return;
    deps.publishTree(folderTree);
    if (deps.readView().tree && deps.readView().tree.length) deps.tree.initialize(deps.readView().tree);
    deps.tree.render();
  } else {
    deps.elements.folderSection.style.display = "none";
    deps.tree.updateControls(true);
  }
  await extensionPromise;
  if (routeId && routeId !== deps.readView().routeId) return;
  if (token === filterRenderToken) filterRenderDone = token;
}

/** @param {number} [routeId] */
function retainFilterRenderingForRoute(routeId) {
  deps.tree.retain(routeId ?? deps.readView().routeId);
  if (filterRenderDone !== filterRenderToken) renderFilters(routeId);
}

/** @param {number} [routeId] */
async function renderRepoFilter(routeId) {
  /** @type {VoiceOfMLFilterCount[] | null} */
  var repos = deps.readView().repos;
  if (!repos || repos.length === 0) {
    try {
      var initial = await deps.initial(null);
      if (initial && Array.isArray(initial.repos)) repos = initial.repos;
    } catch (e) {}
  }
  if (deps.readView().apiAvailable && (!repos || repos.length === 0)) {
    try {
      repos = await deps.fetchRepos();
    } catch (e) {}
  }
  if (routeId && routeId !== deps.readView().routeId) return;
  repos = Array.isArray(repos) ? repos : [];
  var ordered = repos.slice().sort(function(a, b) {
    return (a.count || 0) - (b.count || 0) ||
      String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
  var items = [];
  for (const repo of ordered) {
    items.push({
      key: repo.name,
      label: repo.name.split("/").pop() || "",
      count: repo.count,
    });
  }
  deps.lists.renderCheckboxList(deps.elements.repoList, items, deps.readView().selectedRepos, function(vals) {
    deps.selectRepos(vals);
  });
}

let extensionFilterRenderId = 0;

/** @param {number} [routeId] */
async function renderExtensionFilter(routeId) {
  var renderId = ++extensionFilterRenderId;
  var renderMode = deps.readView().mode;
  var renderRepo = deps.readView().repo;
  var renderRepoFull = deps.readView().repoFull;
  var extData = null;
  if (deps.hasExtensionCounts()) {
    var currentCounts = deps.extensionCounts(renderMode === "repo" ? renderRepoFull : null);
    var currentExtNames = Object.keys(currentCounts).sort();
    if (currentExtNames.length) {
      extData = [];
      for (const lext of currentExtNames) {
        extData.push({ name: lext, count: currentCounts[lext] || 0 });
      }
    }
  }
  if (extData === null && deps.readView().apiAvailable) {
    try {
      extData = await deps.fetchExtensions(renderRepo);
    } catch (e) {}
  }
  if (renderId !== extensionFilterRenderId) return;
  if (routeId && routeId !== deps.readView().routeId) return;
  if (deps.readView().mode !== renderMode || deps.readView().repo !== renderRepo || deps.readView().repoFull !== renderRepoFull) return;
  deps.publishExtensions(extData && Array.isArray(extData) ? extData.filter(item => item && typeof item.name === "string") : []);
  extData = extData && Array.isArray(extData) ? extData : [];
  var extMap = /** @type {Record<string, boolean>} */ ({});
  for (const item of extData) {
    if (item && item.name) extMap[item.name] = true;
  }
  for (var selIdx = 0; selIdx < deps.readView().selectedExtensions.length; selIdx++) {
    var selectedExt = deps.readView().selectedExtensions[selIdx];
    if (selectedExt && !extMap[selectedExt]) {
      extData.push({ name: selectedExt, count: 0 });
      extMap[selectedExt] = true;
    }
  }
  var ordered = [];
  var rest = [];
  if (extData.length > 0) {
  for (var n = 0; n < extData.length; n++) {
    var e = extData[n];
    if (!e || typeof e.name !== "string") continue;
    var idx_e = deps.orderedExtensions.indexOf(e.name);
    if (idx_e >= 0) {
        ordered.push({ name: e.name, _idx: idx_e, count: e.count || 0 });
    } else {
      rest.push(e);
    }
    }
  }
  ordered.sort(function(a, b) { return a._idx - b._idx || a.name.localeCompare(b.name); });
  var items = [];
  for (const item of ordered) {
    items.push({ key: item.name, label: "." + item.name, count: item.count });
  }
  deps.lists.renderExtensionTree(deps.elements.extList, items, rest, deps.readView().selectedExtensions, function(vals) {
    deps.selectExtensions(vals);
  });
}


    return { render: renderFilters, renderExtensions: renderExtensionFilter, renderRepos: renderRepoFilter, retain: retainFilterRenderingForRoute, status: () => ({token: filterRenderToken, done: filterRenderDone}) };
  }
  globalThis.VoiceOfMLSidebarFilters = { create };
})();
